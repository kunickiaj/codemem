import { createHash, generateKeyPairSync } from "node:crypto";
import { fingerprintPublicKey, insertTestSession, MemoryStore } from "@codemem/core";
import type { FeedListItem } from "@codemem/core/feed-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordForeignMemoryRevision } from "../../core/src/memory-creation-provenance.js";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { createApp } from "./index.js";
import { memoryRoutes } from "./routes/memory.js";

vi.mock("../../core/src/observer-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../core/src/observer-config.js")>()),
	readCodememConfigFile: () => ({}),
}));

const now = "2026-11-01T00:00:00.000Z";
const scopeId = "feed-managed";
const hiddenContext = "Detailed context with enough useful content to remain readable.";
let store: MemoryStore;
let sessionId: number;
let app: ReturnType<typeof memoryRoutes>;
let publicKey: string;

function syntheticPublicKey() {
	const { publicKey: key } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(key.export({ format: "jwk" }).x ?? "", "base64url");
	const prefix = Buffer.from("0000000b7373682d6564323535313900000020", "hex");
	return `ssh-ed25519 ${Buffer.concat([prefix, raw]).toString("base64")}`;
}

beforeEach(() => {
	vi.stubEnv("CODEMEM_DEVICE_ID", "feed-reader");
	vi.stubEnv("CODEMEM_ACTOR_ID", "feed-author");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
	vi.spyOn(MemoryStore.prototype, "enqueueVectorWrite").mockImplementation(() => {});
	publicKey = syntheticPublicKey();
	store = new MemoryStore(":memory:", {
		runtimeSigningKey: { deviceId: "feed-reader", publicKey },
	});
	store.db
		.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(store.deviceId, publicKey, fingerprintPublicKey(publicKey), now);
	sessionId = insertTestSession(store.db);
	app = memoryRoutes(() => store);
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function seed(
	input: {
		kind?: string;
		body?: string;
		metadata?: unknown;
		scope?: string | null;
		actor?: string;
		active?: number;
	} = {},
) {
	const metadata = input.metadata ?? { facts: ["Visible key point"], narrative: hiddenContext };
	const structured =
		typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {};
	return Number(
		store.db
			.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, created_at, updated_at, metadata_json,
		 scope_id, actor_id, origin_device_id, active, project, tags_text, facts, narrative)
		VALUES (?, ?, 'Useful feed observation', ?, ?, ?, ?, ?, ?, 'replica-device', ?, 'test-project', 'feed', ?, ?)`)
			.run(
				sessionId,
				input.kind ?? "discovery",
				input.body ?? "Legacy searchable body",
				now,
				now,
				typeof metadata === "string" ? metadata : JSON.stringify(metadata),
				input.scope ?? null,
				input.actor ?? "other-author",
				input.active ?? 1,
				JSON.stringify(structured.facts ?? []),
				structured.narrative ?? null,
			).lastInsertRowid,
	);
}

async function page(path = "/api/observations?view=feed") {
	const response = await app.request(path);
	expect(response.status).toBe(200);
	return response.json() as Promise<{ items: FeedListItem[]; pagination: Record<string, unknown> }>;
}

async function grant() {
	store.db
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
		coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		VALUES (?, 'Feed scope', 'team', 'coordinator', 'feed-coordinator', 'feed-group', 3, 'active', ?, ?)`)
		.run(scopeId, now, now);
	store.db
		.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status,
		membership_epoch, coordinator_id, group_id, updated_at)
		VALUES (?, ?, 'member', 'active', 3, 'feed-coordinator', 'feed-group', ?)`)
		.run(scopeId, store.deviceId, now);
	await refreshTestScopeRows(store.db, { [store.deviceId]: publicKey });
}

it.each(["observations", "summaries"])(
	"keeps %s IDs, ordering, pagination and enrichment",
	async (route) => {
		// Arrange: tied timestamps exercise the ID tie-breaker and an extra page.
		const kind = route === "summaries" ? "session_summary" : "discovery";
		store.db
			.prepare(`INSERT INTO actors(actor_id, display_name, is_local, created_at, updated_at)
				VALUES (?, 'Synthetic Author', 1, ?, ?)
				ON CONFLICT(actor_id) DO UPDATE SET display_name = excluded.display_name`)
			.run(store.actorId, now, now);
		const ids = Array.from({ length: 4 }, () => seed({ kind, actor: store.actorId }));
		seed({ kind, active: 0 });
		seed({ kind, scope: "unreadable-scope" });
		// Act
		const full = await page(`/api/${route}?limit=2&offset=1`);
		const projected = await page(`/api/${route}?view=feed&limit=2&offset=1`);
		const empty = await page(`/api/${route}?view=feed&project=absent`);
		// Assert: full responses retain their legacy body and metadata.
		expect(projected.items.map(({ id }) => id)).toEqual(ids.reverse().slice(1, 3));
		expect(projected.items.map(({ id }) => id)).toEqual(full.items.map(({ id }) => id));
		expect(projected.pagination).toEqual(full.pagination);
		expect(projected.pagination).toMatchObject({
			limit: 2,
			offset: 1,
			next_offset: 3,
			has_more: true,
		});
		for (const [index, item] of projected.items.entries()) {
			const original = full.items[index];
			expect(original).not.toHaveProperty("feed");
			expect(original?.body_text).toBe("Legacy searchable body");
			for (const field of [
				"kind",
				"project",
				"session_id",
				"actor_id",
				"owned_by_self",
				"resolved_actor_display_name",
			] as const)
				expect(item[field]).toEqual(original?.[field]);
			expect(item.resolved_actor_display_name).toBe("Synthetic Author");
			expect(item.feed.version).toBe(1);
		}
		expect(empty.items).toEqual([]);
		expect(empty.pagination).toMatchObject({ next_offset: null, has_more: false });
	},
);

it("omits hidden and arbitrary metadata regardless of their size", async () => {
	// Arrange
	const id = seed();
	const first = await page();
	store.db
		.prepare("UPDATE memory_items SET body_text = ?, metadata_json = ?, narrative = ? WHERE id = ?")
		.run(
			"duplicate".repeat(100_000),
			JSON.stringify({
				facts: ["Visible key point"],
				narrative: hiddenContext.repeat(20_000),
				files: ["src/example.ts"],
				arbitrary: "secret-marker".repeat(100_000),
			}),
			hiddenContext.repeat(20_000),
			id,
		);
	// Act
	const large = await page();
	// Assert: an exact allowlist prevents future full-row fields leaking into the DTO.
	const allowed = new Set([
		"id",
		"session_id",
		"kind",
		"title",
		"created_at",
		"updated_at",
		"project",
		"owned_by_self",
		"actor_id",
		"actor_display_name",
		"resolved_actor_display_name",
		"visibility",
		"trust_state",
		"workspace_kind",
		"origin_source",
		"origin_device_id",
		"resolved_device_display_name",
		"facts",
		"tags",
		"files",
		"body_text",
		"narrative",
		"metadata_json",
		"feed",
	]);
	expect(Object.keys(large.items[0] ?? {}).every((key) => allowed.has(key))).toBe(true);
	expect(JSON.stringify(large).length).toBe(JSON.stringify(first).length);
	expect(JSON.stringify(large)).not.toContain("secret-marker");
	expect(large.items[0]).toMatchObject({
		facts: ["Visible key point"],
		files: [],
		body_text: "",
		narrative: "",
		feed: { full_context: { revision: expect.any(String) } },
	});
});

it.each([true, false])("retains canonical summary kind for strict flag %s", async (summary) => {
	// Arrange: the stored kind is an observation in both cases.
	const id = seed({
		metadata: { is_summary: summary, facts: ["Visible fact"], narrative: hiddenContext },
	});
	const route = summary ? "summaries" : "observations";
	// Act
	const full = await page(`/api/${route}`);
	const projected = await page(`/api/${route}?view=feed`);
	// Assert
	expect(full.items[0]?.kind).toBe(summary ? "session_summary" : "discovery");
	expect(projected.items[0]).toMatchObject({
		id,
		kind: full.items[0]?.kind,
		feed: { version: 1, query: "", matches_query: false, search_match: null },
	});
	expect(projected.items[0]?.feed.full_context === null).toBe(summary);
});

it.each([
	{ body: "ls", expected: true },
	{ body: "A meaningful description of the observed behavior", expected: false },
])("computes low-signal evidence from the original body: $expected", async ({ body, expected }) => {
	// Arrange
	seed({ body });
	// Act
	const projected = await page();
	// Assert: the omitted body still determines the original low-signal state.
	expect(projected.items[0]?.body_text).toBe("");
	expect(projected.items[0]?.feed.low_signal).toBe(expected);
});

it.each([
	{
		name: "facts and narrative",
		metadata: { facts: ["Fact"], narrative: hiddenContext },
		body: "Legacy",
		narrative: "",
		visibleBody: "",
		hidden: true,
	},
	{
		name: "facts without narrative",
		metadata: { facts: ["Fact"] },
		body: "Legacy",
		narrative: "",
		visibleBody: "",
		hidden: false,
	},
	{
		name: "narrative without facts",
		metadata: { narrative: hiddenContext },
		body: "Legacy",
		narrative: hiddenContext,
		visibleBody: "",
		hidden: false,
	},
	{
		name: "blank facts",
		metadata: { facts: ["  ", ""], narrative: hiddenContext },
		body: "Legacy",
		narrative: hiddenContext,
		visibleBody: "",
		hidden: false,
	},
	{
		name: "legacy body",
		metadata: {},
		body: "Legacy",
		narrative: "",
		visibleBody: "Legacy",
		hidden: false,
	},
	{
		name: "malformed metadata",
		metadata: "{broken",
		body: "Legacy",
		narrative: "",
		visibleBody: "Legacy",
		hidden: false,
	},
	{
		name: "summary",
		kind: "session_summary",
		metadata: { facts: ["Fact"], narrative: hiddenContext },
		body: "Legacy",
		narrative: hiddenContext,
		visibleBody: "",
		hidden: false,
	},
	{
		name: "numeric summary flag is false",
		metadata: { is_summary: 1, facts: ["Fact"], narrative: hiddenContext },
		body: "Legacy",
		narrative: "",
		visibleBody: "",
		hidden: true,
	},
])("preserves the expanded visible body for $name", async (input) => {
	// Arrange
	const id = seed({ kind: input.kind, body: input.body, metadata: input.metadata });
	const route = input.kind === "session_summary" ? "summaries" : "observations";
	// Act
	const result = await page(`/api/${route}?view=feed`);
	const detail = await app.request(`/api/memory/${id}/context`);
	// Assert
	expect(result.items[0]).toMatchObject({
		id,
		body_text: input.visibleBody,
		narrative: input.narrative,
	});
	expect(Boolean(result.items[0]?.feed.full_context)).toBe(input.hidden);
	expect(detail.status).toBe(input.hidden ? 200 : 404);
});

it.each(["body", "metadata", "unicode"])(
	"keeps %s-only search matches after projection",
	async (source) => {
		// Arrange
		const query = source === "unicode" ? "İSTANBUL" : "orchardneedle";
		const text = `Searchable ${query} content`;
		const id = seed({
			body: source === "body" ? text : "Legacy body",
			metadata: {
				facts: ["Visible fact"],
				narrative: hiddenContext,
				...(source !== "body" ? { summary: { request: text } } : {}),
			},
		});
		seed();
		const search = new URLSearchParams({ q: query });
		// Act
		const full = await page(`/api/observations?${search}`);
		const projected = await page(`/api/observations?view=feed&${search}`);
		const missing = await page("/api/observations?view=feed&q=does-not-match");
		// Assert
		expect(full.items.map((item) => item.id)).toEqual([id]);
		expect(projected.items.map((item) => item.id)).toEqual([id]);
		expect(projected.items[0]?.feed).toMatchObject({
			query: query.toLowerCase(),
			matches_query: true,
			search_match: { label: "Body", excerpt: expect.stringContaining(query) },
		});
		expect(missing.items).toEqual([]);
	},
);

it("preserves the observations alias query and the recent-memory collection", async () => {
	// Arrange
	const first = seed();
	const second = seed();
	const query = "?view=feed&limit=1&offset=1&q=useful&scope=theirs&project=test-project";
	// Act
	const alias = await app.request(`/api/memories${query}`);
	const recent = await app.request(`/api/memory?id=${first}&limit=2`);
	const collection = await recent.json();
	// Assert
	expect(alias.status).toBe(301);
	expect(alias.headers.get("location")).toBe(`/api/observations${query}`);
	expect(recent.status).toBe(200);
	expect(collection.items.map((item: { id: number }) => item.id).sort()).toEqual([first, second]);
	expect(collection.items[0]).not.toHaveProperty("feed");
});
it("returns only exact context, an opaque digest and no-store headers", async () => {
	// Arrange
	const id = seed();
	const list = await page();
	// Act
	const response = await app.request(
		`/api/memory/${id}/context?project=test-project&scope=theirs&q=useful&classification=observation`,
	);
	const body = await response.json();
	store.db
		.prepare("UPDATE memory_items SET narrative = ? WHERE id = ?")
		.run(`${hiddenContext} changed`, id);
	const changed = await app.request(`/api/memory/${id}/context`);
	// Assert
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(body).toEqual({
		id,
		context: hiddenContext,
		revision: createHash("sha256").update(hiddenContext).digest("hex"),
	});
	expect(list.items[0]?.feed.full_context).toEqual({ revision: body.revision });
	expect((await changed.json()).revision).not.toBe(body.revision);
});

it.each(["0", "-1", "01", "1.0", "1e0", "+1", "9007199254740992", "abc"])(
	"rejects noncanonical or unsafe ID %s",
	async (id) => {
		// Arrange
		seed();
		// Act
		const response = await app.request(`/api/memory/${encodeURIComponent(id)}/context`);
		// Assert
		expect(response.status).toBe(400);
	},
);

it("rejects unknown classification rather than ignoring it", async () => {
	// Arrange
	const id = seed();
	// Act
	const response = await app.request(`/api/memory/${id}/context?classification=unknown`);
	// Assert
	expect(response.status).toBe(400);
});

it.each([
	"absent",
	"inactive",
	"scope",
	"project",
	"query",
	"classification",
	"no context",
	"context removed",
])("uses uniform 404 for %s", async (reason) => {
	// Arrange
	const id = seed({
		active: reason === "inactive" ? 0 : 1,
		metadata: reason === "no context" ? {} : undefined,
	});
	if (reason === "context removed")
		store.db.prepare("UPDATE memory_items SET narrative = NULL WHERE id = ?").run(id);
	const suffix: Record<string, string> = {
		scope: "scope=mine",
		project: "project=absent",
		query: "q=not-present",
		classification: "classification=summary",
	};
	// Act
	const response = await app.request(
		`/api/memory/${reason === "absent" ? id + 1 : id}/context?${suffix[reason] ?? ""}`,
	);
	// Assert
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "memory not found" });
});

it("matches legacy active=1 eligibility even with a deletion timestamp", async () => {
	// Arrange
	const id = seed();
	store.db.prepare("UPDATE memory_items SET deleted_at = ? WHERE id = ?").run(now, id);
	// Act
	const full = await page("/api/observations");
	const projected = await page();
	const response = await app.request(`/api/memory/${id}/context`);
	// Assert
	expect(full.items.map((item) => item.id)).toEqual([id]);
	expect(projected.items.map((item) => item.id)).toEqual([id]);
	expect(response.status).toBe(200);
});

it.each([
	"current proof",
	"raw membership",
	"revoked",
	"advanced epoch",
	"archived",
	"policy denied",
	"missing key",
	"replaced key",
])("uses retained proof for %s across read scope modes", async (scenario) => {
	// Arrange: the real cache writer validates injected snapshots, without key files or network.
	await grant();
	const id = seed({ scope: scopeId });
	const before = await page();
	invalidateProof(scenario);
	const readable = scenario === "current proof";
	// Act
	const results = await Promise.all(
		["all", "mine", "theirs"].map(async (scope) => ({
			list: await page(`/api/observations?view=feed&scope=${scope}`),
			full: await page(`/api/observations?scope=${scope}`),
			detail: await app.request(
				`/api/memory/${id}/context?scope=${scope}&revision=${before.items[0]?.feed.full_context?.revision}`,
			),
			expected: readable && scope !== "mine",
		})),
	);
	// Assert: possession of an earlier revision never authorizes a later request.
	expect(before.items.map((item) => item.id)).toEqual([id]);
	for (const result of results) {
		expect(result.list.items.map((item) => item.id)).toEqual(result.expected ? [id] : []);
		expect(result.list.items.map((item) => item.id)).toEqual(
			result.full.items.map((item) => item.id),
		);
		expect(result.detail.status).toBe(result.expected ? 200 : 404);
		if (!result.expected) expect(await result.detail.json()).toEqual({ error: "memory not found" });
	}
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([
	"immutable creation",
	"raw membership",
	"advanced epoch",
	"archived",
	"policy denied",
	"missing key",
	"replaced key",
	"edited creation",
	"foreign revision",
])("preserves authored-history reads for %s after revocation", async (scenario) => {
	// Arrange: capture provenance through remember, never fabricate an authorization row.
	await grant();
	store.db
		.prepare(`INSERT INTO project_scope_mappings(workspace_identity, project_pattern,
			scope_id, priority, source, created_at, updated_at) VALUES ('/tmp/test', '/tmp/test', ?, 100, 'user', ?, ?)`)
		.run(scopeId, now, now);
	const id = store.remember(
		sessionId,
		"discovery",
		"Authored feed history",
		"Immutable authored body",
		0.8,
		[],
		{ facts: ["Visible authored fact"], narrative: hiddenContext },
	);
	store.db.exec("UPDATE scope_memberships SET status = 'revoked'");
	invalidateProof(scenario);
	expect(
		(
			store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").get(id) as {
				scope_id: string;
			}
		).scope_id,
	).toBe(scopeId);
	if (scenario === "edited creation")
		store.db.prepare("UPDATE memory_items SET body_text = 'Changed content' WHERE id = ?").run(id);
	if (scenario === "foreign revision") {
		const row = store.db.prepare("SELECT import_key FROM memory_items WHERE id = ?").get(id) as {
			import_key: string;
		};
		store.db.transaction(() =>
			recordForeignMemoryRevision(store.db, row.import_key, "replication"),
		)();
	}
	// Act
	const list = await page("/api/observations?view=feed&scope=mine");
	const detail = await app.request(`/api/memory/${id}/context?scope=mine`);
	// Assert
	const readable = !["missing key", "replaced key", "edited creation", "foreign revision"].includes(
		scenario,
	);
	expect(list.items.map((item) => item.id)).toEqual(readable ? [id] : []);
	expect(detail.status).toBe(readable ? 200 : 404);
	if (!readable) expect(await detail.json()).toEqual({ error: "memory not found" });
});

function invalidateProof(scenario: string) {
	if (scenario === "policy denied")
		store.db
			.prepare(`INSERT INTO recipient_policy_deny_overlays(
		canonical_project_identity, scope_id, device_id, generation, reason_code, created_at, updated_at)
		VALUES ('test-project', ?, ?, 1, 'fixture-denied', ?, ?)`)
			.run(scopeId, store.deviceId, now, now);
	const statements: Record<string, string> = {
		"raw membership": "DELETE FROM scope_membership_authorization_evidence",
		revoked: "UPDATE scope_memberships SET status = 'revoked'",
		"advanced epoch":
			"UPDATE replication_scopes SET membership_epoch = 4 WHERE scope_id = 'feed-managed'",
		archived: "UPDATE replication_scopes SET status = 'archived' WHERE scope_id = 'feed-managed'",
	};
	const sql = statements[scenario];
	if (sql) store.db.exec(sql);
	if (scenario !== "missing key" && scenario !== "replaced key") return;
	const original = store.ownershipFilterContext.bind(store);
	vi.spyOn(store, "ownershipFilterContext").mockImplementation(() =>
		original({
			expectedPublicKey: scenario === "missing key" ? "" : syntheticPublicKey(),
		}),
	);
}

it.each([
	{ mismatch: "database", code: "viewer_db_mismatch" },
	{ mismatch: "identity", code: "viewer_identity_mismatch" },
])("rejects a mismatched $mismatch target before reading context", async ({ mismatch, code }) => {
	// Arrange: use the assembled app so this checks middleware registration on the new URL.
	const id = seed();
	const viewer = createApp({ storeFactory: () => store });
	const profile = await (await viewer.request("/api/prompt-pack-profile")).json();
	const query = new URLSearchParams({
		db_path: mismatch === "database" ? `${store.dbPath}.other` : store.dbPath,
		identity_target: JSON.stringify({
			...profile.identity_target,
			...(mismatch === "identity" ? { device_id: "other-reader" } : {}),
		}),
	});
	const reads = vi.spyOn(store.db, "prepare");
	// Act
	const response = await viewer.request(`/api/memory/${id}/context?${query}`);
	// Assert: rejecting the target must precede both row access and context serialization.
	expect(response.status).toBe(409);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toMatchObject({ error: { code } });
	expect(reads.mock.calls.some(([sql]) => /\b(?:FROM|JOIN)\s+memory_items\b/i.test(sql))).toBe(
		false,
	);
});

it.each(["matching", "untargeted"])("returns eligible context for a %s request", async (target) => {
	// Arrange
	const id = seed();
	const viewer = createApp({ storeFactory: () => store });
	const profile = await (await viewer.request("/api/prompt-pack-profile")).json();
	const query = new URLSearchParams();
	if (target === "matching") {
		query.set("db_path", store.dbPath);
		query.set("identity_target", JSON.stringify(profile.identity_target));
	}
	// Act
	const response = await viewer.request(`/api/memory/${id}/context?${query}`);
	// Assert: targets select the viewer instance without replacing ordinary read eligibility.
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({
		id,
		context: hiddenContext,
		revision: createHash("sha256").update(hiddenContext).digest("hex"),
	});
});

it("rejects malformed identity JSON before reading context and disables caching", async () => {
	// Arrange
	const id = seed();
	const viewer = createApp({ storeFactory: () => store });
	const query = new URLSearchParams({ db_path: store.dbPath, identity_target: "{broken" });
	const reads = vi.spyOn(store.db, "prepare");
	// Act
	const response = await viewer.request(`/api/memory/${id}/context?${query}`);
	// Assert
	expect(response.status).toBe(400);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
	expect(reads.mock.calls.some(([sql]) => /\b(?:FROM|JOIN)\s+memory_items\b/i.test(sql))).toBe(
		false,
	);
});
