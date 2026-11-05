import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Database } from "@codemem/core";
import {
	approveRelayServiceKey,
	reconcileRelayServicePin,
} from "@codemem/core/internal/relay-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import {
	relayClientFixture,
	relayDeadline,
} from "../../core/src/relay-peer-client-test-fixtures.js";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { runSyncPass } from "../../core/src/sync-pass.js";
import { createViewerRelayReachability } from "./relay-reachability.js";
import {
	COORDINATOR,
	closedLoopbackUrl,
	identity,
	resolver,
} from "./relay-reachability-test-fixtures.js";
import { createSyncChannelDispatcher } from "./sync-channel-dispatch.js";
import { SCOPE } from "./sync-channel-dispatch-test-fixtures.js";
import { addPassPeer, passFixture } from "./sync-channel-pass-test-fixtures.js";

const TEAM_B_SCOPE = "team-b-space";
const config = {
	sync_coordinator_url: COORDINATOR,
	sync_coordinator_groups: ["team-a", "team-b"],
	sync_relay_enabled: true,
};

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function copyRows(db: Database, table: string, where: string, values: unknown[], patch: object) {
	const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...values) as object[];
	for (const row of rows) {
		const merged = { ...row, ...patch };
		const columns = Object.keys(merged);
		db.prepare(
			`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		).run(...Object.values(merged));
	}
}

/** Team A shares the fixture Space with the first server; team B shares a new Space with the second. */
async function managedSpaces(
	a: Awaited<ReturnType<typeof passFixture>>,
	b: Awaited<ReturnType<typeof addPassPeer>>,
) {
	const teamA = { kind: "managed_project", coordinator_id: COORDINATOR, group_id: "team-a" };
	const teamB = { ...teamA, scope_id: TEAM_B_SCOPE, label: TEAM_B_SCOPE, group_id: "team-b" };
	const authority = (team: typeof teamA) => ({
		coordinator_id: team.coordinator_id,
		group_id: team.group_id,
	});
	for (const db of [a.client.db, a.remote.store.db]) {
		db.prepare(
			"UPDATE replication_scopes SET kind = ?, coordinator_id = ?, group_id = ? WHERE scope_id = ?",
		).run(...Object.values(teamA), SCOPE);
		db.prepare(
			"UPDATE scope_memberships SET coordinator_id = ?, group_id = ? WHERE scope_id = ?",
		).run(...Object.values(authority(teamA)), SCOPE);
	}
	for (const db of [a.client.db, b.remote.store.db]) {
		copyRows(db, "replication_scopes", "scope_id = ?", [SCOPE], teamB);
		const notTeamA = "scope_id = ? AND device_id != ?";
		copyRows(db, "scope_memberships", notTeamA, [SCOPE, a.remote.localDeviceId], {
			scope_id: TEAM_B_SCOPE,
			...authority(teamB),
		});
	}
	a.client.db
		.prepare("DELETE FROM scope_memberships WHERE scope_id = ? AND device_id = ?")
		.run(SCOPE, b.remote.localDeviceId);
	const keys = {
		[a.remote.peerDeviceId]: a.remote.peerPublicKey,
		[a.remote.localDeviceId]: a.remote.localPublicKey,
		[b.remote.localDeviceId]: b.remote.localPublicKey,
	};
	for (const db of [a.client.db, a.remote.store.db, b.remote.store.db])
		await refreshTestScopeRows(db, keys, { now: new Date() });
}

type Remote = Awaited<ReturnType<typeof passFixture>>["remote"] & { serverKeysDir?: string };

/** A real loopback relay for one team, with that team's server registered as the target. */
async function teamRelay(device: Remote, server: Remote, groupId: string) {
	const serverKeys = server.serverKeysDir ?? join(server.peerKeysDir, "..", "local-keys");
	const relay = await relayClientFixture(
		{
			source: identity(device.peerKeysDir, device.peerPublicKey),
			target: identity(serverKeys, server.localPublicKey),
		},
		{ source: device.peerDeviceId, target: server.localDeviceId },
		{ groupId },
	);
	cleanups.push(() => relay.dispose());
	const dispatch = createSyncChannelDispatcher({ storeFactory: server.storeFactory });
	const target = relay.client("target", {
		onInbound: async (_connection, context) =>
			context.serve({
				origin: "https://relay.codemem.invalid",
				dispatch: (request) => {
					vi.stubEnv("CODEMEM_KEYS_DIR", serverKeys);
					return dispatch(request);
				},
			}),
	});
	await target.connect(new AbortController().signal, relayDeadline());
	return relay;
}

type TeamRelay = Awaited<ReturnType<typeof teamRelay>>;

async function twoTeams() {
	const a = await passFixture();
	cleanups.push(() => a.cleanup());
	const b = await addPassPeer(a);
	cleanups.push(() => b.cleanup());
	await managedSpaces(a, b);
	for (const peer of [a.remote.localDeviceId, b.remote.localDeviceId])
		a.client.db
			.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = ?")
			.run(JSON.stringify([await closedLoopbackUrl()]), peer);
	const relays = {
		"team-a": await teamRelay(a.remote, a.remote, "team-a"),
		"team-b": await teamRelay(a.remote, b.remote, "team-b"),
	};
	const log = vi.fn();
	// A copy, so a test can change the group list the way joining or leaving a team does.
	const settings = { ...config, sync_coordinator_groups: [...config.sync_coordinator_groups] };
	const relay = createViewerRelayReachability({
		store: a.client,
		keysDir: a.remote.peerKeysDir,
		config: settings,
		allowLoopback: true,
		resolveGroup: resolver(relays),
		log,
	});
	if (!relay) throw new Error("Relay reachability not configured");
	cleanups.push(() => relay.close());
	const peers = { "team-a": a.remote.localDeviceId, "team-b": b.remote.localDeviceId };
	const sync = (peer: string) => {
		const route = relay.reachability.forPeer(a.client.db, peer);
		return runSyncPass(a.client.db, peer, {
			keysDir: a.remote.peerKeysDir,
			dbPath: a.options.dbPath,
			scanner: a.client.scanner,
			reachability: route && { ...route, deadlineMs: performance.now() + 30000 },
		});
	};
	return { a, b, relays, relay, peers, log, sync, settings };
}

const sourceChecks = (relay: TeamRelay) => relay.checks.length;

describe("viewer relay reachability", () => {
	it("relays each team's peer through that team's client when direct sync fails", async () => {
		// Arrange.
		const f = await twoTeams();
		f.a.seed("remote", "team-a-item");
		await f.relay.refresh();
		const before = { a: sourceChecks(f.relays["team-a"]), b: sourceChecks(f.relays["team-b"]) };
		// Act.
		const teamA = await f.sync(f.peers["team-a"]);
		const afterA = sourceChecks(f.relays["team-b"]);
		const teamB = await f.sync(f.peers["team-b"]);
		// Assert: each peer's route uses its own group's client and relay.
		expect(f.relay.reachability.forPeer(f.a.client.db, f.peers["team-a"])?.scopeId).toBe(SCOPE);
		expect(f.relay.reachability.forPeer(f.a.client.db, f.peers["team-b"])?.scopeId).toBe(
			TEAM_B_SCOPE,
		);
		expect(teamA).toMatchObject({ ok: true, transport: "relay", opsIn: 1 });
		expect(teamB).toMatchObject({ ok: true, transport: "relay" });
		expect(afterA).toBe(before.b);
		expect(sourceChecks(f.relays["team-a"])).toBeGreaterThan(before.a);
		expect(sourceChecks(f.relays["team-b"])).toBeGreaterThan(afterA);
		expect(f.relay.reachability.clients()).toHaveLength(2);
	}, 60000);

	it("keeps a paused group direct-only until refresh picks up an approval, then closes every client", async () => {
		// Arrange: team B already pinned another key, so the advertised key is a pending change.
		const f = await twoTeams();
		reconcileRelayServicePin(f.a.client.db, {
			coordinatorId: COORDINATOR,
			groupId: "team-b",
			advertisedKey: CANONICAL_PUBLIC_KEY,
		});
		await f.relay.refresh();
		await f.relay.refresh();
		// Assert: paused, direct-only, logged once.
		expect(Object.fromEntries(f.relay.status())).toEqual({ "team-a": "ready", "team-b": "paused" });
		expect(f.relay.reachability.forPeer(f.a.client.db, f.peers["team-b"])).toBeUndefined();
		expect(f.relay.reachability.clients()).toHaveLength(1);
		expect(f.log.mock.calls.filter(([line]) => String(line).includes("paused"))).toHaveLength(1);
		const direct = await f.sync(f.peers["team-b"]);
		expect(direct).toMatchObject({ ok: false });
		expect(direct.transport).not.toBe("relay");
		// Act: approve the candidate and refresh.
		const approved = approveRelayServiceKey(f.a.client.db, {
			coordinatorId: COORDINATOR,
			groupId: "team-b",
			candidateKey: f.relays["team-b"].servicePublicKey,
		});
		await f.relay.refresh();
		const relayed = await f.sync(f.peers["team-b"]);
		// Assert.
		expect(approved).toBe(true);
		expect(f.relay.status().get("team-b")).toBe("ready");
		expect(relayed).toMatchObject({ ok: true, transport: "relay" });
		await f.relay.close();
		await f.relay.refresh();
		expect(f.relay.reachability.clients()).toEqual([]);
		await vi.waitFor(() =>
			expect(f.relays["team-b"].runtime.counters()).toMatchObject({ sockets: 1, routes: 0 }),
		);
	}, 60000);

	it("follows the configured group list while running, closing a left group and relaying a joined one", async () => {
		// Arrange.
		const f = await twoTeams();
		await f.relay.refresh();
		// Act: leave team B, the way the config changes while the viewer runs.
		f.settings.sync_coordinator_groups = ["team-a"];
		await f.relay.refresh();
		// Assert: team B's client is closed and its peer has no relay route.
		expect(Object.fromEntries(f.relay.status())).toEqual({ "team-a": "ready" });
		expect(f.relay.reachability.forPeer(f.a.client.db, f.peers["team-b"])).toBeUndefined();
		await vi.waitFor(() =>
			expect(f.relays["team-b"].runtime.counters()).toMatchObject({ sockets: 1, routes: 0 }),
		);
		// Act: join team B again without restarting.
		f.settings.sync_coordinator_groups = ["team-a", "team-b"];
		await f.relay.refresh();
		const relayed = await f.sync(f.peers["team-b"]);
		// Assert.
		expect(f.relay.status().get("team-b")).toBe("ready");
		expect(relayed).toMatchObject({ ok: true, transport: "relay" });
	}, 60000);
});

describe("viewer relay reachability configuration", () => {
	const store = { db: {}, dbPath: ":memory:" } as never;

	it.each([
		["relay is off", { ...config, sync_relay_enabled: false }],
		["no coordinator is configured", { ...config, sync_coordinator_url: "" }],
	])("builds nothing when %s", (_label, settings) => {
		expect(createViewerRelayReachability({ store, config: settings })).toBeNull();
	});

	it("starts with no groups and picks up a group joined later", async () => {
		const settings = { ...config, sync_coordinator_groups: [] as string[] };
		const resolveGroup = vi.fn(async (_db: Database, groupId: string) => ({
			status: "disabled" as const,
			groupId,
			reason: "info_unavailable" as const,
		}));
		const relay = createViewerRelayReachability({ store, config: settings, resolveGroup });
		await relay?.refresh();
		expect(relay?.status().size).toBe(0);
		settings.sync_coordinator_groups = ["team-a"];
		await relay?.refresh();
		expect(Object.fromEntries(relay?.status() ?? [])).toEqual({ "team-a": "disabled" });
		expect(resolveGroup).toHaveBeenCalledTimes(1);
	});

	it("drops every group and warns once when the configured coordinator changes", async () => {
		const settings = { ...config };
		const log = vi.fn();
		const relay = createViewerRelayReachability({
			store,
			config: settings,
			resolveGroup: async (_db, groupId) => ({
				status: "disabled",
				groupId,
				reason: "info_unavailable",
			}),
			log,
		});
		settings.sync_coordinator_url = "https://other.example.test";
		await relay?.refresh();
		await relay?.refresh();
		expect(relay?.status().size).toBe(0);
		expect(log.mock.calls.filter(([line]) => String(line).includes("restart"))).toHaveLength(1);
	});

	it("leaves a group direct-only and logs once when resolution or client setup fails", async () => {
		const log = vi.fn();
		const relay = createViewerRelayReachability({
			store: { db: { prepare: () => ({ get: () => undefined }) }, dbPath: ":memory:" } as never,
			config: { ...config, sync_coordinator_groups: ["team-a", "team-b"] },
			resolveGroup: async (_db, groupId) => {
				if (groupId === "team-a") throw new Error("offline");
				return { status: "ready", config: { groupId } as never };
			},
			log,
		});
		await relay?.refresh();
		await relay?.refresh();
		expect(Object.fromEntries(relay?.status() ?? [])).toEqual({
			"team-a": "disabled",
			"team-b": "disabled",
		});
		expect(relay?.reachability.clients()).toEqual([]);
		// A coordinator without relay is normal before any group has relayed, so these are info.
		expect(log.mock.calls).toEqual([
			["[codemem] relay for group team-a: disabled: info_unavailable", "info"],
			["[codemem] relay for group team-b: disabled: device identity missing", "info"],
		]);
	});
});
