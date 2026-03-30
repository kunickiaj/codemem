import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
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

describe("D1CoordinatorStore", () => {
	let tmpDir: string;
	let db: DatabaseType;
	let store: D1CoordinatorStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "d1-coord-test-"));
		db = connectCoordinator(join(tmpDir, "coordinator.sqlite"));
		db.exec(`
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
		store = new D1CoordinatorStore(new SqliteD1Database(db));
	});

	afterEach(async () => {
		await store.close();
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates and lists groups", async () => {
		await store.createGroup("g1", "Team Alpha");
		await store.createGroup("g2", null);
		expect(await store.getGroup("g1")).toEqual(
			expect.objectContaining({ group_id: "g1", display_name: "Team Alpha" }),
		);
		expect(await store.listGroups()).toHaveLength(2);
	});

	it("enrolls, renames, disables, and removes devices", async () => {
		await store.createGroup("g1");
		await store.enrollDevice("g1", {
			deviceId: "d1",
			fingerprint: "fp1",
			publicKey: "pk1",
			displayName: "Laptop",
		});
		expect(await store.getEnrollment("g1", "d1")).toEqual(
			expect.objectContaining({ device_id: "d1", display_name: "Laptop", fingerprint: "fp1" }),
		);
		expect(await store.renameDevice("g1", "d1", "Desktop")).toBe(true);
		expect(await store.getEnrollment("g1", "d1")).toEqual(
			expect.objectContaining({ display_name: "Desktop" }),
		);
		await store.setDeviceEnabled("g1", "d1", false);
		expect(await store.listEnrolledDevices("g1")).toEqual([]);
		expect(await store.listEnrolledDevices("g1", true)).toEqual([
			expect.objectContaining({ device_id: "d1", enabled: 0 }),
		]);
		expect(await store.removeDevice("g1", "d1")).toBe(true);
		expect(await store.listEnrolledDevices("g1", true)).toEqual([]);
	});

	it("creates and lists invites", async () => {
		await store.createGroup("g1", "Team Alpha");
		const invite = await store.createInvite({
			groupId: "g1",
			policy: "auto_admit",
			expiresAt: "2099-01-01T00:00:00Z",
			createdBy: "admin",
		});
		expect(invite.team_name_snapshot).toBe("Team Alpha");
		expect(await store.getInviteByToken(invite.token)).toEqual(
			expect.objectContaining({ invite_id: invite.invite_id, group_id: "g1" }),
		);
		expect(await store.listInvites("g1")).toHaveLength(1);
	});

	it("creates, lists, and reviews join requests", async () => {
		await store.createGroup("g1");
		const request = await store.createJoinRequest({
			groupId: "g1",
			deviceId: "d1",
			publicKey: "pk1",
			fingerprint: "fp1",
			displayName: "Laptop",
			token: "token-1",
		});
		expect(request.status).toBe("pending");
		expect(await store.listJoinRequests("g1")).toHaveLength(1);
		const approved = await store.reviewJoinRequest({
			requestId: request.request_id,
			approved: true,
			reviewedBy: "admin",
		});
		expect(approved).toEqual(expect.objectContaining({ status: "approved", reviewed_by: "admin" }));
		expect(await store.getEnrollment("g1", "d1")).toEqual(
			expect.objectContaining({ device_id: "d1", fingerprint: "fp1" }),
		);
		const again = await store.reviewJoinRequest({ requestId: request.request_id, approved: false });
		expect(again?._no_transition).toBe(true);
		expect(again?.status).toBe("approved");
	});

	it("denies a join request without enrolling the device", async () => {
		await store.createGroup("g1");
		const request = await store.createJoinRequest({
			groupId: "g1",
			deviceId: "d2",
			publicKey: "pk2",
			fingerprint: "fp2",
			token: "token-2",
		});
		const denied = await store.reviewJoinRequest({
			requestId: request.request_id,
			approved: false,
		});
		expect(denied).toEqual(expect.objectContaining({ status: "denied" }));
		expect(await store.getEnrollment("g1", "d2")).toBeNull();
	});

	it("completes reverse reciprocal approvals when both devices approve each other", async () => {
		await store.createGroup("g1");
		const first = await store.createReciprocalApproval({
			groupId: "g1",
			requestingDeviceId: "d1",
			requestedDeviceId: "d2",
		});
		expect(first.status).toBe("pending");
		expect(
			await store.listReciprocalApprovals({ groupId: "g1", deviceId: "d2", direction: "incoming" }),
		).toEqual([expect.objectContaining({ request_id: first.request_id, status: "pending" })]);
		const second = await store.createReciprocalApproval({
			groupId: "g1",
			requestingDeviceId: "d2",
			requestedDeviceId: "d1",
		});
		expect(second.status).toBe("completed");
		expect(
			await store.listReciprocalApprovals({ groupId: "g1", deviceId: "d1", direction: "incoming" }),
		).toEqual([]);
	});

	it("converges to completed when a reverse pending row appears during insert", async () => {
		const racingStore = new D1CoordinatorStore(new RacingSqliteD1Database(db));
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
	});

	it("implements nonce replay protection, presence upsert, and peer listing", async () => {
		await expect(store.recordNonce("d1", "nonce-1", "2026-03-28T00:00:00Z")).resolves.toBe(true);
		await expect(store.recordNonce("d1", "nonce-1", "2026-03-28T00:00:01Z")).resolves.toBe(false);
		await store.cleanupNonces("2026-03-28T00:00:01Z");
		await expect(store.recordNonce("d1", "nonce-1", "2026-03-28T00:00:02Z")).resolves.toBe(true);
		await store.createGroup("g1");
		await store.enrollDevice("g1", {
			deviceId: "d1",
			fingerprint: "fp1",
			publicKey: "pk1",
		});
		await store.enrollDevice("g1", {
			deviceId: "d2",
			fingerprint: "fp2",
			publicKey: "pk2",
		});
		const presence = await store.upsertPresence({
			groupId: "g1",
			deviceId: "d2",
			addresses: ["http://localhost:9001", "localhost:9001/"],
			ttlS: 60,
			capabilities: { role: "peer" },
		});
		expect(presence).toEqual(
			expect.objectContaining({
				group_id: "g1",
				device_id: "d2",
				addresses: ["http://localhost:9001"],
			}),
		);
		await expect(store.listGroupPeers("g1", "d1")).resolves.toEqual([
			expect.objectContaining({
				device_id: "d2",
				fingerprint: "fp2",
				stale: false,
				addresses: ["http://localhost:9001"],
				capabilities: { role: "peer" },
			}),
		]);
	});

	it("marks stale peers with empty addresses", async () => {
		await store.createGroup("g1");
		await store.enrollDevice("g1", {
			deviceId: "d1",
			fingerprint: "fp1",
			publicKey: "pk1",
		});
		await store.enrollDevice("g1", {
			deviceId: "d2",
			fingerprint: "fp2",
			publicKey: "pk2",
		});
		await store.upsertPresence({
			groupId: "g1",
			deviceId: "d2",
			addresses: ["http://localhost:9001"],
			ttlS: 0,
		});
		await expect(store.listGroupPeers("g1", "d1")).resolves.toEqual([
			expect.objectContaining({ device_id: "d2", stale: true, addresses: [] }),
		]);
	});
});
