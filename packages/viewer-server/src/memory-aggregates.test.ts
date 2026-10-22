import { beforeEach, expect, it, vi } from "vitest";
import { refreshManagedScopeFixture } from "../../core/src/managed-scope-test-fixtures.js";
import {
	scopeId,
	useLocalCaptureFixture,
} from "../../core/src/memory-local-capture-test-fixtures.js";
import { insertTestSession } from "../../core/src/test-utils.js";
import { memoryRoutes } from "./routes/memory.js";

const { fixture, enroll, rememberScoped } = useLocalCaptureFixture();
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected test network request"));
});

async function seedAggregates() {
	enroll();
	await refreshManagedScopeFixture(fixture.store.db, {
		keysDir: fixture.keysDir,
		deviceId: fixture.store.deviceId,
		scopeIds: [scopeId],
	});
	// Genuine managed creation survives membership loss without duplicate counting.
	rememberScoped("Retained managed capture");
	const db = fixture.store.db;
	const other = insertTestSession(db);
	db.prepare("UPDATE sessions SET project = 'other-project' WHERE id = ?").run(other);
	const insert = db.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, metadata_json, tags_text, scope_id,
		 active, created_at, updated_at, project, origin_device_id, import_key)
		VALUES (?, ?, 'Replica', 'Body', ?, ?, ?, ?, '2026-01-01', '2026-01-01', ?, 'peer', ?)`);
	let sequence = 0;
	const add = (
		kind: string,
		metadata: string,
		tags: string,
		scope: string | null,
		active = 1,
		session = fixture.sessionId,
		project: string | null = "test-project",
	) => {
		insert.run(session, kind, metadata, tags, scope, active, project, `replica-${sequence++}`);
	};
	add("discovery", "{broken", " tag ", "local-default");
	add("session_summary", "{}", "summary", "local-default");
	add("discovery", '{"is_summary":true}', "", scopeId);
	add("discovery", '{"source":" OBSERVER_SUMMARY "}', "", scopeId);
	add("discovery", '{"is_summary":"true"}', "   ", scopeId);
	add("discovery", "{}", "", null);
	add("discovery", "{}", "hidden", "unknown-scope");
	add("session_summary", "{}", "hidden", "unknown-scope");
	add("discovery", "{}", "inactive", "local-default", 0);
	// Session project wins over the memory column, including conflicting explicit values.
	add("discovery", "[]", "other", "local-default", 1, other, null);
	add("discovery", "null", "", "local-default", 1, other, "test-project");
	return memoryRoutes(() => fixture.store);
}

it.each([
	{ query: "", memories: 9, observations: 6, revokedMemories: 6, revokedObservations: 5 },
	{
		query: "?project=test-project",
		memories: 7,
		observations: 4,
		revokedMemories: 4,
		revokedObservations: 3,
	},
	{
		query: "?project=other-project",
		memories: 2,
		observations: 2,
		revokedMemories: 2,
		revokedObservations: 2,
	},
	{
		query: "?project=absent",
		memories: 0,
		observations: 0,
		revokedMemories: 0,
		revokedObservations: 0,
	},
])(
	"session classifications preserve scoped/project counts and immediate revocation: $query",
	async (testCase) => {
		// Arrange
		const app = await seedAggregates();
		// Act
		const before = await app.request(`/api/session${testCase.query}`);
		fixture.store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		const after = await app.request(`/api/session${testCase.query}`);
		// Assert: counts include all summary forms, but observations exclude only true summaries.
		expect(before.status).toBe(200);
		expect(await before.json()).toEqual({
			total: testCase.memories,
			memories: testCase.memories,
			observations: testCase.observations,
			prompts: 0,
			artifacts: 0,
		});
		expect(after.status).toBe(200);
		expect(await after.json()).toEqual({
			total: testCase.revokedMemories,
			memories: testCase.revokedMemories,
			observations: testCase.revokedObservations,
			prompts: 0,
			artifacts: 0,
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it("uses one classification aggregate per request, not separate memory and observation scans", async () => {
	// Arrange
	const app = await seedAggregates();
	const prepare = vi.spyOn(fixture.store.db, "prepare");
	// Act
	await app.request("/api/session");
	await app.request("/api/session?project=test-project");
	const statements = prepare.mock.calls.map(([sql]) => sql);
	// Assert: both counts share the same SQL statement, including the project-filtered request.
	const counts = statements.filter((sql) => sql.includes("AS memories"));
	expect(counts).toHaveLength(2);
	for (const sql of counts) expect(sql).toContain("AS observations");
	expect(
		statements.filter((sql) => /SELECT COUNT\(\*\) AS total FROM memory_items/.test(sql)),
	).toEqual([]);
});

it("stats preserve active sessions and tag coverage while excluding hidden and inactive tags", async () => {
	// Arrange
	await seedAggregates();
	// Act
	const before = fixture.store.stats().database;
	fixture.store.db
		.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
		.run(scopeId);
	const after = fixture.store.stats().database;
	// Assert: inactive rows count toward total only; whitespace-only tags never count.
	expect(before).toMatchObject({
		memory_items: 10,
		active_memory_items: 9,
		sessions: 2,
		tags_filled: 3,
		tags_coverage: 3 / 9,
	});
	expect(after).toMatchObject({
		memory_items: 7,
		active_memory_items: 6,
		sessions: 2,
		tags_filled: 3,
		tags_coverage: 3 / 6,
	});
});
