import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, readCoordinatorSyncConfig, removePairingState } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import {
	getSyncChannelProgress,
	saveSyncChannelCompletedBoundary,
} from "../../core/src/sync-channel-progress.js";
import { getReplicationCursor } from "../../core/src/sync-replication.js";
import { type AppOptions, createApp } from "./index.js";
import { SCOPE } from "./sync-channel-dispatch-test-fixtures.js";
import { passFixture } from "./sync-channel-pass-test-fixtures.js";

type Fixture = Awaited<ReturnType<typeof passFixture>>;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
	const directory = mkdtempSync(join(tmpdir(), "peer-delete-config-"));
	const path = join(directory, "config.json");
	writeFileSync(path, "{}");
	vi.stubEnv("CODEMEM_CONFIG", path);
	cleanups.push(async () => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function titles(f: Fixture, side: "client" | "remote") {
	const store = side === "client" ? f.client : f.remote.store;
	return store.db
		.prepare("SELECT title FROM memory_items WHERE scope_id = ? ORDER BY title")
		.pluck()
		.all(SCOPE);
}

it("H7: remove, then pair the same device ID again: both sides exchange the full history, including operations the peer had acknowledged", async () => {
	const f = await passFixture();
	cleanups.push(f.cleanup);
	const peerDeviceId = f.remote.localDeviceId;
	f.seed("remote", "remote-before");
	f.seed("client", "client-before");
	expect((await syncScopedChannelOnce(f.options)).ok).toBe(true);
	expect(getSyncChannelProgress(f.client.db, peerDeviceId, SCOPE)?.last_acked_cursor).toContain(
		"client-before-op",
	);
	const pairing = f.client.db
		.prepare("SELECT * FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as Record<string, unknown>;

	removePairingState(f.client.db, {
		localDeviceId: f.client.deviceId,
		reason: "local",
		deviceIds: [peerDeviceId],
	});
	expect(getReplicationCursor(f.client.db, peerDeviceId, SCOPE)).toEqual([null, null]);
	expect(getSyncChannelProgress(f.client.db, peerDeviceId, SCOPE)).toBeNull();

	// These sort before the acknowledged operations, so a kept position would skip them.
	f.seed("remote", "remote-after");
	f.seed("client", "client-after");
	const columns = Object.keys(pairing);
	f.client.db
		.prepare(
			`INSERT INTO sync_peers (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		)
		.run(...Object.values(pairing));
	// Removal also ended the cached scope authorization. The coordinator still
	// grants the device, so the next trusted refresh restores it.
	await refreshTestScopeRows(f.client.db, {
		[f.remote.localDeviceId]: f.remote.localPublicKey,
		[f.remote.peerDeviceId]: f.remote.peerPublicKey,
	});
	const requestsBeforePairingAgain = f.requests.length;

	const result = await syncScopedChannelOnce(f.options);

	// Inbound: the peer's whole history arrives again as a snapshot.
	expect(result).toMatchObject({ ok: true, bootstrapped: true });
	const afterPairingAgain = f.requests.slice(requestsBeforePairingAgain);
	expect(afterPairingAgain.map((request) => new URL(request.url).pathname)).toContain(
		"/v1/snapshot",
	);
	// Outbound: the operation the peer had already acknowledged is sent again.
	const pushed = afterPairingAgain
		.filter((request) => request.method === "POST")
		.flatMap(
			(request) =>
				(JSON.parse(new TextDecoder().decode(request.bodyBytes)) as { ops: { op_id: string }[] })
					.ops,
		)
		.map((op) => op.op_id);
	expect(pushed).toEqual(["client-after-op", "client-before-op"]);
	const everything = ["client-after", "client-before", "remote-after", "remote-before"];
	expect(titles(f, "client")).toEqual(everything);
	expect(titles(f, "remote")).toEqual(everything);
});

const NOW = "2026-11-17T00:00:00.000Z";
const COORDINATOR_URL = "https://coord.example.test";

/** Coordinator settings that do not depend on the environment or a config file. */
function coordinatorSettings(overrides: { url?: string; adminSecret?: string } = {}) {
	const groups = overrides.url ? ["group-a"] : [];
	return () => ({
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: overrides.url ?? "",
		syncCoordinatorGroup: groups[0] ?? "",
		syncCoordinatorGroups: groups,
		syncCoordinatorAdminSecret: overrides.adminSecret ?? "",
	});
}

const NO_COORDINATOR = coordinatorSettings();
const WITHOUT_ADMIN_SECRET = coordinatorSettings({ url: COORDINATOR_URL });
const ADMIN_DEVICE = coordinatorSettings({
	url: COORDINATOR_URL,
	adminSecret: "fixture-admin-secret",
});

/** A paired, bound device with sync progress, and a Project shared with its Identity. */
function peerDeleteFixture(options: Pick<AppOptions, "readCoordinatorConfig">) {
	const directory = mkdtempSync(join(tmpdir(), "viewer-peer-delete-"));
	const store = new MemoryStore(join(directory, "mem.sqlite"));
	cleanups.push(async () => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	store.db
		.prepare("INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES ('peer-1', 'Old', ?)")
		.run(NOW);
	store.db
		.prepare(
			"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, updated_at) VALUES ('peer-1', 'c1', ?)",
		)
		.run(NOW);
	store.db
		.prepare(
			"INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, updated_at) VALUES ('peer-1', 'scope-a', 'c2', ?)",
		)
		.run(NOW);
	store.db
		.prepare(
			`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
			 revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES ('peer-1', 'identity-a', 'Old', 'active', 'test', '1', 'user_managed', 'binding:peer-1', ?, ?)`,
		)
		.run(NOW, NOW);
	saveSyncChannelCompletedBoundary(store.db, {
		peerDeviceId: "peer-1",
		scopeId: "scope-a",
		boundary: { generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null },
	});
	store.db
		.prepare(
			`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
			 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES ('project-a', 'identity', 'identity-a', 'active', 'test', '1', 'native', 'recipient:a', ?, ?)`,
		)
		.run(NOW, NOW);
	store.db
		.prepare(
			`INSERT INTO recipient_policy_authority_states(canonical_project_identity, authority_state,
			 generation, state_changed_at, last_attempt_at, created_at, updated_at)
			 VALUES ('project-a', 'active', 1, ?, ?, ?, ?)`,
		)
		.run(NOW, NOW, NOW, NOW);
	const app = createApp({ storeFactory: () => store, ...options });
	const count = (table: string) =>
		store.db.prepare(`SELECT COUNT(*) FROM ${table} WHERE peer_device_id = 'peer-1'`).pluck().get();
	return {
		remove: () => app.request("/api/sync/peers/peer-1", { method: "DELETE" }),
		recipients: () =>
			store.db
				.prepare("SELECT recipient_id, status FROM project_recipients ORDER BY recipient_id")
				.all(),
		state: () => ({
			pairingAndProgress: [
				count("sync_peers"),
				count("replication_cursors"),
				count("replication_cursors_v2"),
				count("sync_channel_progress"),
			],
			binding: store.db
				.prepare("SELECT status FROM identity_devices WHERE device_id = 'peer-1'")
				.pluck()
				.get(),
			// The reconciler clears this when a Project's policy is woken.
			policyLastAttemptAt: store.db
				.prepare("SELECT last_attempt_at FROM recipient_policy_authority_states")
				.pluck()
				.get(),
		}),
	};
}

const BINDING_KEPT = {
	pairingAndProgress: [0, 0, 0, 0],
	binding: "active",
	policyLastAttemptAt: NOW,
};
const KEPT_REPLY = {
	ok: true,
	binding: "kept",
	remove_from_projects: "needs_admin_device",
	notice:
		"Only this device's pairing was removed. If both devices are in a Team, codemem pairs them again automatically. To stop syncing on every device, use Remove device.",
};

describe("DELETE /api/sync/peers/:peer_device_id", () => {
	it("keeps the binding with truncated config through the real default reader", async () => {
		writeFileSync(
			process.env.CODEMEM_CONFIG as string,
			'{"sync_coordinator_url":"https://coordinator.invalid"',
		);
		const f = peerDeleteFixture({});
		const response = await f.remove();
		expect(response.status).toBe(200);
		expect(f.state()).toEqual(BINDING_KEPT);
		expect(await response.json()).toEqual(KEPT_REPLY);
	});

	it.each([
		["no coordinator is configured", NO_COORDINATOR],
		["there is no admin secret", WITHOUT_ADMIN_SECRET],
		["this device holds the admin secret", ADMIN_DEVICE],
	])(
		"when %s, deletes the pairing and its sync progress, keeps the Identity binding, and wakes no Project policy",
		async (_name, readCoordinatorConfig) => {
			const f = peerDeleteFixture({ readCoordinatorConfig });

			const response = await f.remove();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(KEPT_REPLY);
			expect(f.state()).toEqual(BINDING_KEPT);
		},
	);

	it("leaves the Project recipient sets unchanged on an admin device", async () => {
		const f = peerDeleteFixture({ readCoordinatorConfig: ADMIN_DEVICE });
		const before = f.recipients();

		await f.remove();

		expect(before).toEqual([{ recipient_id: "identity-a", status: "active" }]);
		expect(f.recipients()).toEqual(before);
	});
});
