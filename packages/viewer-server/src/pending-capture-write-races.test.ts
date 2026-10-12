import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coordinatorImportInviteAction, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeInvitePayload } from "../../core/src/coordinator-invites.js";
import { enrollFixtureSigningKey } from "../../core/src/managed-scope-test-fixtures.js";
import { now, useLocalCaptureFixture } from "../../core/src/memory-local-capture-test-fixtures.js";
import { shareProjectSetDigest } from "../../core/src/share-operation.js";
import * as syncIdentity from "../../core/src/sync-identity.js";
import { fingerprintPublicKey } from "../../core/src/sync-identity.js";
import { advanceProjectShareOperation, syncRoutes } from "./routes/sync.js";

const { fixture, rememberScoped, factRows, ledger } = useLocalCaptureFixture();
const deviceId = "capture-device";
const actorId = `local:${deviceId}`;
const states = ["foreign", "inactive", "merged"] as const;
type Conflict = (typeof states)[number];
const operationId = `share_${"a".repeat(40)}`;
const project = {
	canonical_identity: "https://example.test/project.git",
	display_name: "Project",
	existing_memory_count: 0,
};
const invite = encodeInvitePayload({
	v: 1,
	kind: "coordinator_team_invite",
	coordinator_url: "https://coordinator.example.test",
	group_id: "fixture-group",
	policy: "auto_admit",
	token: "fixture-token",
	expires_at: "2099-01-01T00:00:00.000Z",
	operation_id: operationId,
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(now));
	writeFileSync(
		join(fixture.dir, "config.json"),
		JSON.stringify({ actor_display_name: "Fixture Owner", sync_device_name: "Fixture Laptop" }),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network call");
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function reopen() {
	fixture.store.close();
	fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), { keysDir: fixture.keysDir });
}
function snapshot() {
	return Object.fromEntries(
		[
			"actors",
			"memory_items",
			"memory_local_capture",
			"memory_local_capture_adoption",
			"memory_source_bindings",
			"memory_local_creation_snapshots",
			"sync_device",
			"sync_peers",
			"identity_devices",
			"device_identity_binding_audit",
			"policy_team_memberships",
			"policy_team_device_decisions",
			"project_recipients",
			"recipient_managed_project_projections",
			"recipient_policy_authority_states",
			"share_operations",
			"share_operation_projects",
			"share_operation_steps",
			"replication_scopes",
			"actor_scope_memberships",
			"device_scope_memberships",
			"project_scope_mappings",
		].map((table) => [table, factRows(table)]),
	);
}
function keys() {
	return [
		readFileSync(join(fixture.keysDir, "device.key")),
		readFileSync(join(fixture.keysDir, "device.key.pub")),
	];
}
function config() {
	return readFileSync(join(fixture.dir, "config.json"));
}
function mutate(db: Database.Database, state: Conflict, target = actorId) {
	const values = {
		foreign: [0, "active", null],
		inactive: [1, "inactive", null],
		merged: [1, "merged", "different-owner"],
	}[state];
	db.prepare(
		"UPDATE actors SET is_local = ?, status = ?, merged_into_actor_id = ? WHERE actor_id = ?",
	).run(...values, target);
}
function pending(options: { configured?: boolean; valid?: boolean } = {}) {
	let target = actorId;
	if (options.configured) {
		target = "configured-owner";
		vi.stubEnv("CODEMEM_ACTOR_ID", target);
		reopen();
	}
	rememberScoped();
	fixture.store.db
		.prepare(
			"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, 'Fixture Owner', 1, 'inactive', ?, ?)",
		)
		.run(target, now, now);
	enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
	expect(ledger().birth).toHaveLength(1);
	expect(ledger().adoption).toEqual([]);
	if (options.valid)
		fixture.store.db.prepare("UPDATE actors SET status = 'active' WHERE actor_id = ?").run(target);
	reopen();
	return target;
}
function post(path: string, body: Record<string, unknown>) {
	return syncRoutes(() => fixture.store).request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
function importCore() {
	return coordinatorImportInviteAction({
		inviteValue: invite,
		dbPath: fixture.store.dbPath,
		keysDir: fixture.keysDir,
		configPath: join(fixture.dir, "config.json"),
		recipientActorId: fixture.store.actorId,
		recipientDisplayName: "Fixture Owner",
		deviceDisplayName: "Fixture Laptop",
	});
}
function acceptedResponse() {
	return new Response(
		JSON.stringify({
			ok: true,
			status: "accepted",
			trust_state: "pending_inviter_device",
			group_id: "fixture-group",
			operation_id: operationId,
			accepted_project_intent: {
				operation_id: operationId,
				reviewed_project_set_digest: shareProjectSetDigest([
					{
						canonicalIdentity: project.canonical_identity,
						displayName: project.display_name,
						identitySource: "git_remote",
						existingMemoryCount: 0,
					},
				]),
				projects: [project],
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function pendingShare() {
	pending({ valid: true });
	writeFileSync(
		join(fixture.dir, "config.json"),
		JSON.stringify({
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_group: "fixture-group",
			sync_coordinator_admin_secret: "fixture-secret",
		}),
	);
	fixture.store.db
		.prepare(`INSERT INTO actors
		(actor_id, display_name, is_local, status, created_at, updated_at)
		VALUES ('pending-recipient', 'Recipient', 0, 'pending', ?, ?)`)
		.run(now, now);
	fixture.store.db
		.prepare(`INSERT INTO share_operations(
		operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
		person_kind, pending_person_operation_id, teammate_name, history_policy,
		reviewed_project_set_digest, coordinator_group_id, invite_token_digest,
		invite_expires_at, created_at, updated_at)
		VALUES (?, 'waiting_for_acceptance', ?, ?, 'pending-recipient', 'pending', ?,
		'Recipient', 'existing_and_future', ?, 'fixture-group', 'fixture-digest',
		'2099-01-01T00:00:00Z', ?, ?)`)
		.run(operationId, actorId, JSON.stringify([deviceId]), operationId, "b".repeat(64), now, now);
	fixture.store.db
		.prepare(`INSERT INTO share_operation_projects(
		operation_id, canonical_project_identity, display_name, identity_source,
		existing_memory_count, ordinal) VALUES (?, ?, 'Project', 'git_remote', 0, 0)`)
		.run(operationId, project.canonical_identity);
	expect(ledger().birth).toHaveLength(1);
	expect(ledger().adoption).toEqual([]);
	expect(() => fixture.store.assertPendingLocalCaptureAdoptionActors()).not.toThrow();
}

function reconciliationResponse(state = "accepted") {
	return new Response(
		JSON.stringify({
			operation_id: operationId,
			group_id: "fixture-group",
			state,
			reviewed_project_set_digest: "b".repeat(64),
			projects: [project],
			recipient_actor_id: "accepted-recipient",
			recipient_display_name: "Recipient",
			recipient_device_id: "recipient-device",
			recipient_device_display_name: "Recipient Laptop",
			recipient_public_key: "fixture-recipient-key",
			recipient_fingerprint: fingerprintPublicKey("fixture-recipient-key"),
			consumed_at: now,
			trust_state: "pending_inviter_device",
		}),
		{ status: 200 },
	);
}

it.each(
	states.flatMap((state) =>
		(["reconcile", "maintenance"] as const).map((consumer) => ({ state, consumer })),
	),
)(
	"rejects $state inviter drift during coordinator GET in $consumer",
	async ({ state, consumer }) => {
		// Fresh pending capture makes the real actor check applicable and initially valid.
		pendingShare();
		const other = new Database(fixture.store.dbPath);
		let competingCommit: ReturnType<typeof snapshot> | undefined;
		const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			expect(String(input)).toContain(
				`/v1/admin/project-invites/${operationId}?group_id=fixture-group`,
			);
			expect(init?.method).toBe("GET");
			expect(() => fixture.store.assertPendingLocalCaptureAdoptionActors()).not.toThrow();
			mutate(other, state);
			competingCommit = snapshot();
			return reconciliationResponse();
		});
		vi.stubGlobal("fetch", fetch);
		try {
			// Maintenance and HTTP share the actual acceptance helper, not a mocked assertion.
			let failure: unknown;
			if (consumer === "reconcile") {
				const response = await post(`/api/sync/project-invites/${operationId}/reconcile`, {});
				expect(response.status).toBe(409);
				failure = await response.json();
			} else {
				failure = await advanceProjectShareOperation(fixture.store, operationId).catch(
					(error) => error,
				);
			}
			// No acceptance, peer, actor, identity, scope, or policy writes follow the competing commit.
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(competingCommit).toBeDefined();
			expect(snapshot()).toEqual(competingCommit);
			expect(ledger().adoption).toEqual([]);
			if (consumer === "reconcile")
				expect(failure).toEqual({ error: "device_adoption_actor_conflict" });
			else expect(failure).toMatchObject({ message: "device_adoption_actor_conflict" });
		} finally {
			other.close();
		}
	},
);

it("reconciles accepted coordinator intent without inviter drift", async () => {
	// Use the identical pending capture and accepted response as the race cases.
	pendingShare();
	const fetch = vi.fn(async () => reconciliationResponse());
	vi.stubGlobal("fetch", fetch);
	const response = await post(`/api/sync/project-invites/${operationId}/reconcile`, {});
	// Acceptance persists through the real route and SQLite writer.
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ reconciled: true, state: "pending_setup" });
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(factRows("share_operations")).toEqual([
		expect.objectContaining({
			recipient_actor_id: "accepted-recipient",
			recipient_device_id: "recipient-device",
		}),
	]);
	expect(factRows("sync_peers")).toEqual([
		expect.objectContaining({ peer_device_id: "recipient-device" }),
	]);
});

it("keeps maintenance waiting without inviter drift or acceptance writes", async () => {
	// A valid local actor and a genuinely unaccepted remote invite.
	pendingShare();
	const before = snapshot();
	const fetch = vi.fn(async () => reconciliationResponse("waiting_for_acceptance"));
	vi.stubGlobal("fetch", fetch);
	const result = await advanceProjectShareOperation(fixture.store, operationId);
	// Maintenance reaches the GET and waits without provisioning or accepting.
	expect(result).toEqual({ advanced: false, state: "waiting_for_acceptance" });
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(snapshot()).toEqual(before);
});

it("reserves the SQLite writer before the post-GET pending actor check", async () => {
	// Probe only the commit-stage check, not the preflight before remote work.
	pendingShare();
	fixture.store.db.pragma("journal_mode = WAL");
	const other = new Database(fixture.store.dbPath);
	other.pragma("busy_timeout = 0");
	const check = fixture.store.assertPendingLocalCaptureAdoptionActors.bind(fixture.store);
	const interference: unknown[] = [];
	let armed = false;
	let commitChecks = 0;
	const checked = vi
		.spyOn(fixture.store, "assertPendingLocalCaptureAdoptionActors")
		.mockImplementation(() => {
			check();
			if (!armed) return;
			commitChecks++;
			try {
				mutate(other, "foreign");
			} catch (error) {
				interference.push(error);
			}
		});
	const fetch = vi.fn(async () => {
		armed = true;
		return reconciliationResponse();
	});
	vi.stubGlobal("fetch", fetch);
	try {
		// The real assertion runs with a competing file-backed writer ready to commit.
		const response = await post(`/api/sync/project-invites/${operationId}/reconcile`, {});
		// The writer is excluded, unchanged authority permits acceptance, and the probe ran.
		expect(response.status).toBe(200);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(commitChecks).toBe(1);
		expect(interference).toEqual([expect.objectContaining({ code: "SQLITE_BUSY" })]);
		expect(factRows("actors")).toContainEqual(
			expect.objectContaining({
				actor_id: actorId,
				is_local: 1,
				status: "active",
			}),
		);
		// Positive control: the same competing SQL can commit once reconciliation releases its lock.
		mutate(other, "foreign");
		expect(factRows("actors")).toContainEqual(
			expect.objectContaining({ actor_id: actorId, is_local: 0 }),
		);
	} finally {
		checked.mockRestore();
		other.close();
	}
});

it("rolls back same-text SQLite acceptance failure without mapping it to pending actor conflict", async () => {
	// Fail peer persistence after the nested reconciliation has written recipient/operation rows.
	pendingShare();
	fixture.store.db.exec(`CREATE TRIGGER fail_acceptance_peer BEFORE INSERT ON sync_peers
		BEGIN SELECT RAISE(ABORT, 'device_adoption_actor_conflict'); END`);
	const before = snapshot();
	const beforeKeys = keys();
	const beforeConfig = config();
	const fetch = vi.fn(async () => reconciliationResponse());
	vi.stubGlobal("fetch", fetch);
	// Maintenance preserves the actual SQL error; HTTP uses its existing failure fallback.
	const failure = await advanceProjectShareOperation(fixture.store, operationId).catch(
		(error) => error,
	);
	const response = await post(`/api/sync/project-invites/${operationId}/reconcile`, {});
	// Text alone cannot disguise a database failure or retain partial acceptance writes.
	expect(failure).toBeInstanceOf(Database.SqliteError);
	expect(failure).toMatchObject({
		message: "device_adoption_actor_conflict",
		code: "SQLITE_CONSTRAINT_TRIGGER",
	});
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "operation_reconcile_failed" });
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(snapshot()).toEqual(before);
	expect(keys()).toEqual(beforeKeys);
	expect(config()).toEqual(beforeConfig);
	// Positive control: removing only the failing trigger permits the same accepted intent to commit.
	fixture.store.db.exec("DROP TRIGGER fail_acceptance_peer");
	const retry = await post(`/api/sync/project-invites/${operationId}/reconcile`, {});
	expect(retry.status).toBe(200);
	expect(await retry.json()).toMatchObject({ reconciled: true });
});

