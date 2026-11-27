import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { type Backend, sqliteD1, workerSchemaSql } from "./coordinator-auth-store-test-fixtures.js";
import { INVITE_TOKEN_DIGESTS_PATH } from "./coordinator-invite-token-route.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

const GROUP_ID = "digest-group";
const digestOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A coordinator file and a store on it that counts the statements it runs. */
function coordinator(backend: Backend) {
	const dir = mkdtempSync(join(tmpdir(), "codemem-invite-digest-"));
	const path = join(dir, "coordinator.sqlite");
	const statements = { count: 0 };
	let store: CoordinatorStore;
	let db: InstanceType<typeof Database>;
	if (backend === "D1") {
		db = new Database(path);
		db.exec(workerSchemaSql());
		const count = () => {
			statements.count += 1;
		};
		store = new D1CoordinatorStore(sqliteD1(db, { beforeRead: count, beforeWrite: count }));
	} else {
		const sqlite = new BetterSqliteCoordinatorStore(path);
		db = sqlite.db;
		const prepare = db.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			statements.count += 1;
			return prepare(sql);
		});
		store = sqlite;
	}
	cleanups.push(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const invites = () => db.prepare("SELECT * FROM coordinator_invites ORDER BY invite_id").all();
	const row = (inviteId: string) =>
		db
			.prepare("SELECT token, token_digest FROM coordinator_invites WHERE invite_id = ?")
			.get(inviteId) as { token: string; token_digest: string | null };
	/** Puts a row back in the shape it had before token digests. */
	const setToken = (inviteId: string, token: string, digest: string | null = null) =>
		db
			.prepare("UPDATE coordinator_invites SET token = ?, token_digest = ? WHERE invite_id = ?")
			.run(token, digest, inviteId);
	return { store, db, path, statements, invites, row, setToken };
}

async function enrollmentInvite(store: CoordinatorStore) {
	if (!(await store.getGroup(GROUP_ID))) await store.createGroup(GROUP_ID, "Team");
	return store.createInvite({
		groupId: GROUP_ID,
		policy: "approval_required",
		expiresAt: "2099-01-01T00:00:00Z",
	});
}

function joinRequest(store: CoordinatorStore, token: string, deviceId: string) {
	return store.createJoinRequest({
		groupId: GROUP_ID,
		deviceId,
		publicKey: `public-key-${deviceId}`,
		fingerprint: `fingerprint-${deviceId}`,
		token,
	});
}

