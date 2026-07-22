import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { runCoordinatorStoreContract } from "./coordinator-store-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

class SqliteD1Statement implements D1PreparedStatementLike {
	private bound: unknown[] = [];

	constructor(private readonly statement: Statement) {}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bound = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return (this.statement.get(...this.bound) as T | undefined) ?? null;
	}

	async run(): Promise<unknown> {
		const result = this.statement.run(...this.bound);
		return { meta: { changes: result.changes } };
	}

	executeRunSync(): unknown {
		const result = this.statement.run(...this.bound);
		return { meta: { changes: result.changes } };
	}

	async all<T = unknown>(): Promise<{ results?: T[] }> {
		return { results: this.statement.all(...this.bound) as T[] };
	}

	async raw<T = unknown>(): Promise<T[]> {
		return this.statement.raw(true).all(...this.bound) as T[];
	}
}

class SqliteD1Database implements D1DatabaseLike {
	constructor(protected readonly db: DatabaseType) {}

	prepare(query: string): D1PreparedStatementLike {
		return new SqliteD1Statement(this.db.prepare(query));
	}

	async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
		return this.db.transaction(() => {
			const results: unknown[] = [];
			for (const statement of statements) {
				if (!(statement instanceof SqliteD1Statement)) {
					throw new Error("Unsupported D1 statement test double.");
				}
				results.push(statement.executeRunSync());
			}
			return results;
		})();
	}
}

class RacingReciprocalApprovalStatement implements D1PreparedStatementLike {
	private bound: unknown[] = [];
	private injected = false;