it.each(
	states.flatMap((state) => (["claim", "merge"] as const).map((action) => ({ state, action }))),
)(
	"rechecks $state pending actor inside the actual $action write transaction",
	async ({ state, action }) => {
		// Arrange: actual enrollment skipped adoption; explicit repair leaves valid pending actors.
		pending({ valid: true });
		fixture.store.db
			.prepare(
				"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES ('other-owner', 'Other Owner', 0, 'active', ?, ?)",
			)
			.run(now, now);
		fixture.store.db
			.prepare(
				"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, actor_id, created_at) VALUES ('fixture-peer', 'Peer', 'fixture-pin', 'other-owner', ?)",
			)
			.run(now);
		const other = new Database(fixture.store.dbPath);
		const originalCheck = fixture.store.assertPendingLocalCaptureAdoptionActors.bind(fixture.store);
		let competingCommit: ReturnType<typeof snapshot> | undefined;
		let checks = 0;
		const beforeKeys = keys();
		vi.spyOn(fixture.store, "assertPendingLocalCaptureAdoptionActors").mockImplementation(() => {
			checks++;
			originalCheck();
			if (checks !== 1) return;
			queueMicrotask(() => {
				// Middleware has committed and released its lock before async route parsing resumes.
				mutate(other, state);
				competingCommit = snapshot();
			});
		});
		try {
			// Act: a real second connection commits between preflight and mutation.
			const response =
				action === "claim"
					? await post("/api/sync/peers/identity", {
							peer_device_id: "fixture-peer",
							claimed_local_actor: true,
						})
					: await post("/api/sync/actors/merge", {
							primary_actor_id: actorId,
							secondary_actor_id: "other-owner",
						});
			// Assert: only the competing commit survives; no claim, union, or adoption follows.
			expect(competingCommit).toBeDefined();
			expect(checks).toBeGreaterThanOrEqual(2);
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "device_adoption_actor_conflict" });
			expect(snapshot()).toEqual(competingCommit);
			expect(ledger().adoption).toEqual([]);
			expect(keys()).toEqual(beforeKeys);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			other.close();
		}
	},
);

