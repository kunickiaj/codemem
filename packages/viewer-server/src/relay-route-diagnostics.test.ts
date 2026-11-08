import { MemoryStore } from "@codemem/core";
import type { RelayGroupClientConfig } from "@codemem/core/internal/relay-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayPeerClientOptions } from "../../core/src/relay-peer-client.js";
import { disposableIdentity } from "../../core/src/relay-peer-client-test-fixtures.js";
import {
	createViewerRelayReachability,
	type ViewerRelayReachability,
} from "./relay-reachability.js";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), loadPrivateKey: vi.fn() }));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	loadPrivateKey: mocks.loadPrivateKey,
}));
vi.mock("@codemem/core/internal/relay-runtime", async (original) => ({
	...(await original<typeof import("@codemem/core/internal/relay-runtime")>()),
	createRelayPeerClient: mocks.createClient,
	createRelayCoordinatorClient: vi.fn(() => ({ check: vi.fn() })),
}));

const stores: MemoryStore[] = [];
const devices: ViewerRelayReachability[] = [];
afterEach(async () => {
	for (const device of devices.splice(0)) await device.close();
	for (const store of stores.splice(0)) store.close();
	vi.clearAllMocks();
});

async function fixture() {
	const store = new MemoryStore(":memory:");
	stores.push(store);
	const identity = disposableIdentity(2);
	mocks.loadPrivateKey.mockReturnValue(identity.key.export({ format: "pem", type: "pkcs8" }));
	store.db
		.prepare(
			"INSERT INTO sync_device (device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("local-device-sentinel", identity.expectedPin, "fingerprint", "2026-01-01T00:00:00.000Z");
	store.db
		.prepare(
			"INSERT INTO sync_peers (peer_device_id, created_at, last_sync_at, last_error, relay_rejections) VALUES (?, ?, ?, ?, ?)",
		)
		.run(
			"real-peer-sentinel",
			"2026-01-01T00:00:00.000Z",
			"2026-01-02T00:00:00.000Z",
			"existing peer error",
			3,
		);
	mocks.createClient.mockReturnValue({ close: vi.fn(async () => {}), revalidate: vi.fn() });
	const log = vi.fn();
	const config = {
		url: "wss://relay.example.test/relay",
		admissionUrl: "https://coordinator.example.test/v1/relay/admission-check",
		servicePublicKey: identity.expectedPin,
		authorityId: "authority",
		groupId: "group",
		relayAudienceId: "a".repeat(64),
		externalPathname: "/v1/relay/admission-check",
	} as RelayGroupClientConfig;
	const device = createViewerRelayReachability({
		store,
		keysDir: "unused-mocked-key-directory",
		log,
		config: {
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_groups: ["group"],
			sync_relay_enabled: true,
		},
		resolveGroup: vi.fn(async () => ({ status: "ready" as const, config })),
	});
	if (!device) throw new Error("Expected relay reachability");
	devices.push(device);
	await device.refresh();
	const options = mocks.createClient.mock.calls[0]?.[0] as RelayPeerClientOptions | undefined;
	if (!options?.onRouteFailure) throw new Error("Missing route failure callback");
	const attempts = () =>
		store.db
			.prepare(
				"SELECT peer_device_id, ok, ops_in, ops_out, error, failure_category FROM sync_attempts",
			)
			.all();
	const peers = () => store.db.prepare("SELECT * FROM sync_peers ORDER BY peer_device_id").all();
	return { store, device, options, attempts, peers, log };
}

describe("temporary viewer relay route diagnostics", () => {
	it.each(["source", "target"] as const)(
		"persists %s failures under an empty peer without changing real peer health",
		async (side) => {
			// Arrange: the callback receives a validated client event, not a peer identifier.
			const f = await fixture();
			const peers = f.peers();
			const sessionId = "0123456789abcdef0123456789abcdef";
			// Act.
			await f.options.onRouteFailure?.({ sessionId, side, reason: "relay_rejected" });
			// Assert: the existing attempt recorder persists the synthetic error only.
			expect(f.attempts()).toEqual([
				{
					peer_device_id: "",
					ok: 0,
					ops_in: 0,
					ops_out: 0,
					error: `relay_route_failure side=${side} session=${sessionId} reason=relay_rejected`,
					failure_category: "connectivity",
				},
			]);
			expect(f.peers()).toEqual(peers);
		},
	);

	it("does not persist an attempt when refreshing or closing without route failures", async () => {
		// Arrange.
		const f = await fixture();
		const peers = f.peers();
		// Act.
		await f.device.refresh();
		await f.device.close();
		// Assert.
		expect(f.attempts()).toEqual([]);
		expect(f.peers()).toEqual(peers);
	});

	it("does not expose database errors or change peer health when persistence fails", async () => {
		// Arrange: reject only synthetic attempts, leaving real peer health readable.
		const f = await fixture();
		const peers = f.peers();
		f.store.db.exec(`CREATE TRIGGER reject_route_diagnostic BEFORE INSERT ON sync_attempts
			WHEN NEW.peer_device_id = '' BEGIN SELECT RAISE(ABORT, 'private-database-sentinel'); END;`);
		// Act.
		await f.options.onRouteFailure?.({
			sessionId: "a".repeat(32),
			side: "target",
			reason: "relay_aborted",
		});
		// Assert: persistence failure cannot escape into route cleanup or log raw exception text.
		expect(f.attempts()).toEqual([]);
		expect(f.peers()).toEqual(peers);
		expect(JSON.stringify(f.log.mock.calls)).not.toContain("private-database-sentinel");
	});
});
