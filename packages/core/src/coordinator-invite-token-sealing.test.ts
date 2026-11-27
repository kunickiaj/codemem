import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { type Backend, sqliteD1, workerSchemaSql } from "./coordinator-auth-store-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import { INVITE_TOKEN_SEAL_PATH } from "./coordinator-invite-token-route.js";
import {
	type InviteTokenKeyInput,
	InviteTokenKeyring,
	InviteTokenSealError,
} from "./coordinator-invite-token-seal.js";
import { decodeInvitePayload, extractInvitePayload } from "./coordinator-invites.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

const GROUP_ID = "seal-group";
const OPERATION_ID = `share_${"c".repeat(40)}`;
const digestOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const newKey = () => randomBytes(32).toString("hex");
const PLACEHOLDER = /^sealed:[A-Za-z0-9_-]{43}$/u;

interface InviteRow {
	invite_id: string;
	token: string;
	token_digest: string | null;
	token_ciphertext: string | null;
	token_key_id: string | null;
	expires_at: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * One coordinator database, with stores on it that each have their own keys.
 * `onStatement` sees each statement a store runs, before it runs.
 */
function coordinator(backend: Backend, options: { floor?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "codemem-invite-seal-"));
	const path = join(dir, "coordinator.sqlite");
	const key = newKey();
	const hooks: { onStatement?: (sql: string) => void; statements: number } = { statements: 0 };
	const seen = (sql: string) => {
		hooks.statements += 1;
		hooks.onStatement?.(sql);
	};
	const workerDb = backend === "D1" ? new Database(path) : null;
	workerDb?.exec(workerSchemaSql());
	const opened: CoordinatorStore[] = [];
	// Writes from inside a hook use the hooked store's own connection, which holds the write lock.
	let hookPrepare: ((sql: string) => Database.Statement) | null = workerDb
		? workerDb.prepare.bind(workerDb)
		: null;
	const open = (keys: InviteTokenKeyInput = { current: key }): CoordinatorStore => {
		if (workerDb) {
			const d1 = sqliteD1(workerDb, { beforeRead: seen, beforeWrite: seen });
			const store = new D1CoordinatorStore(d1, { inviteTokenKeys: keys });
			opened.push(store);
			return store;
		}
		const store = new BetterSqliteCoordinatorStore(path, { inviteTokenKeys: keys });
		const prepare = store.db.prepare.bind(store.db);
		hookPrepare ??= prepare;
		vi.spyOn(store.db, "prepare").mockImplementation((sql: string) => {
			seen(sql);
			return prepare(sql);
		});
		opened.push(store);
		return store;
	};
	const store = open();
	// A connection of its own, so test reads and writes are not counted or hooked.
	const db = workerDb ?? new Database(path);
	// The operator has confirmed that no build below digest-only lookups serves the database.
	const recordFloor = () =>
		db
			.prepare(
				`INSERT INTO coordinator_metadata (name, value, updated_at)
				VALUES ('invite_token_min_serving_lookup_version', 1, '2026-11-01T00:00:00.000Z')`,
			)
			.run();
	if (options.floor !== false) recordFloor();
	cleanups.push(async () => {
		for (const each of opened) await each.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const row = (inviteId: string) =>
		db
			.prepare(
				"SELECT invite_id, token, token_digest, token_ciphertext, token_key_id, expires_at FROM coordinator_invites WHERE invite_id = ?",
			)
			.get(inviteId) as InviteRow;
	/** Puts a row back in the shape it had before migration 0055. */
	const unseal = (inviteId: string, token: string) =>
		db
			.prepare(
				"UPDATE coordinator_invites SET token = ?, token_digest = ?, token_ciphertext = NULL, token_key_id = NULL WHERE invite_id = ?",
			)
			.run(token, digestOf(token), inviteId);
	const exec = async (sql: string, ...values: unknown[]) => {
		db.prepare(sql).run(...values);
	};
	const hookWrite = (sql: string, ...values: unknown[]) => hookPrepare?.(sql).run(...values);
	return { key, store, open, db, row, unseal, exec, hooks, hookWrite, recordFloor };
}

async function enrollmentInvite(store: CoordinatorStore) {
	if (!(await store.getGroup(GROUP_ID))) await store.createGroup(GROUP_ID, "Team");
	return store.createInvite({
		groupId: GROUP_ID,
		policy: "approval_required",
		expiresAt: "2099-01-01T00:00:00Z",
	});
}

function operationInvite(store: CoordinatorStore) {
	const projects = [
		{ canonical_identity: "git:example", display_name: "Example", existing_memory_count: 1 },
	];
	return store.createInvite({
		groupId: GROUP_ID,
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00Z",
		operationId: OPERATION_ID,
		reviewedProjectSetDigest: "d".repeat(64),
		projectIntent: projects,
		projectSummaries: projects,
		inviterDisplayName: "Owner",
	});
}

/** An app that opens a store for each request, as the coordinator runtimes do. */
function appFor(open: () => CoordinatorStore) {
	return createCoordinatorApp({
		storeFactory: open,
		runtime: { adminSecret: () => "test-secret", now: () => "2026-11-01T00:00:00.000Z" },
		requestVerifier: async () => true,
	});
}

async function sealCode(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(InviteTokenSealError);
	return (error as InviteTokenSealError).code;
}

// The getInviteByToken query of Workers from before digest-only lookups (ef57ff2c).
const PRE_FLOOR_LOOKUP_SQL = `SELECT invite_id FROM coordinator_invites
	WHERE (token_digest = ? OR token = ?) AND revoked_at IS NULL AND expires_at > ?`;

describe.each<Backend>(["SQLite", "D1"])("%s sealed invitation tokens", (backend) => {
	it("stores a new token only as a digest and ciphertext behind a random placeholder", async () => {
		// Arrange
		const c = coordinator(backend);
		// Act
		const invite = await enrollmentInvite(c.store);
		const other = await enrollmentInvite(c.store);
		const stored = c.row(invite.invite_id);
		// Assert
		expect(stored).toMatchObject({
			token: expect.stringMatching(PLACEHOLDER),
			token_digest: digestOf(invite.token),
			token_key_id: expect.stringMatching(/^[0-9a-f]{16}$/u),
			token_ciphertext: expect.stringMatching(/^v1\./u),
		});
		expect(stored.token).not.toContain(invite.invite_id);
		expect(stored.token).not.toBe(c.row(other.invite_id).token);
		expect(JSON.stringify(c.db.prepare("SELECT * FROM coordinator_invites").all())).not.toContain(
			invite.token,
		);
		expect((await c.store.getInviteByToken(invite.token))?.invite_id).toBe(invite.invite_id);
		expect(await c.store.inviteLinkToken(stored as never)).toBe(invite.token);
	});

	it("gives a Worker from before the rollback floor no placeholder it can be handed", async () => {
		// Arrange
		const c = coordinator(backend);
		const invite = await enrollmentInvite(c.store);
		const lookup = (presented: string) =>
			c.db
				.prepare(PRE_FLOOR_LOOKUP_SQL)
				.all(digestOf(presented), presented, "2026-11-01T00:00:00.000Z");
		// Act: everything someone without the database can derive from public values.
		const derived = [
			`sealed:${invite.invite_id}`,
			`consumed:${invite.invite_id}`,
			invite.invite_id,
			"sealed:",
			c.row(invite.invite_id).token_key_id ?? "",
		];
		// Assert: the old query finds none of them, and still finds the real token.
		for (const presented of derived) expect(lookup(presented)).toEqual([]);
		expect(lookup(invite.token)).toEqual([{ invite_id: invite.invite_id }]);
	});

	it("writes nothing on lookups, and seals a row that still holds its token on the next link read", async () => {
		// Arrange
		const c = coordinator(backend);
		const invite = await enrollmentInvite(c.store);
		c.unseal(invite.invite_id, "legacy-token");
		const before = c.db.prepare("SELECT * FROM coordinator_invites").all();
		// Act
		const hits = await Promise.all([
			c.store.getInviteByToken("legacy-token"),
			c.store.getInviteByTokenForInspection("legacy-token"),
			c.store.getInviteByTokenForInspection(randomBytes(24).toString("base64url")),
		]);
		const unchanged = c.db.prepare("SELECT * FROM coordinator_invites").all();
		const link = await c.store.inviteLinkToken(c.row(invite.invite_id) as never);
		// Assert
		expect(hits.map((hit) => hit?.invite_id ?? null)).toEqual([
			invite.invite_id,
			invite.invite_id,
			null,
		]);
		expect(unchanged).toEqual(before);
		expect(link).toBe("legacy-token");
		expect(c.row(invite.invite_id).token).toMatch(PLACEHOLDER);
	});
});

describe.each<Backend>(["SQLite", "D1"])(
	"%s sealed invitation token keys and consumption",
	(backend) => {
		it("refuses creating and copying without a key, and acceptance drops the ciphertext in its own statement", async () => {
			// Arrange
			const c = coordinator(backend);
			const f = {
				store: c.store,
				input: revocationInput("seal"),
				exec: c.exec,
				rows: async () => [],
			};
			const { input, invite } = await projectInvite(f);
			const keyless = c.open({ current: null });
			const count = () => c.db.prepare("SELECT COUNT(*) AS n FROM coordinator_invites").get();
			const before = count();
			// Any cleanup of ciphertext apart from the consume statement fails.
			c.hooks.onStatement = (sql) => {
				if (/^UPDATE coordinator_invites SET token_ciphertext = NULL/u.test(sql.trim()))
					throw new Error("separate_cleanup_refused");
			};
			// Act and assert
			expect(await sealCode(enrollmentInvite(keyless))).toBe("invite_token_key_unavailable");
			expect(await sealCode(enrollmentInvite(c.open({ current: "not-a-key" })))).toBe(
				"invite_token_key_invalid",
			);
			expect(count()).toEqual(before);
			expect(await sealCode(keyless.inviteLinkToken(c.row(invite.invite_id) as never))).toBe(
				"invite_token_key_unavailable",
			);
			expect(await keyless.consumeProjectInvite(input)).toMatchObject({ status: "accepted" });
			expect(c.row(invite.invite_id)).toMatchObject({
				token: `consumed:${invite.invite_id}`,
				token_ciphertext: null,
				token_key_id: null,
			});
		});

		it("returns no link to a Copy that raced the invitation's acceptance", async () => {
			// Arrange: Copy has read the invitation while it was still open.
			const c = coordinator(backend);
			const f = {
				store: c.store,
				input: revocationInput("race"),
				exec: c.exec,
				rows: async () => [],
			};
			const { input, invite } = await projectInvite(f);
			const copied = await c.store.getInviteByOperationId(
				invite.group_id,
				String(invite.operation_id),
			);
			// Act: the acceptance commits before Copy reads the token.
			await c.store.consumeProjectInvite(input);
			const link = await c.store.inviteLinkToken(copied as never);
			// Assert
			expect(copied?.consumed_at).toBeNull();
			expect(link).toBeNull();
		});

		it("refuses a changed ciphertext or key ID instead of returning another token", async () => {
			// Arrange
			const c = coordinator(backend);
			const invite = await enrollmentInvite(c.store);
			const stored = c.row(invite.invite_id);
			const other = await enrollmentInvite(c.store);
			const setCiphertext = (ciphertext: string | null, keyId = stored.token_key_id) =>
				c.db
					.prepare(
						"UPDATE coordinator_invites SET token_ciphertext = ?, token_key_id = ? WHERE invite_id = ?",
					)
					.run(ciphertext, keyId, invite.invite_id);
			// Act and assert: ciphertext of another row, a flipped byte, an unknown key ID.
			setCiphertext(c.row(other.invite_id).token_ciphertext);
			expect(await sealCode(c.store.inviteLinkToken(stored as never))).toBe(
				"invite_token_unreadable",
			);
			// A character in the middle of the body carries only ciphertext bits.
			const text = String(stored.token_ciphertext);
			const at = text.length - 10;
			setCiphertext(`${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`);
			expect(await sealCode(c.store.inviteLinkToken(stored as never))).toBe(
				"invite_token_unreadable",
			);
			setCiphertext(stored.token_ciphertext, "0".repeat(16));
			expect(await sealCode(c.store.inviteLinkToken(stored as never))).toBe(
				"invite_token_key_unavailable",
			);
		});

		it("reads links sealed with the previous key during a rotation", async () => {
			// Arrange
			const c = coordinator(backend);
			const invite = await enrollmentInvite(c.store);
			const rotated = newKey();
			const rotating = c.open({ current: rotated, previous: c.key });
			const afterRotation = c.open({ current: rotated });
			// Act
			const link = await rotating.inviteLinkToken(c.row(invite.invite_id) as never);
			const fresh = await enrollmentInvite(rotating);
			// Assert
			expect(link).toBe(invite.token);
			expect(c.row(fresh.invite_id).token_key_id).not.toBe(c.row(invite.invite_id).token_key_id);
			expect(await afterRotation.inviteLinkToken(c.row(fresh.invite_id) as never)).toBe(
				fresh.token,
			);
			expect(await sealCode(afterRotation.inviteLinkToken(c.row(invite.invite_id) as never))).toBe(
				"invite_token_key_unavailable",
			);
		});
	},
);

describe.each<Backend>(["SQLite", "D1"])("%s sealing backfill and renewals", (backend) => {
	it("seals the largest batch of both tables with a fixed number of statements", async () => {
		// Arrange: more rows in both tables than one batch takes, and spent ciphertext.
		const c = coordinator(backend);
		const legacy: Array<[string, string]> = [];
		for (let index = 0; index < 105; index += 1) {
			const invite = await enrollmentInvite(c.store);
			const token = `legacy-token-${index}`;
			c.unseal(invite.invite_id, token);
			if (index % 2 === 0)
				c.db
					.prepare("UPDATE coordinator_invites SET token_digest = NULL WHERE invite_id = ?")
					.run(invite.invite_id);
			legacy.push([invite.invite_id, token]);
			const request = await c.store.createJoinRequest({
				groupId: GROUP_ID,
				deviceId: `joiner-${index}`,
				publicKey: `public-key-${index}`,
				fingerprint: `fingerprint-${index}`,
				token: invite.token,
			});
			c.db
				.prepare("UPDATE coordinator_join_requests SET token = ? WHERE request_id = ?")
				.run(token, request.request_id);
		}
		const spent = await enrollmentInvite(c.store);
		c.db
			.prepare("UPDATE coordinator_invites SET token = ? WHERE invite_id = ?")
			.run(`consumed:${spent.invite_id}`, spent.invite_id);
		// Act
		c.hooks.statements = 0;
		const first = await c.store.sealStoredInviteTokens(100);
		const statements = c.hooks.statements;
		const second = await c.store.sealStoredInviteTokens(100);
		// Assert
		expect(first).toEqual({
			sealed_invites: 100,
			cleared_spent_invites: 1,
			hashed_join_requests: 100,
			remaining_plaintext_invites: 5,
			remaining_plaintext_join_requests: 5,
			remaining_spent_ciphertext: 0,
		});
		expect(statements).toBeLessThanOrEqual(8);
		expect(second).toMatchObject({
			sealed_invites: 5,
			hashed_join_requests: 5,
			remaining_plaintext_invites: 0,
			remaining_plaintext_join_requests: 0,
		});
		expect(c.row(spent.invite_id)).toMatchObject({ token_ciphertext: null, token_key_id: null });
		for (const [inviteId, token] of legacy) {
			expect(c.row(inviteId)).toMatchObject({
				token: expect.stringMatching(PLACEHOLDER),
				token_digest: digestOf(token),
			});
			expect((await c.store.getInviteByToken(token))?.invite_id).toBe(inviteId);
			expect(await c.store.inviteLinkToken(c.row(inviteId) as never)).toBe(token);
		}
		expect(await sealCode(c.open({}).sealStoredInviteTokens(2))).toBe(
			"invite_token_key_unavailable",
		);
	});

	it("reports and clears spent ciphertext over several batches until none is left", async () => {
		// Arrange: 150 sealed invitations that an earlier build consumed after a rollback,
		// so each still keeps its ciphertext.
		const c = coordinator(backend);
		for (let index = 0; index < 150; index += 1) await enrollmentInvite(c.store);
		c.db.exec("UPDATE coordinator_invites SET token = 'consumed:' || invite_id");
		// Act
		const batches = [];
		for (let run = 0; run < 4; run += 1) {
			const progress = await c.store.sealStoredInviteTokens(100);
			batches.push(progress);
			if (progress.remaining_spent_ciphertext === 0) break;
		}
		// Assert
		expect(batches.map((batch) => batch.cleared_spent_invites)).toEqual([100, 50]);
		expect(batches.map((batch) => batch.remaining_spent_ciphertext)).toEqual([50, 0]);
		expect(batches.every((batch) => batch.remaining_plaintext_invites === 0)).toBe(true);
		expect(
			c.db
				.prepare("SELECT COUNT(*) AS n FROM coordinator_invites WHERE token_ciphertext IS NOT NULL")
				.get(),
		).toEqual({ n: 0 });
	});

	it("renews an expired invitation again when sealing changed it first, instead of returning its old link", async () => {
		// Arrange: an expired operation invitation that still holds its token.
		const c = coordinator(backend);
		await c.store.createGroup(GROUP_ID, "Team");
		const created = await operationInvite(c.store);
		c.unseal(created.invite_id, "expired-token");
		c.db
			.prepare("UPDATE coordinator_invites SET expires_at = ? WHERE invite_id = ?")
			.run("2000-01-01T00:00:00.000Z", created.invite_id);
		const sealed = await (await InviteTokenKeyring.from({ current: c.key })).seal(
			"expired-token",
			created.invite_id,
		);
		// The backfill seals the row just before the renewal writes it.
		let raced = false;
		c.hooks.onStatement = (sql) => {
			if (raced || !/SET token = \?, token_digest = \?, token_ciphertext = \?/u.test(sql)) return;
			raced = true;
			c.hookWrite(
				"UPDATE coordinator_invites SET token = ?, token_ciphertext = ?, token_key_id = ? WHERE invite_id = ?",
				"sealed:raced",
				sealed.ciphertext,
				sealed.keyId,
				created.invite_id,
			);
		};
		// Act: a create retry of the same operation renews it.
		const renewed = await operationInvite(c.store);
		// Assert
		expect(raced).toBe(true);
		expect(renewed.token).not.toBe("expired-token");
		expect(c.row(created.invite_id)).toMatchObject({
			token_digest: digestOf(renewed.token),
			expires_at: "2099-01-01T00:00:00.000Z",
		});
		expect((await c.store.getInviteByToken(renewed.token))?.invite_id).toBe(created.invite_id);
	});
});

describe.each<Backend>(["SQLite", "D1"])(
	"%s sealed invitation links for beta.3 clients",
	(backend) => {
		it("keeps Copy invite and create retries returning the link a beta.3 client received", async () => {
			// Arrange
			const c = coordinator(backend);
			await c.store.createGroup(GROUP_ID, "Team");
			const created = await operationInvite(c.store);
			const copy = (keys?: InviteTokenKeyInput) =>
				appFor(() => c.open(keys)).request(
					`/v1/admin/project-invites/${OPERATION_ID}?group_id=${GROUP_ID}`,
					{ headers: { "X-Codemem-Coordinator-Admin": "test-secret" } },
				);
			// Act
			const retried = await operationInvite(c.store);
			const response = await copy();
			const body = (await response.json()) as { invite_link: string };
			const keyless = await copy({});
			// Assert
			expect(retried.token).toBe(created.token);
			expect(response.status).toBe(200);
			expect(decodeInvitePayload(extractInvitePayload(body.invite_link))).toMatchObject({
				v: 1,
				kind: "coordinator_team_invite",
				group_id: GROUP_ID,
				token: created.token,
				operation_id: OPERATION_ID,
			});
			expect(keyless.status).toBe(503);
			expect(await keyless.json()).toEqual({ error: "invite_token_key_unavailable" });
		});
	},
);

describe.each<Backend>(["SQLite", "D1"])("%s before the lookup floor is recorded", (backend) => {
	it("keeps bearer tokens that an earlier build still serves, and refuses the backfill", async () => {
		// Arrange
		const c = coordinator(backend, { floor: false });
		const lookup = (presented: string) =>
			c.db
				.prepare(PRE_FLOOR_LOOKUP_SQL)
				.all(digestOf(presented), presented, "2026-11-01T00:00:00.000Z");
		// Act
		const created = await enrollmentInvite(c.store);
		const keyless = await enrollmentInvite(c.open({}));
		const linked = await c.open({}).inviteLinkToken(c.row(created.invite_id) as never);
		const refused = await sealCode(c.store.sealStoredInviteTokens(100));
		// Assert: rows look as an earlier build wrote them, so its lookup and Copy still work.
		for (const invite of [created, keyless]) {
			expect(c.row(invite.invite_id)).toMatchObject({
				token: invite.token,
				token_digest: digestOf(invite.token),
				token_ciphertext: null,
			});
			expect(lookup(invite.token)).toEqual([{ invite_id: invite.invite_id }]);
		}
		expect(linked).toBe(created.token);
		expect(refused).toBe("invite_token_lookup_floor_unset");
		expect(c.row(created.invite_id).token).toBe(created.token);
	});

	it("starts sealing, and refusing without a key, only once the floor is recorded", async () => {
		// Arrange
		const c = coordinator(backend, { floor: false });
		const before = await enrollmentInvite(c.store);
		c.recordFloor();
		// Act: stores open after the record see it.
		const store = c.open();
		const after = await enrollmentInvite(store);
		const progress = await store.sealStoredInviteTokens(100);
		// Assert
		expect(c.row(after.invite_id).token).toMatch(PLACEHOLDER);
		expect(progress).toMatchObject({ sealed_invites: 1, remaining_plaintext_invites: 0 });
		expect(c.row(before.invite_id).token).toMatch(PLACEHOLDER);
		expect(await store.inviteLinkToken(c.row(before.invite_id) as never)).toBe(before.token);
		expect(await sealCode(enrollmentInvite(c.open({})))).toBe("invite_token_key_unavailable");
	});
});

describe("invitation token sealing routes", () => {
	const post = (
		open: () => CoordinatorStore,
		path: string,
		body: unknown,
		secret = "test-secret",
	) =>
		appFor(open).request(path, {
			method: "POST",
			headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": secret },
			body: JSON.stringify(body),
		});

	it("answers an invitation create without a key with 503 and the reason", async () => {
		// Arrange
		const c = coordinator("SQLite");
		await c.store.createGroup(GROUP_ID, "Team");
		const body = {
			group_id: GROUP_ID,
			policy: "approval_required",
			expires_at: "2099-01-01T00:00:00Z",
			coordinator_url: "https://coordinator.example.test",
		};
		// Act
		const refused = await post(() => c.open({}), "/v1/admin/invites", body);
		const created = await post(() => c.open(), "/v1/admin/invites", body);
		const payload = ((await created.json()) as { payload: { token: string } }).payload;
		// Assert
		expect(refused.status).toBe(503);
		expect(await refused.json()).toEqual({ error: "invite_token_key_unavailable" });
		expect(created.status).toBe(200);
		expect((await c.store.getInviteByToken(payload.token))?.group_id).toBe(GROUP_ID);
	});

	it("runs the sealing backfill only for the admin, one bounded batch per request", async () => {
		// Arrange
		const c = coordinator("SQLite");
		const invite = await enrollmentInvite(c.store);
		c.unseal(invite.invite_id, "legacy-token");
		// Act
		const keyed = () => c.open();
		const anonymous = await post(keyed, INVITE_TOKEN_SEAL_PATH, {}, "wrong-secret");
		const invalid = await Promise.all(
			[{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { batch: 1 }].map((body) =>
				post(keyed, INVITE_TOKEN_SEAL_PATH, body),
			),
		);
		const keyless = await post(() => c.open({}), INVITE_TOKEN_SEAL_PATH, {});
		const untouched = c.row(invite.invite_id).token;
		const sealed = await post(keyed, INVITE_TOKEN_SEAL_PATH, { limit: 10 });
		// Assert
		expect(anonymous.status).toBe(401);
		expect(invalid.map((response) => response.status)).toEqual([400, 400, 400, 400]);
		expect(keyless.status).toBe(503);
		expect(await keyless.json()).toEqual({ error: "invite_token_key_unavailable" });
		expect(untouched).toBe("legacy-token");
		expect(await sealed.json()).toEqual({
			version: 1,
			sealed_invites: 1,
			cleared_spent_invites: 0,
			hashed_join_requests: 0,
			remaining_plaintext_invites: 0,
			remaining_plaintext_join_requests: 0,
			remaining_spent_ciphertext: 0,
		});
		expect(c.row(invite.invite_id).token).toMatch(PLACEHOLDER);
	});
});
