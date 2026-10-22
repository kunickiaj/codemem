import { join } from "node:path";
import { queryRetrievalAttempts } from "@codemem/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedProvenMixedScopeFixture } from "../../../core/src/managed-scope-test-fixtures.js";
import { useLocalCaptureFixture } from "../../../core/src/memory-local-capture-test-fixtures.js";
import type { MixedScopeFixture } from "../../../core/src/test-utils.js";
import { buildClaudeFileContext } from "./claude-hook-file-context.js";

const { fixture, enroll } = useLocalCaptureFixture();
let scopes: MixedScopeFixture;
let deniedIds: number[];
const file = "src/security.ts";

beforeEach(async () => {
	enroll("file-context-device");
	scopes = await seedProvenMixedScopeFixture(
		fixture.store.db,
		fixture.keysDir,
		fixture.store.deviceId,
	);
	vi.stubEnv("CODEMEM_PLUGIN_IGNORE", "0");
	vi.stubEnv("CODEMEM_FILE_CONTEXT", "1");
	vi.stubEnv("CODEMEM_FILE_CONTEXT_MIN_BYTES", "1500");
	vi.stubEnv("CODEMEM_RETRIEVAL_LEDGER", "1");
	vi.stubEnv("CODEMEM_PROJECT", "mixed-domain-fixture");
	vi.stubEnv("CODEMEM_PLUGIN_LOG_PATH", join(fixture.dir, "plugin.log"));
	const db = fixture.store.db;
	db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(scopes.personalId);
	deniedIds = [scopes.unauthorizedId];
	// More denied newer rows than the CLI's 40-row fetch window.
	for (let n = 0; n < 45; n++) {
		const id = Number(
			db
				.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text,
			confidence, tags_text, active, created_at, updated_at, metadata_json, visibility, scope_id, import_key)
			VALUES (?, 'decision', ?, 'denied CLI body', 0.9, '', 1, '2099-01-01', '2099-01-01', '{}', 'shared', ?, ?)`)
				.run(
					scopes.sessionId,
					`Denied CLI observation ${n}`,
					scopes.unauthorizedScopeId,
					`cli-denied-${n}`,
				).lastInsertRowid,
		);
		deniedIds.push(id);
	}
	for (const id of [scopes.authorizedId, ...deniedIds]) {
		db.prepare(
			"INSERT INTO memory_file_refs(memory_id, file_path, relation) VALUES (?, ?, 'modified')",
		).run(id, file);
		db.prepare("UPDATE memory_items SET files_modified = ? WHERE id = ?").run(
			JSON.stringify([file]),
			id,
		);
	}
});

async function runHook(project = "mixed-domain-fixture") {
	// Keep production query/store/ledger code; only filesystem stat and time are synthetic.
	vi.stubEnv("CODEMEM_PROJECT", project);
	return buildClaudeFileContext(
		{ tool_input: { file_path: file }, cwd: fixture.dir, project },
		{ dbPath: join(fixture.dir, "memory.sqlite") },
		{
			statFile: () => ({ sizeBytes: 2000, mtimeMs: 0 }),
			now: () => new Date("2026-10-01T00:00:00Z"),
			createAttemptId: () => "018f2db4-f9d3-7a22-8d18-000000000011",
		},
	);
}

describe("CLI production file-context visibility", () => {
	it("returns the older authorized observation and never surfaces denied IDs or content", async () => {
		// Arrange: authorized scope has real fixture proof; denied rows dominate recency.
		const authorized = scopes.authorizedId;
		// Act
		const result = await runHook();
		const attempt = queryRetrievalAttempts(fixture.store.db, {
			surface: "file_context",
			limit: 1,
		})[0];
		// Assert: authorization must happen before the CLI's candidate window and deduplication.
		const text = result.hookSpecificOutput?.additionalContext ?? "";
		expect(text).toContain(scopes.visibleTitles[1]);
		expect(text).toMatch(new RegExp(`\\b${authorized}\\b`));
		expect(text).not.toContain("Denied CLI observation");
		expect(text).not.toContain("denied CLI body");
		expect(text).not.toContain(scopes.unauthorizedTitle);
		expect(attempt).toMatchObject({
			candidateCount: 1,
			selectedCount: 1,
			retrievalStatus: "succeeded",
		});
		expect(attempt?.exposures.map(({ memoryId }) => memoryId)).toEqual([authorized]);
		expect(text).toContain(`memory.get_observations([${authorized}])`);
		for (const id of deniedIds) expect(text).not.toMatch(new RegExp(`^${id} `, "m"));
	});

	it.each(["revoked membership", "wrong project"])(
		"returns no observations after %s",
		async (reason) => {
			// Arrange: leave all denied replicas active so a missing predicate would leak content.
			if (reason === "revoked membership")
				fixture.store.db
					.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
					.run(scopes.authorizedScopeId);
			// Act
			const result = await runHook(reason === "wrong project" ? "another-project" : undefined);
			const attempt = queryRetrievalAttempts(fixture.store.db, {
				surface: "file_context",
				limit: 1,
			})[0];
			// Assert: the hook still permits the tool call, without any memory IDs/content or exposures.
			expect(result).toEqual({ continue: true });
			expect(attempt).toMatchObject({
				candidateCount: 0,
				selectedCount: 0,
				retrievalStatus: "no_results",
			});
			expect(attempt?.exposures).toEqual([]);
		},
	);
});
