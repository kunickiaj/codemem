import { generateKeyPairSync } from "node:crypto";
import { fingerprintPublicKey, insertTestSession, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { decodeFeedCursor, encodeFeedCursor, feedCursorFilterKey } from "./feed-cursor.js";
import { memoryRoutes } from "./routes/memory.js";

vi.mock("../../core/src/observer-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../core/src/observer-config.js")>()),
	readCodememConfigFile: () => ({}),
}));

const now = "2026-11-01T00:00:00.000Z";
const scopeId = "cursor-managed";
type Page = {
	items: { id: number; created_at: string; body_text: string }[];
	pagination: {
		limit: number;
		offset: number | null;
		next_offset: number | null;
		has_more: boolean;
		paging?: string;
		next_cursor?: string | null;
	};
};
let store: MemoryStore;
let app: ReturnType<typeof memoryRoutes>;
let sessionId: number;
let publicKey: string;

function syntheticPublicKey() {
	const { publicKey: key } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(key.export({ format: "jwk" }).x ?? "", "base64url");
	return `ssh-ed25519 ${Buffer.concat([
		Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
		raw,
	]).toString("base64")}`;
}

beforeEach(() => {
	vi.stubEnv("CODEMEM_DEVICE_ID", "cursor-reader");
	vi.stubEnv("CODEMEM_ACTOR_ID", "cursor-author");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
	vi.spyOn(MemoryStore.prototype, "enqueueVectorWrite").mockImplementation(() => {});
	publicKey = syntheticPublicKey();
	store = new MemoryStore(":memory:", {
		runtimeSigningKey: { deviceId: "cursor-reader", publicKey },
	});
	store.db
		.prepare(`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
		VALUES (?, ?, ?, ?)`)
		.run(store.deviceId, publicKey, fingerprintPublicKey(publicKey), now);
	sessionId = insertTestSession(store.db);
	app = memoryRoutes(() => store);
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function seed(options: { at?: string; kind?: string; scope?: string; actor?: string } = {}) {
	return Number(
		store.db
			.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, created_at, updated_at, metadata_json,
		 scope_id, actor_id, origin_device_id, active, project)
		VALUES (?, ?, 'Cursor observation', 'Searchable cursor body', ?, ?, '{}', ?, ?, 'replica', 1, 'cursor-project')`)
			.run(
				sessionId,
				options.kind ?? "discovery",
				options.at ?? now,
				now,
				options.scope ?? null,
				options.actor ?? "other-author",
			).lastInsertRowid,
	);
}

async function page(query = "paging=cursor&limit=2", route = "observations") {
	const response = await app.request(`/api/${route}?${query}`);
	expect(response.status).toBe(200);
	return response.json() as Promise<Page>;
}

function continuation(first: Page, query = "limit=2", route = "observations") {
	expect(first.pagination.next_cursor).toEqual(expect.any(String));
	return page(`paging=cursor&${query}&cursor=${first.pagination.next_cursor}`, route);
}

function inspectToken(token: string | null | undefined) {
	expect(token).toEqual(expect.any(String));
	return JSON.parse(Buffer.from(token ?? "", "base64url").toString("utf8"));
}

// Test mutations intentionally bypass the production issuer, using only public fixture data.
function tokenFor(payload: unknown) {
	return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

it.each(["observations", "summaries"])(
	"keeps %s legacy responses exact and opts both views into cursor paging",
	async (route) => {
		// Arrange: ties expose unstable ordering, and the fourth row is lookahead.
		const kind = route === "summaries" ? "session_summary" : "discovery";
		const ids = Array.from({ length: 4 }, () => seed({ kind }));
		// Act
		const legacy = await page("limit=2&offset=1", route);
		const ignored = await page("limit=2&offset=1&cursor=invalid", route);
		const alias = await app.request(`/api/memories?limit=2&cursor=invalid`);
		const first = await page("paging=cursor&limit=2&offset=0", route);
		const projected = await page("paging=cursor&view=feed&limit=2", route);
		const second = await continuation(first, "limit=2&view=feed", route);
		// Assert: no new metadata or row changes enter the legacy envelope.
		expect(ignored).toEqual(legacy);
		expect(legacy.pagination).toEqual({ limit: 2, offset: 1, next_offset: 3, has_more: true });
		expect(legacy.items.map(({ id }) => id)).toEqual([ids[2], ids[1]]);
		expect(alias.status).toBe(301);
		expect(alias.headers.get("location")).toBe("/api/observations?limit=2&cursor=invalid");
		expect(first.items.map(({ id }) => id)).toEqual([ids[3], ids[2]]);
		expect(projected.items.map(({ id }) => id)).toEqual(first.items.map(({ id }) => id));
		expect(projected.pagination).toEqual(first.pagination);
		expect(first.pagination).toEqual({
			limit: 2,
			offset: null,
			next_offset: null,
			has_more: true,
			paging: "cursor",
			next_cursor: expect.any(String),
		});
		expect(inspectToken(first.pagination.next_cursor)).toEqual({
			v: 1,
			created_at: now,
			id: ids[2],
			filter: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(second.items.map(({ id }) => id)).toEqual([ids[1], ids[0]]);
		expect(second.pagination).toEqual({
			limit: 2,
			offset: null,
			next_offset: null,
			has_more: false,
			paging: "cursor",
			next_cursor: null,
		});
	},
);

it.each([0, 1, 2, 3])("returns a cursor only with lookahead for %s rows", async (count) => {
	// Arrange
	const ids = Array.from({ length: count }, () => seed()).reverse();
	// Act
	const result = await page();
	const reference = await page("limit=2&offset=0");
	// Assert
	expect(result.items).toEqual(reference.items);
	expect(result.items.map(({ id }) => id)).toEqual(ids.slice(0, 2));
	expect(result.pagination.has_more).toBe(count > 2);
	expect(result.pagination.next_cursor).toEqual(count > 2 ? expect.any(String) : null);
});

it("orders raw TEXT timestamps and never normalizes the anchor", async () => {
	// Arrange: SQLite TEXT order differs from instant order for these offsets.
	const timestamps = [
		"",
		"",
		"custom non-date",
		"2026-11-01T00:00:00Z",
		"2026-11-01T01:00:00+09:00",
		"😀".repeat(128),
	];
	for (const at of timestamps) seed({ at });
	// Act
	const reference = await page("limit=100");
	let current = await page("paging=cursor&limit=1");
	const rows = [...current.items];
	const anchors: string[] = [];
	while (current.pagination.next_cursor) {
		anchors.push(inspectToken(current.pagination.next_cursor).created_at);
		current = await continuation(current, "limit=1");
		rows.push(...current.items);
	}
	// Assert
	expect(rows).toEqual(reference.items);
	expect(anchors).toEqual(reference.items.slice(0, -1).map(({ created_at }) => created_at));
	expect(rows.at(-1)?.created_at).toBe("");
	expect(current.pagination.next_cursor).toBeNull();
});

it.each(["\u0000", "\u0001"])(
	"pages a 256-unit escaped-control timestamp %j without losing its raw anchor",
	async (control) => {
		// Arrange: JSON escaping makes this valid TEXT anchor exceed the former 2048-byte cap.
		const at = control.repeat(256);
		const older = seed({ at });
		const newer = seed({ at });
		// Act
		const first = await page("paging=cursor&limit=1");
		const next = await continuation(first, "limit=1");
		// Assert
		expect(first.items).toMatchObject([{ id: newer, created_at: at }]);
		expect(inspectToken(first.pagination.next_cursor).created_at).toBe(at);
		expect(first.pagination.next_cursor?.length).toBeGreaterThan(2048);
		expect(first.pagination.next_cursor?.length).toBeLessThanOrEqual(4096);
		expect(next.items).toMatchObject([{ id: older, created_at: at }]);
		expect(next.pagination.next_cursor).toBeNull();
	},
);

it.each(["full", "feed"])(
	"reports unavailable %s cursor anchors without changing OFFSET reads",
	async (view) => {
		// Arrange: the long timestamp is legal stored TEXT, but cannot fit the wire position.
		seed({ at: "a" });
		const at = "m".repeat(257);
		const long = seed({ at });
		const top = seed({ at: "z" });
		// Act
		const initial = await app.request(`/api/observations?paging=cursor&limit=2&view=${view}`);
		const legacy = await page("limit=2&offset=0");
		const first = await page(`paging=cursor&limit=1&view=${view}`);
		const later = await app.request(
			`/api/observations?paging=cursor&limit=1&view=${view}&cursor=${first.pagination.next_cursor}`,
		);
		// Assert: both failures permit a restart in legacy mode instead of losing readable rows.
		for (const response of [initial, later]) {
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "cursor_unavailable" });
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
		expect(legacy.items.map(({ id }) => id)).toEqual([top, long]);
		expect(legacy.items[1]).toMatchObject({ created_at: at, body_text: "Searchable cursor body" });
		expect(legacy.pagination).toEqual({ limit: 2, offset: 0, next_offset: 2, has_more: true });
	},
);

it.each(["full", "feed"])(
	"returns a final %s page with an unrepresentable timestamp without encoding it",
	async (view) => {
		// Arrange
		const at = "m".repeat(257);
		const id = seed({ at });
		// Act
		const final = await page(`paging=cursor&limit=1&view=${view}`);
		// Assert
		expect(final.items).toMatchObject([{ id, created_at: at }]);
		expect(final.pagination).toEqual({
			limit: 1,
			offset: null,
			next_offset: null,
			has_more: false,
			paging: "cursor",
			next_cursor: null,
		});
	},
);

it("continues below a deleted anchor while admitting backdated inserts and omitting deleted unseen rows", async () => {
	// Arrange
	const oldest = seed({ at: "a" });
	const deletedUnseen = seed({ at: "b" });
	const anchor = seed({ at: "c" });
	seed({ at: "d" });
	const first = await page();
	store.db.prepare("DELETE FROM memory_items WHERE id IN (?, ?)").run(anchor, deletedUnseen);
	const backdated = seed({ at: "bb" });
	const newer = seed({ at: "z" });
	// Act
	const next = await continuation(first);
	// Assert
	expect(next.items.map(({ id }) => id)).toEqual([backdated, oldest]);
	expect(next.items.map(({ id }) => id)).not.toContain(newer);
	expect(next.pagination.next_cursor).toBeNull();
});

it("uses the session project for the same filtered cursor and legacy reads", async () => {
	// Arrange: insertTestSession sets test-project while these rows store cursor-project.
	const ids = Array.from({ length: 4 }, () => seed()).reverse();
	// Act
	const missing = await page(
		"paging=cursor&limit=1&q=%20CURSOR%20&scope=all&project=cursor-project",
	);
	const legacy = await page("limit=1&q=%20CURSOR%20&scope=all&project=cursor-project");
	const matching = await page(
		"paging=cursor&limit=10&q=%20CURSOR%20&scope=all&project=test-project",
	);
	// Assert: query, classification and ownership leave all four rows eligible for the matching project.
	expect(missing.items).toEqual([]);
	expect(missing.items).toEqual(legacy.items);
	expect(missing.pagination.next_cursor).toBeNull();
	expect(matching.items.map(({ id }) => id)).toEqual(ids);
	expect(matching.pagination.has_more).toBe(false);
});

it("binds meaningful filters but permits normalized selectors, view and limit changes", async () => {
	// Arrange
	store.db.prepare("UPDATE sessions SET project = 'cursor-project' WHERE id = ?").run(sessionId);
	for (let i = 0; i < 4; i++) seed();
	const first = await page("paging=cursor&limit=1&q=%20CURSOR%20&scope=all&project=cursor-project");
	const token = first.pagination.next_cursor;
	const queries = [
		"q=other&scope=all&project=cursor-project",
		"q=cursor&scope=mine&project=cursor-project",
		"q=cursor&scope=theirs&project=cursor-project",
		"q=cursor&project=other",
	];
	// Act
	const accepted = await continuation(
		first,
		"view=feed&limit=3&q=cursor&scope=unknown&project=cursor-project",
	);
	const rejected = await Promise.all(
		queries.map((query) => app.request(`/api/observations?paging=cursor&${query}&cursor=${token}`)),
	);
	const classification = await app.request(
		`/api/summaries?paging=cursor&q=cursor&project=cursor-project&cursor=${token}`,
	);
	// Assert
	expect(accepted.items).toHaveLength(3);
	for (const response of [...rejected, classification]) {
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_cursor" });
		expect(response.headers.get("cache-control")).toBe("no-store");
	}
});

it.each(["actorId", "dbPath"] as const)(
	"rejects a continuation after the current %s changes",
	async (field) => {
		// Arrange: override the context without opening another database or changing identity settings.
		seed();
		seed();
		const first = await page("paging=cursor&limit=1");
		Object.defineProperty(store, field, { value: `different-${field}`, configurable: true });
		// Act
		const response = await app.request(
			`/api/observations?paging=cursor&cursor=${first.pagination.next_cursor}`,
		);
		// Assert
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_cursor" });
	},
);

const invalidMutations: [string, (payload: Record<string, unknown>, token: string) => string][] = [
	["empty", () => ""],
	["garbage", () => "not-json"],
	["version", (p) => tokenFor({ ...p, v: 2 })],
	["reordered keys", ({ v, created_at, id, filter }) => tokenFor({ filter, id, created_at, v })],
	[
		"duplicate keys",
		(p) => Buffer.from(JSON.stringify(p).replace('{"v":1', '{"v":1,"v":1')).toString("base64url"),
	],
	["JSON whitespace", (p) => Buffer.from(` ${JSON.stringify(p)} `).toString("base64url")],
	[
		"exponent version",
		(p) => Buffer.from(JSON.stringify(p).replace('"v":1', '"v":1e0')).toString("base64url"),
	],
	[
		"decimal version",
		(p) => Buffer.from(JSON.stringify(p).replace('"v":1', '"v":1.0')).toString("base64url"),
	],
	["extra key", (p) => tokenFor({ ...p, scopes: [scopeId] })],
	["missing key", ({ id: _id, ...p }) => tokenFor(p)],
	["array", (p) => tokenFor([p])],
	["null", () => tokenFor(null)],
	["unsafe ID", (p) => tokenFor({ ...p, id: Number.MAX_SAFE_INTEGER + 1 })],
	["zero ID", (p) => tokenFor({ ...p, id: 0 })],
	["negative ID", (p) => tokenFor({ ...p, id: -1 })],
	["fractional ID", (p) => tokenFor({ ...p, id: 1.5 })],
	["string ID", (p) => tokenFor({ ...p, id: "1" })],
	["long timestamp", (p) => tokenFor({ ...p, created_at: "😀".repeat(129) })],
	["timestamp type", (p) => tokenFor({ ...p, created_at: null })],
	["wrong filter", (p) => tokenFor({ ...p, filter: "0".repeat(64) })],
	["padded base64", (_p, token) => `${token}=`],
	["oversize", () => "a".repeat(4097)],
	[
		"oversize valid JSON",
		(payload) => {
			const json = JSON.stringify(payload);
			return Buffer.from(json + " ".repeat(3073 - Buffer.byteLength(json))).toString("base64url");
		},
	],
	[
		"malformed UTF8",
		(payload) =>
			Buffer.concat([
				Buffer.from('{"v":1,"created_at":"'),
				Buffer.from([0xff]),
				Buffer.from(`","id":${payload.id},"filter":"${payload.filter}"}`),
			]).toString("base64url"),
	],
	[
		"noncanonical pad bits",
		(payload) => {
			let canonical = tokenFor(payload);
			if (canonical.length % 4 === 0)
				canonical = tokenFor({ ...payload, created_at: `${payload.created_at} ` });
			const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
			const last = alphabet.indexOf(canonical.at(-1) ?? "");
			return canonical.slice(0, -1) + alphabet[last + 1];
		},
	],
];

