import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { verifySignature } from "@codemem/core";
import {
	RELAY_LOGICAL_ORIGIN,
	type RelayGroupResolution,
	relayCoordinatorEndpoint,
} from "@codemem/core/internal/relay-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { relayRealmPath } from "../../core/src/relay-client-config.js";
import {
	relayClientFixture,
	relayDeadline,
} from "../../core/src/relay-peer-client-test-fixtures.js";
import { testSigner } from "../../core/src/relay-server-test-fixtures.js";
import { relayAudienceId } from "../../core/src/relay-service-proof.js";
import { runSyncPass } from "../../core/src/sync-pass.js";
import { createViewerRelayReachability } from "./relay-reachability.js";
import {
	COORDINATOR,
	closedLoopbackUrl,
	identity,
	relayConfig,
	resolver,
} from "./relay-reachability-test-fixtures.js";
import { SCOPE } from "./sync-channel-dispatch-test-fixtures.js";
import { passFixture } from "./sync-channel-pass-test-fixtures.js";

const GROUP = "team-a";
const config = {
	sync_coordinator_url: COORDINATOR,
	sync_coordinator_groups: [GROUP],
	sync_relay_enabled: true,
};

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/**
 * The viewer's own reachability is the relay target, built with keysDir
 * omitted so it must take the key directory from CODEMEM_KEYS_DIR. A fixture
 * client on the other device is the source.
 */
async function targetDevice() {
	const f = await passFixture();
	cleanups.push(() => f.cleanup());
	const serverKeys = join(dirname(f.remote.peerKeysDir), "local-keys");
	vi.stubEnv("CODEMEM_KEYS_DIR", serverKeys);
	const relay = await relayClientFixture(
		{
			source: identity(f.remote.peerKeysDir, f.remote.peerPublicKey),
			target: identity(serverKeys, f.remote.localPublicKey),
		},
		{ source: f.remote.peerDeviceId, target: f.remote.localDeviceId },
		{ groupId: GROUP },
	);
	cleanups.push(() => relay.dispose());
	// Tests switch the coordinator's answer through this override.
	const control: { next?: RelayGroupResolution } = {};
	const pinned = resolver({ [GROUP]: relay });
	const log = vi.fn();
	const device = createViewerRelayReachability({
		store: f.remote.store,
		config,
		allowLoopback: true,
		resolveGroup: (db, groupId) =>
			control.next ? Promise.resolve(control.next) : pinned(db, groupId),
		log,
	});
	if (!device) throw new Error("Relay reachability not configured");
	cleanups.push(() => device.close());
	const register = async () => {
		await device.refresh();
		const [client] = device.reachability.clients();
		if (!client) throw new Error("No relay client");
		await client.connect(new AbortController().signal, relayDeadline());
		return client;
	};
	const source = relay.client("source");
	f.client.db
		.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = ?")
		.run(JSON.stringify([await closedLoopbackUrl()]), f.remote.localDeviceId);
	const syncFromSource = () =>
		runSyncPass(f.client.db, f.remote.localDeviceId, {
			keysDir: f.remote.peerKeysDir,
			dbPath: f.options.dbPath,
			scanner: f.client.scanner,
			reachability: {
				scopeId: SCOPE,
				logicalOrigin: RELAY_LOGICAL_ORIGIN,
				relay: source,
				deadlineMs: performance.now() + 30000,
			},
		});
	const sockets = () => relay.runtime.counters().sockets;
	return { f, relay, device, control, log, register, syncFromSource, sockets };
}

const remoteTitles = (f: Awaited<ReturnType<typeof passFixture>>) =>
	f.remote.store.db
		.prepare("SELECT title FROM memory_items WHERE scope_id = ? ORDER BY title")
		.pluck()
		.all(SCOPE);