it.each([...states, "configured"] as const)(
	"denies known %s pending conflict before viewer or direct-core invite work",
	async (state) => {
		// Arrange: a genuine, syntactically valid Project invite reaches actor validation.
		const target = pending({ configured: state === "configured" });
		mutate(fixture.store.db, state === "configured" ? "foreign" : state, target);
		const before = snapshot();
		const beforeKeys = keys();
		const beforeConfig = config();
		// Act: exercise both HTTP route and the core entry point used outside the viewer.
		const response = await post("/api/sync/invites/import", {
			invite,
			recipient_name: "Fixture Owner",
			device_name: "Fixture Laptop",
		});
		const result = await importCore().catch((error) => error);
		const app = syncRoutes(() => fixture.store);
		const actors = await app.request("/api/sync/actors");
		const inventory = await app.request("/api/sync/recipient-policy/v1/device-inventory");
		// Assert: known denial means zero remote requests and zero identity/config/project writes.
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "project_invite_acceptance_failed" });
		expect(result).toBeInstanceOf(Error);
		expect(result).toMatchObject({ message: "device_adoption_actor_conflict" });
		expect(actors.status).toBe(200);
		expect(inventory.status).toBe(200);
		expect(snapshot()).toEqual(before);
		expect(config()).toEqual(beforeConfig);
		expect(keys()).toEqual(beforeKeys);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it("accepts the same Project envelope and response with valid local actor authority", async () => {
	// Arrange: positive control excludes malformed invite/response as a denial explanation.
	pending({ valid: true });
	const fetch = vi.fn(async () => acceptedResponse());
	vi.stubGlobal("fetch", fetch);
	// Act.
	const result = await importCore();
	// Assert: real response validation, persistence, and local config enablement succeed.
	expect(result).toMatchObject({ sync_enabled: true });
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(ledger().adoption).toHaveLength(1);
	expect(factRows("recipient_managed_project_projections")).toEqual([
		expect.objectContaining({ recipient_identity_id: actorId, source_operation_id: operationId }),
	]);
});