it.each(invalidMutations)("rejects %s before any memory query", async (_name, mutate) => {
	// Arrange
	seed();
	seed();
	const first = await page("paging=cursor&limit=1");
	const token = String(first.pagination.next_cursor);
	const prepare = vi.spyOn(store.db, "prepare");
	// Act
	const response = await app.request(
		`/api/observations?paging=cursor&cursor=${encodeURIComponent(mutate(inspectToken(token), token))}`,
	);
	// Assert
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: "invalid_cursor" });
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(prepare.mock.calls.filter(([sql]) => /\bFROM\s+memory_items\b/i.test(sql))).toEqual([]);
});

it.each(["1", "-1", "garbage", "1.5", "Infinity", "", "0.0", "0x0", "0e0"])(
	"rejects mixed cursor offset %s before reading rows",
	async (offset) => {
		// Arrange
		seed();
		const prepare = vi.spyOn(store.db, "prepare");
		// Act
		const response = await app.request(`/api/observations?paging=cursor&offset=${offset}`);
		// Assert
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_cursor" });
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(prepare.mock.calls.filter(([sql]) => /\bFROM\s+memory_items\b/i.test(sql))).toEqual([]);
	},
);

it("uses a bound tuple seek and existing indexes without OFFSET or sorting", async () => {
	// Arrange
	seed();
	seed();
	seed();
	const first = await page("paging=cursor&limit=1");
	const boundCalls: unknown[][] = [];
	const originalPrepare = store.db.prepare.bind(store.db);
	const prepare = vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
		const statement = originalPrepare(sql);
		if (/SELECT memory_items\.\*/.test(sql)) {
			const all = statement.all.bind(statement);
			vi.spyOn(statement, "all").mockImplementation((...params: unknown[]) => {
				boundCalls.push(params);
				return all(...params);
			});
		}
		return statement;
	});
	// Act
	const next = await continuation(first, "limit=1");
	const sql =
		prepare.mock.calls.map(([text]) => text).find((text) => /SELECT memory_items\.\*/.test(text)) ??
		"";
	const indexes = store.db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_items'")
		.all() as { name: string }[];
	const columns = store.db
		.prepare("PRAGMA index_xinfo('idx_memory_items_active_created')")
		.all() as { name: string | null; cid: number }[];
	const plan = originalPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(boundCalls[0] ?? [])) as {
		detail: string;
	}[];
	// Assert: authorization predicates may contain OR. The seek itself must use a tuple.
	expect(next.items).toHaveLength(1);
	expect(sql).toMatch(/AND\s+\(memory_items\.created_at,\s*memory_items\.id\)\s*<\s*\(\?,\s*\?\)/);
	expect(sql).not.toMatch(/\bOFFSET\b/i);
	expect(sql).not.toMatch(/created_at\s*<\s*\?\s+OR/i);
	expect(boundCalls).toHaveLength(1);
	expect(boundCalls[0]?.slice(-3)).toEqual([now, first.items[0]?.id, 2]);
	expect(indexes.map(({ name }) => name)).toEqual(
		expect.arrayContaining(["idx_memory_items_active_created", "idx_memory_items_created_id"]),
	);
	expect(columns.map(({ name }) => name)).toEqual(["active", "created_at", null]);
	expect(columns.at(-1)?.cid).toBe(-1);
	expect(
		plan.some(({ detail }) =>
			/SEARCH memory_items USING INDEX idx_memory_items_(active_created|created_id)\b/.test(detail),
		),
	).toBe(true);
	expect(plan.some(({ detail }) => /USE TEMP B-TREE.*ORDER BY/i.test(detail))).toBe(false);
});