describe("viewer relay reachability as the relay target", () => {
	it("serves a relayed request with its own handler and the keys from CODEMEM_KEYS_DIR", async () => {
		// Arrange.
		const t = await targetDevice();
		await t.register();
		t.f.seed("client", "inbound-relay-item");
		// Act.
		const result = await t.syncFromSource();
		// Assert: Noise used the env key, the peer pin matched, and the scoped dispatcher applied the op.
		expect(result).toMatchObject({ ok: true, transport: "relay", opsOut: 1 });
		expect(remoteTitles(t.f)).toEqual(["inbound-relay-item"]);
	}, 60000);

	it("keeps the same client and socket when one info fetch fails", async () => {
		const t = await targetDevice();
		const client = await t.register();
		const sockets = t.sockets();
		t.control.next = { status: "disabled", groupId: GROUP, reason: "info_unavailable" };
		await t.device.refresh();
		t.control.next = undefined;
		await t.device.refresh();
		expect(t.device.reachability.clients()).toEqual([client]);
		expect(t.device.status().get(GROUP)).toBe("ready");
		expect(t.sockets()).toBe(sockets);
	}, 30000);

	it("closes the live client when the group pauses", async () => {
		const t = await targetDevice();
		await t.register();
		const sockets = t.sockets();
		t.control.next = {
			status: "paused",
			groupId: GROUP,
			pinnedKey: t.relay.servicePublicKey,
			candidateKey: CANONICAL_PUBLIC_KEY,
		};
		await t.device.refresh();
		expect(t.device.reachability.clients()).toEqual([]);
		await vi.waitFor(() => expect(t.sockets()).toBe(sockets - 1));
		expect(t.log).toHaveBeenLastCalledWith(expect.stringContaining("paused"), "warn");
	}, 30000);

	it("warns when relay info is unavailable for a group that relayed and its pin is gone", async () => {
		const t = await targetDevice();
		await t.register();
		t.f.remote.store.db.prepare("DELETE FROM sync_relay_service_pins").run();
		t.control.next = { status: "disabled", groupId: GROUP, reason: "info_unavailable" };
		await t.device.refresh();
		expect(t.device.reachability.clients()).toEqual([]);
		expect(t.log).toHaveBeenLastCalledWith(
			`[codemem] relay for group ${GROUP}: disabled: info_unavailable`,
			"warn",
		);
	}, 30000);

	it("rebuilds the client when a ready reply carries a different key", async () => {
		const t = await targetDevice();
		const client = await t.register();
		// A consistent config for another service key, as relayGroupClientConfig would build it.
		const other = testSigner(4);
		t.control.next = {
			status: "ready",
			config: {
				...relayConfig(t.relay, GROUP, other.publicKey),
				relayAudienceId: relayAudienceId(`wss://${new URL(t.relay.url).host}`, other.keyId),
			},
		};
		await t.device.refresh();
		const [rebuilt] = t.device.reachability.clients();
		expect(rebuilt).toBeDefined();
		expect(rebuilt).not.toBe(client);
		expect(t.log).toHaveBeenCalledTimes(1);
	}, 30000);

	it("drops clients built for a device identity that changed, then rebuilds for the restored one", async () => {
		const t = await targetDevice();
		const client = await t.register();
		const db = t.f.remote.store.db;
		const original = db.prepare("SELECT public_key FROM sync_device").pluck().get();
		db.prepare("UPDATE sync_device SET public_key = ?").run(CANONICAL_PUBLIC_KEY);
		await t.device.refresh();
		await t.device.refresh();
		expect(t.device.reachability.clients()).toEqual([]);
		const changed = t.log.mock.calls.filter(([line]) => String(line).includes("identity changed"));
		expect(changed).toEqual([
			["[codemem] device identity changed; rebuilding relay clients", "warn"],
		]);
		db.prepare("UPDATE sync_device SET public_key = ?").run(original);
		await t.device.refresh();
		const [rebuilt] = t.device.reachability.clients();
		expect(rebuilt).toBeDefined();
		expect(rebuilt).not.toBe(client);
	}, 30000);
});

describe("viewer relay reachability key directory", () => {
	it("signs the info request with the key from CODEMEM_KEYS_DIR when keysDir is omitted", async () => {
		const f = await passFixture();
		cleanups.push(() => f.cleanup());
		vi.stubEnv("CODEMEM_KEYS_DIR", join(dirname(f.remote.peerKeysDir), "local-keys"));
		const endpoint = relayCoordinatorEndpoint(COORDINATOR);
		if (!endpoint) throw new Error("Unsupported fixture coordinator");
		const request = vi.fn(async (_method: string, _url: string, _options?: unknown) => [
			200,
			{
				group_id: GROUP,
				service_public_key: CANONICAL_PUBLIC_KEY,
				relay_path: relayRealmPath(endpoint.authorityId, GROUP),
				admission_path: "/v1/relay/admission-check",
			},
		]);
		const log = vi.fn();
		const device = createViewerRelayReachability({
			store: f.remote.store,
			config,
			request: request as never,
			log,
		});
		cleanups.push(() => device?.close());

		await device?.refresh();

		const [, url, options] = request.mock.calls[0] ?? [];
		const headers = (options as { headers: Record<string, string> }).headers;
		const parsed = new URL(String(url));
		expect(
			verifySignature({
				method: "GET",
				pathWithQuery: parsed.pathname + parsed.search,
				bodyBytes: Buffer.alloc(0),
				timestamp: headers["X-Opencode-Timestamp"] ?? "",
				nonce: headers["X-Opencode-Nonce"] ?? "",
				signature: headers["X-Opencode-Signature"] ?? "",
				publicKey: f.remote.localPublicKey,
				deviceId: f.remote.localDeviceId,
			}),
		).toBe(true);
		expect(device?.status().get(GROUP)).toBe("ready");
		expect(device?.reachability.clients()).toHaveLength(1);
		expect(log).toHaveBeenCalledWith(`[codemem] relay for group ${GROUP}: ready`, "info");
	});
});
