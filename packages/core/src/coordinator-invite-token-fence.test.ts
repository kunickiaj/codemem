import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { type Backend, sqliteD1, workerSchemaSql } from "./coordinator-auth-store-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import {
	COORDINATOR_METADATA_MIGRATION_NAME,
	COORDINATOR_METADATA_MIGRATION_SQL,
	COORDINATOR_METADATA_SCHEMA_SQL,
} from "./coordinator-invite-token-fence.js";
import { INVITE_TOKEN_LOOKUP_FLOOR_PATH } from "./coordinator-invite-token-route.js";
import { InviteTokenRefusal } from "./coordinator-invite-token-seal.js";
import { decodeInvitePayload, extractInvitePayload } from "./coordinator-invites.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

const GROUP_ID = "fence-group";
const OPERATION_ID = `share_${"e".repeat(40)}`;
const NOW = "2026-11-01T00:00:00.000Z";
const digestOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
/** The shape a later Worker leaves in the `token` column of a sealed invitation. */
const placeholder = () => `sealed:${randomBytes(32).toString("base64url")}`;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function coordinator(backend: Backend) {
	const dir = mkdtempSync(join(tmpdir(), "codemem-invite-fence-"));
	const path = join(dir, "coordinator.sqlite");
	let store: CoordinatorStore;
	let db: InstanceType<typeof Database>;
	if (backend === "D1") {
		db = new Database(path);
		db.exec(workerSchemaSql());
		store = new D1CoordinatorStore(sqliteD1(db));
	} else {
		const sqlite = new BetterSqliteCoordinatorStore(path);
		store = sqlite;
		db = sqlite.db;
	}
	cleanups.push(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const setToken = (inviteId: string, token: string) =>
		db.prepare("UPDATE coordinator_invites SET token = ? WHERE invite_id = ?").run(token, inviteId);
	// The routes close the store of each request, as the coordinator runtimes do.
	const app = createCoordinatorApp({
		storeFactory: () =>
			backend === "D1"
				? new D1CoordinatorStore(sqliteD1(db))
				: new BetterSqliteCoordinatorStore(path),
		runtime: { adminSecret: () => "test-secret", now: () => NOW },
		requestVerifier: async () => true,
	});
	const copy = () =>
		app.request(`/v1/admin/project-invites/${OPERATION_ID}?group_id=${GROUP_ID}`, {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});
	return { store, db, path, setToken, app, copy };
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

async function refusal(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(InviteTokenRefusal);
	return { code: (error as InviteTokenRefusal).code, status: (error as InviteTokenRefusal).status };
}

// The getInviteByToken query of Workers from before digest-only lookups (ef57ff2c).
const PRE_FLOOR_LOOKUP_SQL = `SELECT invite_id, token FROM coordinator_invites
	WHERE (token_digest = ? OR token = ?) AND revoked_at IS NULL AND expires_at > ?`;

describe.each<Backend>(["SQLite", "D1"])(
	"%s overlapping with a later, sealing Worker",
	(backend) => {
		it("refuses Copy invite and a create retry for a row that holds a placeholder", async () => {
			// Arrange: a later Worker sealed the open invitation.
			const c = coordinator(backend);
			await c.store.createGroup(GROUP_ID, "Team");
			const created = await operationInvite(c.store);
			c.setToken(created.invite_id, placeholder());
			// Act
			const copied = await c.copy();
			const retried = await refusal(operationInvite(c.store));
			// Assert
			expect(copied.status).toBe(409);
			expect(await copied.json()).toEqual({ error: "invite_link_unavailable" });
			expect(retried).toEqual({ code: "invite_link_unavailable", status: 409 });
		});

		it("renews an expired row that holds a placeholder with a new bearer token", async () => {
			// Arrange
			const c = coordinator(backend);
			await c.store.createGroup(GROUP_ID, "Team");
			const created = await operationInvite(c.store);
			const sealed = placeholder();
			c.setToken(created.invite_id, sealed);
			c.db
				.prepare("UPDATE coordinator_invites SET expires_at = ? WHERE invite_id = ?")
				.run("2000-01-01T00:00:00.000Z", created.invite_id);
			// Act
			const renewed = await operationInvite(c.store);
			const copied = await c.copy();
			const link = ((await copied.json()) as { invite_link: string }).invite_link;
			// Assert
			expect(renewed.token).not.toBe(sealed);
			expect(renewed.token).not.toContain(":");
			expect(decodeInvitePayload(extractInvitePayload(link)).token).toBe(renewed.token);
		});

		it("accepts the bearer token of a sealed row, and never the placeholder", async () => {
			// Arrange
			const c = coordinator(backend);
			const f = {
				store: c.store,
				input: revocationInput("fence"),
				exec: async () => {},
				rows: async () => [],
			};
			const { input, invite } = await projectInvite(f);
			const sealed = placeholder();
			c.setToken(invite.invite_id, sealed);
			// Act
			const byPlaceholder = await c.store.getInviteByTokenForInspection(sealed);
			const accepted = await c.store.consumeProjectInvite(input);
			// Assert
			expect(byPlaceholder).toBeNull();
			expect(accepted).toMatchObject({ status: "accepted" });
		});
	},
);

describe.each<Backend>(["SQLite", "D1"])("%s overlapping with an earlier Worker", (backend) => {
	it("stores bearer tokens that an earlier Worker still looks up and copies", async () => {
		// Arrange
		const c = coordinator(backend);
		await c.store.createGroup(GROUP_ID, "Team");
		const created = await operationInvite(c.store);
		// Act: the earlier Worker's lookup, and its Copy, which emitted the stored token.
		const found = c.db
			.prepare(PRE_FLOOR_LOOKUP_SQL)
			.all(digestOf(created.token), created.token, NOW);
		// Assert
		expect(found).toEqual([{ invite_id: created.invite_id, token: created.token }]);
	});

	it("copies and accepts an invitation an earlier Worker created", async () => {
		// Arrange: the earlier Worker stored the bearer token and its digest.
		const c = coordinator(backend);
		const f = {
			store: c.store,
			input: revocationInput("older"),
			exec: async () => {},
			rows: async () => [],
		};
		const { input, invite } = await projectInvite(f, OPERATION_ID);
		const token = randomBytes(24).toString("base64url");
		c.db
			.prepare(
				"UPDATE coordinator_invites SET token = ?, token_digest = ?, group_id = ? WHERE invite_id = ?",
			)
			.run(token, digestOf(token), invite.group_id, invite.invite_id);
		const copy = () =>
			c.app.request(`/v1/admin/project-invites/${OPERATION_ID}?group_id=${invite.group_id}`, {
				headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
			});
		// Act
		const copied = (await (await copy()).json()) as { invite_link: string };
		const accepted = await c.store.consumeProjectInvite({ ...input, token });
		// Assert
		expect(decodeInvitePayload(extractInvitePayload(copied.invite_link)).token).toBe(token);
		expect(accepted).toMatchObject({ status: "accepted" });
	});
});

describe.each<Backend>(["SQLite", "D1"])("%s invitation token lookup fence", (backend) => {
	it("records only an operator's confirmed floor, which only rises to this build's version", async () => {
		// Arrange
		const c = coordinator(backend);
		const send = (method: string, body?: unknown, secret = "test-secret") =>
			c.app.request(INVITE_TOKEN_LOOKUP_FLOOR_PATH, {
				method,
				headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": secret },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		// Act
		const before = await (await send("GET")).json();
		const anonymous = await send("POST", { min_serving_lookup_version: 1 }, "wrong-secret");
		const malformed = await Promise.all(
			[{}, { min_serving_lookup_version: "1" }, { min_serving_lookup_version: 1, extra: 1 }].map(
				(body) => send("POST", body),
			),
		);
		const outOfRange = await Promise.all(
			[0, 2].map((version) => send("POST", { min_serving_lookup_version: version })),
		);
		const raised = await send("POST", { min_serving_lookup_version: 1 });
		const again = await send("POST", { min_serving_lookup_version: 1 });
		// Assert
		expect(before).toMatchObject({ build_lookup_version: 1, min_serving_lookup_version: null });
		expect(anonymous.status).toBe(401);
		expect(malformed.map((response) => response.status)).toEqual([400, 400, 400]);
		expect(outOfRange.map((response) => response.status)).toEqual([409, 409]);
		expect(await outOfRange[0]?.json()).toEqual({ error: "invite_token_lookup_floor_invalid" });
		expect(await raised.json()).toMatchObject({ version: 1, min_serving_lookup_version: 1 });
		expect(again.status).toBe(200);
		expect(await c.store.inviteTokenLookupFence()).toMatchObject({ min_serving_lookup_version: 1 });
	});

	it("refuses to record a floor without the metadata table", async () => {
		const c = coordinator(backend);
		c.db.exec("DROP TABLE coordinator_metadata");
		const stale = backend === "D1" ? new D1CoordinatorStore(sqliteD1(c.db)) : c.store;
		const refused = await refusal(stale.raiseInviteTokenLookupFloor(1));
		expect(refused).toEqual({ code: "coordinator_metadata_unavailable", status: 503 });
	});
});

it("SQLite records its lookup version when it opens its file", () => {
	const c = coordinator("SQLite");
	expect(c.db.prepare("SELECT name, value FROM coordinator_metadata ORDER BY name").all()).toEqual([
		{ name: "invite_token_lookup_version_seen", value: 1 },
	]);
});

it("writes nothing on a cold anonymous lookup, and records the lookup version in the admin's backfill", async () => {
	// Arrange: a cold database binding, as a new Worker isolate sees it.
	const db = new Database(":memory:");
	cleanups.push(() => db.close());
	db.exec(workerSchemaSql());
	const writes: string[] = [];
	const d1 = sqliteD1(db, { beforeWrite: (sql) => writes.push(sql) });
	const app = createCoordinatorApp({
		storeFactory: () => new D1CoordinatorStore(d1),
		runtime: { adminSecret: () => "test-secret", now: () => NOW },
		requestVerifier: async () => true,
	});
	// Act: anonymous misses through the public route and the store.
	const inspected = await app.request("/v1/invites/inspect", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: randomBytes(24).toString("base64url") }),
	});
	const missed = await new D1CoordinatorStore(d1).getInviteByToken(
		randomBytes(24).toString("base64url"),
	);
	const anonymousWrites = writes.splice(0);
	const backfill = await app.request("/v1/admin/invite-tokens/digests", {
		method: "POST",
		headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": "test-secret" },
		body: JSON.stringify({}),
	});
	// Assert
	expect(inspected.status).toBe(404);
	expect(missed).toBeNull();
	expect(anonymousWrites).toEqual([]);
	expect(backfill.status).toBe(200);
	expect(db.prepare("SELECT name, value FROM coordinator_metadata").all()).toEqual([
		{ name: "invite_token_lookup_version_seen", value: 1 },
	]);
});

it("an earlier Worker's approval query resolves no invitation for a join request this Worker stored", async () => {
	// The query Workers from before this one (ef57ff2c) run to find a join request's inviter.
	// It cannot resolve `sha256:<digest>`, and then treats the inviter as fresh, so the
	// deployment guide requires a full cutover with join approvals paused. This test
	// records that behavior of the earlier code; no change here can alter it.
	const c = coordinator("D1");
	const f = {
		store: c.store,
		input: revocationInput("cutover"),
		exec: async () => {},
		rows: async () => [],
	};
	const { invite, seed } = await projectInvite(f);
	const request = await c.store.createJoinRequest({
		groupId: invite.group_id,
		deviceId: "joiner",
		publicKey: "joiner-public-key",
		fingerprint: "joiner-fingerprint",
		token: invite.token,
	});
	const earlierInviter = (stored: string) =>
		c.db
			.prepare(
				`SELECT (SELECT invite.inviter_device_id FROM coordinator_invites invite
					WHERE invite.group_id = jr.group_id AND (invite.token = jr.token OR invite.token_digest = ?)
					LIMIT 1) AS inviter FROM coordinator_join_requests jr WHERE jr.request_id = ?`,
			)
			.get(digestOf(stored), request.request_id);
	expect(earlierInviter(request.token)).toEqual({ inviter: null });
	// A request stored by the earlier Worker kept the bearer token, which it resolves.
	c.db
		.prepare("UPDATE coordinator_join_requests SET token = ? WHERE request_id = ?")
		.run(invite.token, request.request_id);
	expect(earlierInviter(invite.token)).toEqual({ inviter: seed.deviceId });
});

it("ships the same SQL in SQLite initialization, migration 0054 and the Worker schema", () => {
	const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
	expect(
		readFileSync(new URL(`migrations/${COORDINATOR_METADATA_MIGRATION_NAME}`, worker), "utf8"),
	).toBe(COORDINATOR_METADATA_MIGRATION_SQL);
	expect(readFileSync(new URL("schema.sql", worker), "utf8")).toContain(
		COORDINATOR_METADATA_SCHEMA_SQL.trim(),
	);
});