it.each(states)(
	"rejects %s actor drift after an accepted remote join without local trust/config repair",
	async (state) => {
		// Arrange: real ensure skips association before an explicit concurrent fixture repair.
		pending();
		const other = new Database(fixture.store.dbPath);
		const actualEnsure = syncIdentity.ensureDeviceIdentity;
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockImplementation((db, options) => {
			const identity = actualEnsure(db, options);
			// Keep the genuine unsigned birth pending; this repair does not mint authority.
			other.prepare("UPDATE actors SET status = 'active' WHERE actor_id = ?").run(actorId);
			return identity;
		});
		let afterRemoteCommit: ReturnType<typeof snapshot> | undefined;
		const beforeConfig = config();
		const beforeKeys = keys();
		const fetch = vi.fn(async () => {
			mutate(other, state);
			afterRemoteCommit = snapshot();
			return acceptedResponse();
		});
		vi.stubGlobal("fetch", fetch);
		try {
			// Act: accepted remote work is not rolled back by local persistence rejection.
			const failure = await importCore().catch((error) => error);
			// Assert: remote request happened once; actor/projection/config writes did not follow it.
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(afterRemoteCommit).toBeDefined();
			expect(failure).toBeInstanceOf(Error);
			expect(failure).toMatchObject({ message: "device_adoption_actor_conflict" });
			expect(snapshot()).toEqual(afterRemoteCommit);
			expect(ledger().adoption).toEqual([]);
			expect(config()).toEqual(beforeConfig);
			expect(keys()).toEqual(beforeKeys);
		} finally {
			other.close();
		}
	},
);