async function grant() {
	store.db
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
		coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		VALUES (?, 'Cursor scope', 'team', 'coordinator', 'cursor-coordinator', 'cursor-group', 3, 'active', ?, ?)`)
		.run(scopeId, now, now);
	store.db
		.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status,
		membership_epoch, coordinator_id, group_id, updated_at)
		VALUES (?, ?, 'member', 'active', 3, 'cursor-coordinator', 'cursor-group', ?)`)
		.run(scopeId, store.deviceId, now);
	await refreshTestScopeRows(store.db, { [store.deviceId]: publicKey });
}

function invalidateProof(scenario: string) {
	const statements: Record<string, string> = {
		membership: "UPDATE scope_memberships SET status = 'revoked'",
		epoch: "UPDATE replication_scopes SET membership_epoch = 4",
	};
	if (statements[scenario]) store.db.exec(statements[scenario]);
	if (scenario === "deny")
		store.db
			.prepare(`INSERT INTO recipient_policy_deny_overlays(
		canonical_project_identity, scope_id, device_id, generation, reason_code, created_at, updated_at)
		VALUES ('cursor-project', ?, ?, 1, 'fixture-denied', ?, ?)`)
			.run(scopeId, store.deviceId, now, now);
	if (scenario !== "key") return;
	const original = store.ownershipFilterContext.bind(store);
	const replacementPublicKey = syntheticPublicKey();
	vi.spyOn(store, "ownershipFilterContext").mockImplementation(() =>
		original({ expectedPublicKey: replacementPublicKey }),
	);
}

