import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDeviceIdentity, loadRuntimeSigningPublicKey, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	enrollFixtureSigningKey,
	refreshManagedScopeFixture,
} from "../../core/src/managed-scope-test-fixtures.js";
import { hasMatchingLocalCreation } from "../../core/src/memory-creation-provenance.js";
import { localCreationSourceIds } from "../../core/src/memory-local-capture.js";
import {
	now,
	scopeId,
	useLocalCaptureFixture,
} from "../../core/src/memory-local-capture-test-fixtures.js";
import { syncRoutes } from "./routes/sync.js";

const { fixture, rememberScoped, row, binding, factRows, ledger } = useLocalCaptureFixture();
const deviceId = "capture-device";
const destinationActor = `local:${deviceId}`;
const staleActor = "local:stale-device";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(now));
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
	fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), {
		keysDir: fixture.keysDir,
	});
}

function ensure() {
	return ensureDeviceIdentity(fixture.store.db, { keysDir: fixture.keysDir, deviceId });
}

function keyBytes() {
	return {
		private: readFileSync(join(fixture.keysDir, "device.key")),
		public: readFileSync(join(fixture.keysDir, "device.key.pub")),
	};
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
		].map((table) => [table, factRows(table)]),
	);
}

function insertActor(options: {
	actorId: string;
	isLocal: number;
	status?: string;
	mergedInto?: string | null;
}) {
	fixture.store.db
		.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status,
			merged_into_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
		.run(
			options.actorId,
			`Original ${options.actorId}`,
			options.isLocal,
			options.status ?? "active",
			options.mergedInto ?? null,
			now,
			now,
		);
}

function getActors() {
	return syncRoutes(() => fixture.store).request("/api/sync/actors?includeMerged=true");
}

