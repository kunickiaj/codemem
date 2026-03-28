import { mkdtempSync, rmSync } from "node:fs";
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

	async all<T = unknown>(): Promise<{ results?: T[] }> {
		return { results: this.statement.all(...this.bound) as T[] };
	}

	async raw<T = unknown>(): Promise<T[]> {
		return this.statement.raw(true).all(...this.bound) as T[];
	}
}

class SqliteD1Database implements D1DatabaseLike {
	constructor(private readonly db: DatabaseType) {}

	prepare(query: string): D1PreparedStatementLike {
		return new SqliteD1Statement(this.db.prepare(query));
	}
}

describe("D1CoordinatorStore", () => {
	let tmpDir: string;
	let db: DatabaseType;
	let store: D1CoordinatorStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "d1-coord-test-"));
		db = connectCoordinator(join(tmpDir, "coordinator.sqlite"));
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

	it("still throws for unimplemented presence and nonce operations", async () => {
		await expect(store.recordNonce("d1", "nonce-1", "2026-03-28T00:00:00Z")).rejects.toThrow(
			"D1CoordinatorStore.recordNonce is not implemented yet.",
		);
		await expect(store.cleanupNonces("2026-03-28T00:00:00Z")).rejects.toThrow(
			"D1CoordinatorStore.cleanupNonces is not implemented yet.",
		);
		await expect(
			store.upsertPresence({ groupId: "g1", deviceId: "d1", addresses: [], ttlS: 60 }),
		).rejects.toThrow("D1CoordinatorStore.upsertPresence is not implemented yet.");
		await expect(store.listGroupPeers("g1", "d1")).rejects.toThrow(
			"D1CoordinatorStore.listGroupPeers is not implemented yet.",
		);
	});
});