describe.each<Backend>(["SQLite", "D1"])("%s invitation token lookups", (backend) => {
	it("matches a presented token by its digest only, never by the stored token value", async () => {
		// Arrange
		const c = coordinator(backend);
		const invite = await enrollmentInvite(c.store);
		const stale = await enrollmentInvite(c.store);
		// A stored value whose digest belongs to a different token.
		c.setToken(stale.invite_id, "stale-plaintext", digestOf("another-token"));
		// Act and assert
		expect((await c.store.getInviteByToken(invite.token))?.invite_id).toBe(invite.invite_id);
		expect(await c.store.getInviteByToken("stale-plaintext")).toBeNull();
		expect(await c.store.getInviteByTokenForInspection("stale-plaintext")).toBeNull();
		expect(await c.store.getInviteByTokenForInspection(`consumed:${invite.invite_id}`)).toBeNull();
	});

	it("writes nothing on lookups that miss, even with rows from before token digests", async () => {
		// Arrange
		const c = coordinator(backend);
		const legacy = await enrollmentInvite(c.store);
		c.setToken(legacy.invite_id, "legacy-token");
		const before = c.invites();
		// Act: concurrent anonymous misses, including the legacy row's own token.
		const results = await Promise.all(
			[
				...Array.from({ length: 20 }, () => randomBytes(24).toString("base64url")),
				"legacy-token",
			].map((token) => c.store.getInviteByTokenForInspection(token)),
		);
		// Assert
		expect(results.every((result) => result === null)).toBe(true);
		expect(c.invites()).toEqual(before);
	});

	it("backfills digests and join request copies in bounded batches of constant statements", async () => {
		// Arrange: more rows in both tables than one batch takes.
		const c = coordinator(backend);
		const legacy: Array<[string, string]> = [];
		for (let index = 0; index < 105; index += 1) {
			const invite = await enrollmentInvite(c.store);
			const token = `legacy-token-${index}`;
			c.setToken(invite.invite_id, token);
			legacy.push([invite.invite_id, token]);
			const request = await joinRequest(c.store, invite.token, `joiner-${index}`);
			c.db
				.prepare("UPDATE coordinator_join_requests SET token = ? WHERE request_id = ?")
				.run(token, request.request_id);
		}
		// Act
		c.statements.count = 0;
		const first = await c.store.fillInviteTokenDigests(100);
		const statements = c.statements.count;
		const second = await c.store.fillInviteTokenDigests(100);
		// Assert
		expect(first).toEqual({
			filled_invites: 100,
			hashed_join_requests: 100,
			remaining_invites_without_digest: 5,
			remaining_plaintext_join_requests: 5,
		});
		// Two reads and two writes for the rows, two counts, and the lookup version record.
		expect(statements).toBeLessThanOrEqual(8);
		expect(second).toMatchObject({
			filled_invites: 5,
			hashed_join_requests: 5,
			remaining_invites_without_digest: 0,
			remaining_plaintext_join_requests: 0,
		});
		for (const [inviteId, token] of legacy) {
			expect(c.row(inviteId)).toEqual({ token, token_digest: digestOf(token) });
			expect((await c.store.getInviteByToken(token))?.invite_id).toBe(inviteId);
		}
		const requests = c.db.prepare("SELECT token FROM coordinator_join_requests").all();
		expect(
			requests.every((request) =>
				String((request as { token: string }).token).startsWith("sha256:"),
			),
		).toBe(true);
	});

	it("refuses a join approval whose invitation it cannot resolve, and approves it once it can", async () => {
		// Arrange: a pending request whose invitation predates token digests.
		const c = coordinator(backend);
		const invite = await enrollmentInvite(c.store);
		const request = await joinRequest(c.store, invite.token, "joiner-legacy");
		c.db
			.prepare("UPDATE coordinator_join_requests SET token = ? WHERE request_id = ?")
			.run(invite.token, request.request_id);
		c.setToken(invite.invite_id, invite.token, null);
		// Act
		const refused = c.store.reviewJoinRequest({ requestId: request.request_id, approved: true });
		// Assert: no inviter check means no approval.
		await expect(refused).rejects.toThrow("invite_invalid");
		expect(await c.store.getEnrollment(GROUP_ID, "joiner-legacy")).toBeNull();
		expect((await c.store.listJoinRequests(GROUP_ID))[0]?.status).toBe("pending");
		// Once the backfill resolves the invitation, the same request is approved.
		await c.store.fillInviteTokenDigests(100);
		const approved = await c.store.reviewJoinRequest({
			requestId: request.request_id,
			approved: true,
		});
		expect(approved?.status).toBe("approved");
		expect(await c.store.getEnrollment(GROUP_ID, "joiner-legacy")).toMatchObject({
			device_id: "joiner-legacy",
		});
	});

	it("stores a new join request with its invitation token's digest", async () => {
		const c = coordinator(backend);
		const invite = await enrollmentInvite(c.store);
		const request = await joinRequest(c.store, invite.token, "joiner");
		expect(request.token).toBe(`sha256:${digestOf(invite.token)}`);
		expect(
			c.db
				.prepare("SELECT token FROM coordinator_join_requests WHERE request_id = ?")
				.get(request.request_id),
		).toEqual({ token: `sha256:${digestOf(invite.token)}` });
	});
});

it("SQLite fills digests and join request copies when it opens its file", async () => {
	// Arrange
	const c = coordinator("SQLite");
	const invite = await enrollmentInvite(c.store);
	const request = await joinRequest(c.store, invite.token, "joiner");
	c.setToken(invite.invite_id, "legacy-token");
	c.db
		.prepare("UPDATE coordinator_join_requests SET token = ? WHERE request_id = ?")
		.run("legacy-token", request.request_id);
	// Act
	const reopened = new BetterSqliteCoordinatorStore(c.path);
	cleanups.push(() => reopened.db.close());
	// Assert
	expect(c.row(invite.invite_id).token_digest).toBe(digestOf("legacy-token"));
	expect(c.db.prepare("SELECT token FROM coordinator_join_requests").get()).toEqual({
		token: `sha256:${digestOf("legacy-token")}`,
	});
	expect((await reopened.getInviteByToken("legacy-token"))?.invite_id).toBe(invite.invite_id);
});

it("runs the digest backfill only for the admin, one bounded batch per request", async () => {
	// Arrange
	const c = coordinator("D1");
	const invite = await enrollmentInvite(c.store);
	c.setToken(invite.invite_id, "legacy-token");
	const app = createCoordinatorApp({
		storeFactory: () => c.store,
		runtime: { adminSecret: () => "test-secret", now: () => "2026-11-01T00:00:00.000Z" },
		requestVerifier: async () => true,
	});
	const post = (body: unknown, secret = "test-secret") =>
		app.request(INVITE_TOKEN_DIGESTS_PATH, {
			method: "POST",
			headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": secret },
			body: JSON.stringify(body),
		});
	// Act
	const anonymous = await post({}, "wrong-secret");
	const invalid = await Promise.all(
		[{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { batch: 1 }].map((body) => post(body)),
	);
	const untouched = c.row(invite.invite_id).token_digest;
	const filled = await post({ limit: 100 });
	// Assert
	expect(anonymous.status).toBe(401);
	expect(invalid.map((response) => response.status)).toEqual([400, 400, 400, 400]);
	expect(untouched).toBeNull();
	expect(await filled.json()).toEqual({
		version: 1,
		filled_invites: 1,
		hashed_join_requests: 0,
		remaining_invites_without_digest: 0,
		remaining_plaintext_join_requests: 0,
	});
});