it.each(["current", "membership", "epoch", "deny", "key"])(
	"rechecks %s proof after decoding the same valid cursor",
	async (scenario) => {
		// Arrange: the token precedes both foreign and locally authored managed history.
		await grant();
		const foreign = seed({ scope: scopeId, at: "a" });
		store.db
			.prepare(`INSERT INTO project_scope_mappings(workspace_identity, project_pattern,
		scope_id, priority, source, created_at, updated_at) VALUES ('/tmp/test', '/tmp/test', ?, 100, 'user', ?, ?)`)
			.run(scopeId, now, now);
		const authored = store.remember(
			sessionId,
			"discovery",
			"Authored cursor history",
			"Immutable authored body",
			0.8,
			[],
			{},
		);
		store.db.prepare("UPDATE memory_items SET created_at = 'b' WHERE id = ?").run(authored);
		const anchor = seed({ at: "z" });
		const first = await page("paging=cursor&limit=1");
		const before = await continuation(first, "limit=10");
		invalidateProof(scenario);
		// Act: actor, database and selectors remain unchanged, so a 400 cannot hide stale authority.
		const after = await continuation(first, "limit=10");
		const full = await continuation(first, "limit=10&view=full");
		const projected = await continuation(first, "limit=10&view=feed");
		// Assert
		expect(first.items.map(({ id }) => id)).toEqual([anchor]);
		expect(before.items.map(({ id }) => id)).toEqual([authored, foreign]);
		let expected = [authored];
		if (scenario === "current") expected = [authored, foreign];
		if (scenario === "key") expected = [];
		expect(after.items.map(({ id }) => id)).toEqual(expected);
		expect(full.items.map(({ id }) => id)).toEqual(expected);
		expect(projected.items.map(({ id }) => id)).toEqual(expected);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it.each([
	"",
	" ",
	"arbitrary TEXT",
	"2026-01-01T00:00:00Z",
	"2026-01-01T00:00:00+09:00",
	"😀".repeat(128),
	"\u0000".repeat(256),
	"\u0001".repeat(256),
	"\ud800".repeat(256),
	"\udfff".repeat(256),
])("round-trips raw codec timestamp %j", (created_at) => {
	// Arrange
	const filter = feedCursorFilterKey({
		classification: "observation",
		actorId: "public-actor",
		dbPath: ":memory:",
	});
	const position = { created_at, id: Number.MAX_SAFE_INTEGER };
	// Act
	const token = encodeFeedCursor({ position, filter });
	const decoded = decodeFeedCursor({ cursor: token, filter });
	// Assert
	expect(decoded).toEqual(position);
	expect(token.length).toBeLessThanOrEqual(4096);
	expect(decodeFeedCursor({ cursor: token, filter: "0".repeat(64) })).toBeNull();
});

it.each([
	{ created_at: "x".repeat(257), id: 1 },
	{ created_at: "", id: 0 },
	{ created_at: "", id: Number.MAX_SAFE_INTEGER + 1 },
])("rejects invalid issuer position %j", (position) => {
	// Arrange
	const filter = "a".repeat(64);
	// Act
	const issue = () => encodeFeedCursor({ position, filter });
	// Assert
	expect(issue).toThrow();
});