function post(path: string, body: Record<string, unknown>) {
	return syncRoutes(() => fixture.store).request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function insertPeer(actorId: string | null) {
	fixture.store.db
		.prepare(`INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint,
			actor_id, created_at) VALUES ('fixture-peer', 'Fixture peer', 'fixture-pin', ?, ?)`)
		.run(actorId, now);
}

function assertNoCaptureAuthority(id: number) {
	const publicKey = loadRuntimeSigningPublicKey(fixture.store.db, {
		deviceId,
		keysDir: fixture.keysDir,
	});
	expect(publicKey).not.toBeNull();
	const sources = localCreationSourceIds(fixture.store.db, deviceId, {
		expectedPublicKey: publicKey ?? undefined,
	});
	expect(sources).not.toContain(binding(id)?.sourceDeviceId);
	expect(hasMatchingLocalCreation(fixture.store.db, String(row(id).import_key), sources)).toBe(
		false,
	);
	expect(ledger().adoption).toEqual([]);
}

const conflicts = [
	{ name: "foreign destination", actorId: destinationActor, isLocal: 0 },
	{ name: "foreign fallback", actorId: "local:local", isLocal: 0 },
	{ name: "configured foreign", actorId: "configured-foreign", isLocal: 0, configured: true },
	{ name: "inactive candidate", actorId: destinationActor, isLocal: 1, status: "inactive" },
	{
		name: "merged candidate",
		actorId: destinationActor,
		isLocal: 1,
		status: "merged",
		mergedInto: "different-owner",
	},
	{
		name: "active candidate with merge target",
		actorId: destinationActor,
		isLocal: 1,
		status: "active",
		mergedInto: "different-owner",
	},
] as const;

it.each(conflicts)(
	"preserves pending capture and all actors after restart GET/retry for $name",
	async (conflict) => {
		// Arrange: capture and conflict both precede actual verified enrollment.
		if ("configured" in conflict) {
			vi.stubEnv("CODEMEM_ACTOR_ID", conflict.actorId);
			reopen();
		}
		const id = rememberScoped();
		const original = row(id);
		const unsigned = ledger();
		expect(unsigned.birth).toHaveLength(1);
		expect(unsigned.adoption).toEqual([]);
		insertActor(conflict);
		insertActor({ actorId: staleActor, isLocal: 1 });
		const actors = factRows("actors");
		const publicKey = enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
		expect(ledger()).toEqual(unsigned);
		expect(factRows("actors")).toEqual(actors);
		expect(factRows("sync_device")).toEqual([
			expect.objectContaining({ device_id: deviceId, public_key: publicKey }),
		]);
		const before = snapshot();
		const keys = keyBytes();

		// Act: constructor and reads cannot write actors or erase enrollment denial.
		reopen();
		expect(fixture.store.deviceId).toBe(deviceId);
		fixture.store.db.pragma("query_only = ON");
		try {
			expect(() => fixture.store.assertPendingLocalCaptureAdoptionActors()).toThrow(
				"device_adoption_actor_conflict",
			);
		} finally {
			fixture.store.db.pragma("query_only = OFF");
		}
		expect(snapshot()).toEqual(before);

		expect(fixture.store.get(id)).toBeNull();
		expect(snapshot()).toEqual(before);
		const response = await getActors();
		expect(response.status).toBe(200);
		expect(snapshot()).toEqual(before);
		const retry = ensure();
		expect(retry[0]).toBe(deviceId);
		expect(snapshot()).toEqual(before);
		reopen();
		const repeat = await getActors();

		// Assert: no relabel, stale demotion, adoption, source rewrite, or key repair.
		expect(repeat.status).toBe(200);
		expect(snapshot()).toEqual(before);
		expect(row(id)).toEqual(original);
		assertNoCaptureAuthority(id);
		expect(fixture.store.get(id)).toBeNull();
		expect(keyBytes()).toEqual(keys);
		expect(globalThis.fetch).not.toHaveBeenCalled();

		// Positive/negative read control: only a current managed grant permits reading.
		await refreshManagedScopeFixture(fixture.store.db, {
			keysDir: fixture.keysDir,
			deviceId,
			scopeIds: [scopeId],
		});
		reopen();
		expect(fixture.store.get(id)?.id).toBe(id);
		fixture.store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		expect(fixture.store.get(id)).toBeNull();
		assertNoCaptureAuthority(id);
		expect(snapshot()).toEqual(before);
		expect(keyBytes()).toEqual(keys);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it.each(["fallback", "configured"])(
	"adopts genuine capture and preserves normal stale demotion for valid %s actor",
	async (mode) => {
		// Arrange: legitimate local actors are not conflicts.
		let actorId = destinationActor;
		if (mode === "configured") {
			actorId = "configured-owner";
			vi.stubEnv("CODEMEM_ACTOR_ID", actorId);
			reopen();
		}
		const id = rememberScoped();
		const original = row(id);
		const unsigned = ledger();
		insertActor({ actorId, isLocal: 1 });
		insertActor({ actorId: staleActor, isLocal: 1 });
		const actors = factRows("actors") as { actor_id: string; is_local: number }[];

		// Act: real enrollment adopts, while viewer GET still normalizes stale rows.
		enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
		const adopted = ledger();
		const keys = keyBytes();
		reopen();
		expect(factRows("actors")).toEqual(actors);
		expect(fixture.store.get(id)?.id).toBe(id);
		expect(fixture.store.getForMutation(id)).toBeNull();
		const response = await getActors();
		const normalized = snapshot();
		const repeat = await getActors();
		ensure();
		reopen();

		// Assert: exactly the stale actor is demoted; birth/source facts are immutable.
		expect(response.status).toBe(200);
		expect(repeat.status).toBe(200);
		expect(factRows("actors")).toEqual(
			actors.map((actor) => {
				if (actor.actor_id === staleActor) return { ...actor, is_local: 0 };
				return actor;
			}),
		);
		expect(snapshot()).toEqual(normalized);
		expect(adopted.adoption).toHaveLength(1);
		expect(adopted.birth).toEqual(unsigned.birth);
		expect(adopted.bindings).toEqual(unsigned.bindings);
		expect(ledger()).toEqual(adopted);
		expect(row(id)).toEqual(original);
		expect(keyBytes()).toEqual(keys);
		const publicKey = loadRuntimeSigningPublicKey(fixture.store.db, {
			deviceId,
			keysDir: fixture.keysDir,
		});
		const sources = localCreationSourceIds(fixture.store.db, deviceId, {
			expectedPublicKey: publicKey ?? undefined,
		});
		expect(sources).toContain(binding(id)?.sourceDeviceId);
		expect(fixture.store.get(id)?.id).toBe(id);
		expect(fixture.store.getForMutation(id)).toBeNull();
		await refreshManagedScopeFixture(fixture.store.db, {
			keysDir: fixture.keysDir,
			deviceId,
			scopeIds: [scopeId],
		});
		expect(fixture.store.get(id)?.id).toBe(id);
		fixture.store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		expect(fixture.store.get(id)?.id).toBe(id);
		expect(fixture.store.getForMutation(id)).toBeNull();
		expect(snapshot()).toEqual(normalized);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it.each([
	"unexpected_actor_sql",
	"device_adoption_actor_conflict",
	"device_adoption_actor_conflict_extra",
])("returns 500 and rolls back stale demotion on SQLite promotion failure %s", async (failure) => {
	// Arrange: enrollment has no capture conflict; a real trigger fails only viewer promotion.
	const id = rememberScoped();
	enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
	insertActor({ actorId: destinationActor, isLocal: 0 });
	insertActor({ actorId: staleActor, isLocal: 1 });
	reopen();
	fixture.store.db.exec(`CREATE TRIGGER fail_actor_promotion BEFORE UPDATE OF is_local ON actors
			WHEN NEW.actor_id = '${destinationActor}' AND NEW.is_local = 1
			BEGIN SELECT RAISE(ABORT, '${failure}'); END;`);
	const before = snapshot();
	const keys = keyBytes();
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});

	// Act: Hono's actual error handler must receive SQLite errors, even exact conflict text.
	const response = await getActors();
	reopen();

	// Assert: unexpected failure cannot become success or partially demote stale actors.
	expect(response.status).toBe(500);
	expect(await response.text()).toBe("Internal Server Error");
	expect(errors).toHaveBeenCalledTimes(1);
	const error = errors.mock.calls[0]?.[0];
	expect(error).toBeInstanceOf(Error);
	expect(error).toMatchObject({ message: failure, code: "SQLITE_CONSTRAINT_TRIGGER" });
	expect(snapshot()).toEqual(before);
	expect(keyBytes()).toEqual(keys);
	expect(fixture.store.get(id)?.id).toBe(id);
	expect(fixture.store.getForMutation(id)).toBeNull();
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("does not partially demote actors when another WAL connection holds the write reservation", async () => {
	// Arrange: deterministic reserved lock, no sleeps or retries.
	rememberScoped();
	enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
	insertActor({ actorId: staleActor, isLocal: 1 });
	reopen();
	fixture.store.db.pragma("journal_mode = WAL");
	fixture.store.db.pragma("busy_timeout = 0");
	const other = new Database(fixture.store.dbPath);
	const before = snapshot();
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		other.exec("BEGIN IMMEDIATE");
		// Act: contention must propagate rather than skip actor initialization as a conflict.
		const response = await getActors();
		// Assert: neither connection sees an intermediate demotion or local actor insert.
		expect(response.status).toBe(500);
		expect(errors).toHaveBeenCalledTimes(1);
		expect(errors.mock.calls[0]?.[0]).toMatchObject({ code: "SQLITE_BUSY" });
		expect(snapshot()).toEqual(before);
		expect(other.prepare("SELECT * FROM actors ORDER BY 1").all()).toEqual(before.actors);
	} finally {
		other.exec("ROLLBACK");
		other.close();
	}
	// Positive control: the same GET succeeds immediately after releasing the reservation.
	const response = await getActors();
	expect(response.status).toBe(200);
	expect(factRows("actors")).toEqual([
		expect.objectContaining({ actor_id: destinationActor, is_local: 1 }),
		expect.objectContaining({ actor_id: staleActor, is_local: 0 }),
	]);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("holds the WAL write reservation before checking pending capture actors", async () => {
	// Arrange: actual enrollment left genuine pending capture due to an inactive candidate.
	rememberScoped();
	insertActor({ actorId: destinationActor, isLocal: 1, status: "inactive" });
	enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
	expect(ledger().adoption).toEqual([]);
	// Explicit fixture repair removes the conflict, but does not mint an adoption fact.
	fixture.store.db
		.prepare("UPDATE actors SET status = 'active' WHERE actor_id = ?")
		.run(destinationActor);
	reopen();
	fixture.store.db.pragma("journal_mode = WAL");
	const other = new Database(fixture.store.dbPath);
	other.pragma("busy_timeout = 0");
	const before = snapshot();
	const check = fixture.store.assertPendingLocalCaptureAdoptionActors.bind(fixture.store);
	const interference: unknown[] = [];
	const checked = vi
		.spyOn(fixture.store, "assertPendingLocalCaptureAdoptionActors")
		.mockImplementation(() => {
			// Run the real readonly check, then attempt a competing commit in its read/write gap.
			check();
			try {
				other.prepare("UPDATE actors SET is_local = 0 WHERE actor_id = ?").run(destinationActor);
			} catch (error) {
				interference.push(error);
			}
		});
	try {
		// Act: initialization must reserve the writer before its real assertion runs.
		const response = await getActors();
		// Assert: a competing connection cannot change ownership between check and write.
		expect(response.status).toBe(200);
		expect(checked).toHaveBeenCalledTimes(1);
		expect(interference).toEqual([expect.objectContaining({ code: "SQLITE_BUSY" })]);
		expect(snapshot()).toEqual(before);
		expect(other.prepare("SELECT * FROM actors ORDER BY 1").all()).toEqual(before.actors);
	} finally {
		checked.mockRestore();
		other.close();
	}
	// Positive control: unchanged ownership still permits actual enrollment retry adoption.
	ensure();
	expect(ledger().adoption).toHaveLength(1);
	expect(factRows("actors")).toEqual(before.actors);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each(["claim without actor id", "merge current secondary", "merge configured current primary"])(
	"denies %s before pending foreign actor ownership can be united",
	async (hazard) => {
		// Arrange: actual enrollment must preserve the original foreign active actor conflict.
		let foreignActorId = destinationActor;
		let otherActorId = "other-owner";
		if (hazard === "merge configured current primary") {
			foreignActorId = "configured-foreign";
			otherActorId = "local:local";
			vi.stubEnv("CODEMEM_ACTOR_ID", foreignActorId);
			reopen();
		}
		const id = rememberScoped();
		insertActor({ actorId: foreignActorId, isLocal: 0 });
		insertActor({ actorId: otherActorId, isLocal: 1 });
		insertActor({ actorId: staleActor, isLocal: 1 });
		insertPeer(foreignActorId);
		fixture.store.db
			.prepare(`INSERT INTO project_recipients(canonical_project_identity, recipient_kind,
				recipient_id, status, provenance, policy_revision, migration_state,
				idempotency_key, created_at, updated_at)
				VALUES ('fixture-project', 'identity', ?, 'active', 'user', 'r1',
				'user_managed', 'fixture-recipient', ?, ?)`)
			.run(foreignActorId, now, now);
		enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
		expect(ledger().adoption).toEqual([]);
		reopen();
		expect(fixture.store.actorId).toBe(foreignActorId);
		const before = snapshot();
		const keys = keyBytes();
		let path = "/api/sync/actors/merge";
		let body: Record<string, unknown> = {
			primary_actor_id: otherActorId,
			secondary_actor_id: foreignActorId,
		};
		if (hazard === "claim without actor id") {
			path = "/api/sync/peers/identity";
			body = { peer_device_id: "fixture-peer", claimed_local_actor: true };
		} else if (hazard === "merge configured current primary") {
			body = { primary_actor_id: foreignActorId, secondary_actor_id: otherActorId };
		}

		// Act: requests must stop before peer claims, merges, policy writes, or demotion.
		const response = await post(path, body);
		ensure();
		reopen();
		const actorsResponse = await getActors();

		// Assert: conflict survives denial, enrollment retry, constructor, and usable GET.
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "device_adoption_actor_conflict" });
		expect(actorsResponse.status).toBe(200);
		expect(snapshot()).toEqual(before);
		assertNoCaptureAuthority(id);
		expect(fixture.store.get(id)).toBeNull();
		expect(keyBytes()).toEqual(keys);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it("allows valid local peer claim and remote merge while rejecting own-canonical secondary merge", async () => {
	// Arrange: the same APIs remain usable after genuine successful capture adoption.
	rememberScoped();
	enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
	reopen();
	await getActors();
	insertActor({ actorId: "other-owner", isLocal: 0 });
	insertPeer(null);
	const before = snapshot();

	// Act: this device's own canonical actor can never be merged away as secondary.
	const denied = await post("/api/sync/actors/merge", {
		primary_actor_id: "other-owner",
		secondary_actor_id: destinationActor,
	});
	// Assert: canonical protection remains unchanged, including no policy/source writes.
	expect(denied.status).toBe(409);
	expect(await denied.json()).toEqual({ error: "cannot merge this device's own local actor" });
	expect(snapshot()).toEqual(before);

	// Act: a valid claim uses the canonical actor, and a remote secondary can merge into it.
	const claimed = await post("/api/sync/peers/identity", {
		peer_device_id: "fixture-peer",
		claimed_local_actor: true,
	});
	const merged = await post("/api/sync/actors/merge", {
		primary_actor_id: destinationActor,
		secondary_actor_id: "other-owner",
	});
	// Assert: successful operations never add or rewrite capture adoption facts.
	expect(claimed.status).toBe(200);
	expect(await claimed.json()).toEqual({
		ok: true,
		actor_id: destinationActor,
		claimed_local_actor: true,
	});
	expect(merged.status).toBe(200);
	expect(factRows("actors")).toContainEqual(
		expect.objectContaining({
			actor_id: "other-owner",
			status: "merged",
			merged_into_actor_id: destinationActor,
		}),
	);
	for (const table of [
		"memory_items",
		"memory_local_capture",
		"memory_local_capture_adoption",
		"memory_source_bindings",
		"memory_local_creation_snapshots",
		"sync_device",
	]) {
		expect(factRows(table)).toEqual(before[table]);
	}
	expect(globalThis.fetch).not.toHaveBeenCalled();
});