it.each(["claim", "merge"])(
	"propagates exact-text SQLite failure from actual %s write",
	async (action) => {
		// Arrange: valid pending actors pass both real checks; only the final write fails.
		pending({ valid: true });
		fixture.store.db
			.prepare(
				"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES ('other-owner', 'Other Owner', 0, 'active', ?, ?)",
			)
			.run(now, now);
		fixture.store.db
			.prepare(
				"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, actor_id, created_at) VALUES ('fixture-peer', 'Peer', 'fixture-pin', 'other-owner', ?)",
			)
			.run(now);
		let table = "sync_peers";
		if (action === "merge") table = "actors";
		fixture.store.db.exec(`CREATE TRIGGER fail_actual_actor_write BEFORE UPDATE ON ${table}
		BEGIN SELECT RAISE(ABORT, 'device_adoption_actor_conflict'); END`);
		const before = snapshot();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		// Act: the error is a real SqliteError, not the plain pending-actor rejection.
		const response =
			action === "claim"
				? await post("/api/sync/peers/identity", {
						peer_device_id: "fixture-peer",
						claimed_local_actor: true,
					})
				: await post("/api/sync/actors/merge", {
						primary_actor_id: actorId,
						secondary_actor_id: "other-owner",
					});
		// Assert: no success/409 conversion or partial mutation follows unexpected SQL failure.
		expect(response.status).toBe(500);
		expect(errors).toHaveBeenCalledTimes(1);
		expect(errors.mock.calls[0]?.[0]).toMatchObject({
			message: "device_adoption_actor_conflict",
			code: "SQLITE_CONSTRAINT_TRIGGER",
		});
		expect(snapshot()).toEqual(before);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);