	constructor(
		private readonly db: DatabaseType,
		private readonly query: string,
	) {}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bound = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return (this.db.prepare(this.query).get(...this.bound) as T | undefined) ?? null;
	}

	async run(): Promise<unknown> {
		if (!this.injected) {
			this.injected = true;
			const [, groupId, requestingDeviceId, requestedDeviceId, low, high, createdAt] = this
				.bound as [string, string, string, string, string, string, string];
			this.db
				.prepare(`INSERT INTO coordinator_reciprocal_approvals(
					request_id,
					group_id,
					requesting_device_id,
					requested_device_id,
					pending_pair_low_device_id,
					pending_pair_high_device_id,
					status,
					created_at,
					resolved_at
				) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
				.run("race-existing", groupId, requestedDeviceId, requestingDeviceId, low, high, createdAt);
		}
		const result = this.db.prepare(this.query).run(...this.bound);
		return { meta: { changes: result.changes } };
	}

	async all<T = unknown>(): Promise<{ results?: T[] }> {
		return { results: this.db.prepare(this.query).all(...this.bound) as T[] };
	}

	async raw<T = unknown>(): Promise<T[]> {
		return this.db
			.prepare(this.query)
			.raw(true)
			.all(...this.bound) as T[];
	}
}

class RacingSqliteD1Database extends SqliteD1Database {
	override prepare(query: string): D1PreparedStatementLike {
		if (query.includes("INSERT INTO coordinator_reciprocal_approvals(")) {
			return new RacingReciprocalApprovalStatement(this.db, query);
		}
		return super.prepare(query);
	}
}

class FailingAuditBatchD1Database extends SqliteD1Database {
	override async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
		return this.db.transaction(() => {
			const [mutation] = statements;
			if (!(mutation instanceof SqliteD1Statement)) {
				throw new Error("Unsupported D1 statement test double.");
			}
			mutation.executeRunSync();
			throw new Error("audit insert failed");
		})();
	}
}

class FailingDeviceRemovalBatchD1Database extends SqliteD1Database {
	override async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
		return this.db.transaction(() => {
			// Run every delete except the final enrolled_devices delete, then fail
			// mid-batch so the rollback restores all three row types.
			const results: unknown[] = [];
			for (const statement of statements.slice(0, -1)) {
				if (!(statement instanceof SqliteD1Statement)) {
					throw new Error("Unsupported D1 statement test double.");
				}
				results.push(statement.executeRunSync());
			}
			throw new Error("device removal batch failed");
		})();
	}
}

class RacingRevokeBatchD1Database extends SqliteD1Database {
	private injected = false;

	override async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
		if (!this.injected) {
			this.injected = true;
			this.db
				.prepare(`UPDATE coordinator_scope_memberships
					SET status = 'revoked', membership_epoch = membership_epoch + 1, updated_at = ?
					WHERE scope_id = ? AND device_id = ?`)
				.run("2026-05-02T00:00:00.000Z", "scope-acme", "device-a");
		}
		return await super.batch(statements);
	}
}

describe("D1CoordinatorStore", () => {
	function setupStore() {
		const tmpDir = mkdtempSync(join(tmpdir(), "d1-coord-test-"));
		const db = connectCoordinator(join(tmpDir, "coordinator.sqlite"));
		db.exec(`
			DROP TABLE IF EXISTS coordinator_scope_membership_effect_receipts;
			DROP TABLE IF EXISTS coordinator_scope_membership_audit_log;
			DROP TABLE IF EXISTS coordinator_scope_memberships;
			DROP TABLE IF EXISTS coordinator_scopes;
			DROP TABLE IF EXISTS coordinator_reciprocal_approvals;
			DROP TABLE IF EXISTS coordinator_join_requests;
			DROP TABLE IF EXISTS coordinator_invites;
			DROP TABLE IF EXISTS request_nonces;
			DROP TABLE IF EXISTS presence_records;
			DROP TABLE IF EXISTS enrolled_devices;
			DROP TABLE IF EXISTS groups;
		`);
		db.exec(
			readFileSync(
				join(import.meta.dirname, "../../cloudflare-coordinator-worker/schema.sql"),
				"utf8",
			),
		);
		const store = new D1CoordinatorStore(new SqliteD1Database(db));
		return {
			store,
			db,
			cleanup: async () => {
				await store.close();
				db.close();
				rmSync(tmpDir, { recursive: true, force: true });
			},
		};
	}

	runCoordinatorStoreContract("contract", () => {
		const { store, cleanup } = setupStore();
		return { store, cleanup };
	});

	it("converges to completed when a reverse pending row appears during insert", async () => {
		const { db, cleanup } = setupStore();
		const racingStore = new D1CoordinatorStore(new RacingSqliteD1Database(db));
		try {
			await racingStore.createGroup("g1");
			const result = await racingStore.createReciprocalApproval({
				groupId: "g1",
				requestingDeviceId: "d1",
				requestedDeviceId: "d2",
			});
			expect(result).toEqual(
				expect.objectContaining({
					request_id: "race-existing",
					status: "completed",
					requesting_device_id: "d2",
					requested_device_id: "d1",
				}),
			);
			await racingStore.close();
		} finally {
			await cleanup();
		}
	});

	it("dedupes mirrored pending rows before creating the pending-pair unique index", async () => {
		const { db, cleanup } = setupStore();
		const migrationPath = join(
			import.meta.dirname,
			"../../cloudflare-coordinator-worker/migrations/0003_harden_reciprocal_approval_pending_pairs.sql",
		);
		try {
			if (!existsSync(migrationPath)) {
				throw new Error(`missing migration fixture: ${migrationPath}`);
			}
			db.exec("DROP TABLE IF EXISTS coordinator_reciprocal_approvals");
			db.exec(`
				CREATE TABLE coordinator_reciprocal_approvals (
					request_id TEXT PRIMARY KEY,
					group_id TEXT NOT NULL,
					requesting_device_id TEXT NOT NULL,
					requested_device_id TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					resolved_at TEXT
				)
			`);
			db.prepare(
				`INSERT INTO coordinator_reciprocal_approvals(
					request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run("req-a", "g1", "d1", "d2", "pending", "2026-03-29T00:00:00Z", null);
			db.prepare(
				`INSERT INTO coordinator_reciprocal_approvals(
					request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run("req-b", "g1", "d2", "d1", "pending", "2026-03-29T00:00:01Z", null);

			db.exec(readFileSync(migrationPath, "utf8"));

			const migratedRows = db
				.prepare(
					`SELECT request_id, status, pending_pair_low_device_id, pending_pair_high_device_id, resolved_at
					 FROM coordinator_reciprocal_approvals ORDER BY request_id ASC`,
				)
				.all() as Array<Record<string, unknown>>;
			expect(migratedRows).toEqual([
				expect.objectContaining({
					request_id: "req-a",
					status: "completed",
					pending_pair_low_device_id: "d1",
					pending_pair_high_device_id: "d2",
					resolved_at: "2026-03-29T00:00:00Z",
				}),
				expect.objectContaining({
					request_id: "req-b",
					status: "completed",
					pending_pair_low_device_id: "d1",
					pending_pair_high_device_id: "d2",
					resolved_at: "2026-03-29T00:00:01Z",
				}),
			]);
			const indexInfo = db
				.prepare(`PRAGMA index_list('coordinator_reciprocal_approvals')`)
				.all() as Array<Record<string, unknown>>;
			expect(indexInfo).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "idx_coordinator_reciprocal_pending_pair", unique: 1 }),
				]),
			);
		} finally {
			await cleanup();
		}
	});

	it("normalizes and validates bootstrap grant input consistently", async () => {
		const { store, cleanup } = setupStore();
		try {
			const grant = await store.createBootstrapGrant({
				groupId: " g1 ",
				seedDeviceId: " seed-1 ",
				workerDeviceId: " worker-1 ",
				expiresAt: " 2099-01-01T00:00:00Z ",
				createdBy: " admin ",
			});
			expect(grant).toEqual(
				expect.objectContaining({
					group_id: "g1",
					seed_device_id: "seed-1",
					worker_device_id: "worker-1",
					expires_at: "2099-01-01T00:00:00Z",
					created_by: "admin",
				}),
			);

			await expect(
				store.createBootstrapGrant({
					groupId: "   ",
					seedDeviceId: "seed-1",
					workerDeviceId: "worker-1",
					expiresAt: "2099-01-01T00:00:00Z",
				}),
			).rejects.toThrow("groupId, seedDeviceId, workerDeviceId, and expiresAt are required.");
		} finally {
			await cleanup();
		}
	});

	it("rolls back D1 membership changes when the audit batch fails", async () => {
		const { db, cleanup } = setupStore();
		const normalStore = new D1CoordinatorStore(new SqliteD1Database(db));
		const failingStore = new D1CoordinatorStore(new FailingAuditBatchD1Database(db));
		try {
			await normalStore.createGroup("group-a");
			await normalStore.enrollDevice("group-a", {
				deviceId: "device-a",
				fingerprint: "fp-a",
				publicKey: "pk-a",
			});
			await normalStore.createScope({
				scopeId: "scope-acme",
				label: "Acme Work",
				groupId: "group-a",
			});

			await expect(
				failingStore.grantScopeMembership({
					effectId: "d1:failed-audit:grant",
					scopeId: "scope-acme",
					deviceId: "device-a",
				}),
			).rejects.toThrow("audit insert failed");
			expect(await normalStore.listScopeMemberships("scope-acme", true)).toEqual([]);

			await normalStore.grantScopeMembership({
				effectId: "d1:failed-audit:baseline-grant",
				scopeId: "scope-acme",
				deviceId: "device-a",
			});
			await expect(
				failingStore.revokeScopeMembership({
					effectId: "d1:failed-audit:revoke",
					scopeId: "scope-acme",
					deviceId: "device-a",
				}),
			).rejects.toThrow("audit insert failed");
			expect(await normalStore.listScopeMemberships("scope-acme", true)).toEqual([
				expect.objectContaining({ device_id: "device-a", status: "active" }),
			]);
			expect(await normalStore.listScopeMembershipAuditEvents({ scopeId: "scope-acme" })).toEqual([
				expect.objectContaining({ action: "grant", device_id: "device-a" }),
			]);
		} finally {
			await failingStore.close();
			await normalStore.close();
			await cleanup();
		}
	});

	it("returns false without audit when D1 revoke loses the guarded update race", async () => {
		const { db, cleanup } = setupStore();
		const normalStore = new D1CoordinatorStore(new SqliteD1Database(db));
		const racingStore = new D1CoordinatorStore(new RacingRevokeBatchD1Database(db));
		try {
			await normalStore.createGroup("group-a");
			await normalStore.enrollDevice("group-a", {
				deviceId: "device-a",
				fingerprint: "fp-a",
				publicKey: "pk-a",
			});
			await normalStore.createScope({
				scopeId: "scope-acme",
				label: "Acme Work",
				groupId: "group-a",
			});
			await normalStore.grantScopeMembership({
				effectId: "d1:race:baseline-grant",
				scopeId: "scope-acme",
				deviceId: "device-a",
			});
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"));

			await expect(
				racingStore.revokeScopeMembership({
					effectId: "d1:race:revoke",
					scopeId: "scope-acme",
					deviceId: "device-a",
				}),
			).resolves.toBe(false);
			vi.useRealTimers();

			expect(await normalStore.listScopeMemberships("scope-acme", true)).toEqual([
				expect.objectContaining({
					device_id: "device-a",
					status: "revoked",
					membership_epoch: 1,
				}),
			]);
			expect(await normalStore.listScopeMembershipAuditEvents({ scopeId: "scope-acme" })).toEqual([
				expect.objectContaining({ action: "grant", device_id: "device-a" }),
			]);
		} finally {
			vi.useRealTimers();
			await racingStore.close();
			await normalStore.close();
			await cleanup();
		}
	});

	it("converges concurrent identical D1 effects to one receipt and one audit event", async () => {
		const { db, cleanup } = setupStore();
		const firstStore = new D1CoordinatorStore(new SqliteD1Database(db));
		const secondStore = new D1CoordinatorStore(new SqliteD1Database(db));
		try {
			await firstStore.createScope({ scopeId: "scope-effect-race", label: "Effect race" });
			const request = {
				effectId: "d1:effect-race:grant",
				scopeId: "scope-effect-race",
				deviceId: "device-a",
				membershipEpoch: 3,
			};

			const [first, second] = await Promise.all([
				firstStore.grantScopeMembership(request),
				secondStore.grantScopeMembership(request),
			]);

			expect(second).toEqual(first);
			expect(
				await firstStore.listScopeMembershipAuditEvents({ scopeId: "scope-effect-race" }),
			).toEqual([expect.objectContaining({ effect_id: request.effectId, membership_epoch: 3 })]);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM coordinator_scope_membership_effect_receipts WHERE effect_id = ?",
					)
					.get(request.effectId),
			).toEqual({ count: 1 });
		} finally {
			await secondStore.close();
			await firstStore.close();
			await cleanup();
		}
	});

	it("removes presence, reciprocal approvals, and enrollment atomically", async () => {
		const { db, cleanup } = setupStore();
		const store = new D1CoordinatorStore(new SqliteD1Database(db));
		try {
			await store.createGroup("g1");
			await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
			await store.enrollDevice("g1", { deviceId: "d2", fingerprint: "fp2", publicKey: "pk2" });
			await store.upsertPresence({
				groupId: "g1",
				deviceId: "d1",
				addresses: ["http://localhost:9000"],
				ttlS: 300,
			});
			await store.createReciprocalApproval({
				groupId: "g1",
				requestingDeviceId: "d1",
				requestedDeviceId: "d2",
			});

			expect(await store.removeDevice("g1", "d1")).toBe(true);

			expect(await store.getEnrollment("g1", "d1")).toBeNull();
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM presence_records WHERE group_id = ? AND device_id = ?",
					)
					.get("g1", "d1"),
			).toEqual({ n: 0 });
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM coordinator_reciprocal_approvals WHERE group_id = ? AND (requesting_device_id = ? OR requested_device_id = ?)",
					)
					.get("g1", "d1", "d1"),
			).toEqual({ n: 0 });
		} finally {
			await store.close();
			await cleanup();
		}
	});

	it("returns false when removing a non-existent device", async () => {
		const { db, cleanup } = setupStore();
		const store = new D1CoordinatorStore(new SqliteD1Database(db));
		try {
			await store.createGroup("g1");
			expect(await store.removeDevice("g1", "ghost")).toBe(false);
		} finally {
			await store.close();
			await cleanup();
		}
	});

	it("leaves no partial deletion when the device removal batch fails mid-way", async () => {
		const { db, cleanup } = setupStore();
		const normalStore = new D1CoordinatorStore(new SqliteD1Database(db));
		const failingStore = new D1CoordinatorStore(new FailingDeviceRemovalBatchD1Database(db));
		try {
			await normalStore.createGroup("g1");
			await normalStore.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			await normalStore.enrollDevice("g1", {
				deviceId: "d2",
				fingerprint: "fp2",
				publicKey: "pk2",
			});
			await normalStore.upsertPresence({
				groupId: "g1",
				deviceId: "d1",
				addresses: ["http://localhost:9000"],
				ttlS: 300,
			});
			await normalStore.createReciprocalApproval({
				groupId: "g1",
				requestingDeviceId: "d1",
				requestedDeviceId: "d2",
			});

			await expect(failingStore.removeDevice("g1", "d1")).rejects.toThrow(
				"device removal batch failed",
			);

			// All-or-nothing: the enrollment, presence, and reciprocal approval rows
			// must all survive the rolled-back batch.
			expect(await normalStore.getEnrollment("g1", "d1")).not.toBeNull();
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM presence_records WHERE group_id = ? AND device_id = ?",
					)
					.get("g1", "d1"),
			).toEqual({ n: 1 });
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM coordinator_reciprocal_approvals WHERE group_id = ? AND (requesting_device_id = ? OR requested_device_id = ?)",
					)
					.get("g1", "d1", "d1"),
			).toEqual({ n: 1 });
		} finally {
			await failingStore.close();
			await normalStore.close();
			await cleanup();
		}
	});

	it("stores a non-canonical invite expiry in canonical UTC form", async () => {
		const { store, cleanup } = setupStore();
		try {
			await store.createGroup("g1", "Team Alpha");
			const offsetInvite = await store.createInvite({
				groupId: "g1",
				policy: "auto_admit",
				expiresAt: "2099-07-01T00:00:00+00:00",
			});
			expect(offsetInvite.expires_at).toBe("2099-07-01T00:00:00.000Z");

			const dateOnlyInvite = await store.createInvite({
				groupId: "g1",
				policy: "auto_admit",
				expiresAt: "2099-07-01",
			});
			expect(dateOnlyInvite.expires_at).toBe("2099-07-01T00:00:00.000Z");
		} finally {
			await cleanup();
		}
	});

	it("rejects an unparseable invite expiry", async () => {
		const { store, cleanup } = setupStore();
		try {
			await store.createGroup("g1");
			await expect(
				store.createInvite({ groupId: "g1", policy: "auto_admit", expiresAt: "not-a-date" }),
			).rejects.toThrow("expiresAt must be a valid date.");
			await expect(
				store.createInvite({ groupId: "g1", policy: "auto_admit", expiresAt: "   " }),
			).rejects.toThrow("expiresAt must be a valid date.");
		} finally {
			await cleanup();
		}
	});

	it("excludes expired invites and includes unexpired ones by token", async () => {
		const { store, cleanup } = setupStore();
		try {
			await store.createGroup("g1");
			const liveInvite = await store.createInvite({
				groupId: "g1",
				policy: "auto_admit",
				// Future, supplied with a non-canonical offset to confirm the stored
				// canonical form compares correctly against nowISO().
				expiresAt: "2099-01-01T00:00:00+00:00",
			});
			expect(await store.getInviteByToken(liveInvite.token as string)).not.toBeNull();

			const expiredInvite = await store.createInvite({
				groupId: "g1",
				policy: "auto_admit",
				expiresAt: "2000-01-01T00:00:00+00:00",
			});
			expect(await store.getInviteByToken(expiredInvite.token as string)).toBeNull();
		} finally {
			await cleanup();
		}
	});
});
