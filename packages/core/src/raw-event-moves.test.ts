import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automaticSummarySession } from "./automatic-continuity.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { applyRawEventRelinkPlanWithDb } from "./maintenance/relink.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { resolveSessionScopeId } from "./scope-stamping.js";
import { MemoryStore } from "./store.js";

let directory: string;
let store: MemoryStore;
const host = "moving-host-session";
const event = (id: string, project: string, cwd = `/synthetic/${project}`) => ({
	source: "opencode",
	session_id: host,
	host_generation: "v2",
	event_id: id,
	event_type: "user_prompt",
	cwd,
	project,
	payload: { prompt_text: `Investigate ${project} parser validation before persistence` },
});

beforeEach(() => {
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	directory = mkdtempSync(join(tmpdir(), "codemem-session-moves-"));
	const dbPath = join(directory, "mem.sqlite");
	store = new MemoryStore(dbPath);
	const deviceId = store.deviceId;
	store.close();
	store = new MemoryStore(dbPath, {
		runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
	});
});
afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("capture across session moves", () => {
	it("retains every A-to-B-to-A event with independent cursors and the original host identity", () => {
		const alpha = ingestRawEvents(store, event("a1", "alpha")).sessions[0]?.streamId;
		const beta = ingestRawEvents(store, event("b1", "beta")).sessions[0]?.streamId;
		const back = ingestRawEvents(store, event("a2", "alpha")).sessions[0]?.streamId;
		expect(alpha).toBe(back);
		expect(alpha).not.toBe(beta);
		expect(
			store.db
				.prepare(
					"SELECT opencode_session_id, project, last_received_event_seq FROM raw_event_sessions ORDER BY project",
				)
				.all(),
		).toEqual([
			{ opencode_session_id: host, project: "alpha", last_received_event_seq: 1 },
			{ opencode_session_id: host, project: "beta", last_received_event_seq: 0 },
		]);
	});

	it("uses frozen envelope attribution when older deliveries arrive after the move", () => {
		const delayed = JSON.parse(JSON.stringify(event("old-alpha", "alpha")));
		ingestRawEvents(store, event("new-beta", "beta"));
		ingestRawEvents(store, delayed);
		expect(
			store.db
				.prepare(`SELECT r.event_id, s.project FROM raw_events r JOIN raw_event_sessions s
			ON s.source = r.source AND s.stream_id = r.stream_id ORDER BY r.event_id`)
				.all(),
		).toEqual([
			{ event_id: "new-beta", project: "beta" },
			{ event_id: "old-alpha", project: "alpha" },
		]);
	});

	it("does not duplicate a retained event if a retry carries another location", () => {
		ingestRawEvents(store, event("same-event", "alpha"));
		expect(ingestRawEvents(store, event("same-event", "beta"))).toMatchObject({
			inserted: 0,
			skipped: 1,
		});
		expect(store.db.prepare("SELECT event_id, opencode_session_id FROM raw_events").all()).toEqual([
			{ event_id: "same-event", opencode_session_id: host },
		]);
	});

	it("leaves pre-upgrade stream metadata and history unchanged", () => {
		const legacy = event("legacy", "wrong-project");
		ingestRawEvents(store, { ...legacy, host_generation: undefined });
		ingestRawEvents(store, event("corrected", "alpha"));
		expect(
			store.db.prepare("SELECT project FROM raw_event_sessions WHERE stream_id = ?").get(host),
		).toEqual({ project: "wrong-project" });
		expect(store.db.prepare("SELECT COUNT(*) AS count FROM raw_events").get()).toEqual({
			count: 2,
		});
	});
});

async function mapProjects() {
	const scopes = ["alpha", "beta"].map((project) =>
		cacheScope({ scope_id: `scope-${project}`, kind: "managed_project" }),
	);
	await refreshScopeMembershipCache(store.db, {
		coordinatorId: "server-a",
		groupIds: ["group-a"],
		fetchers: {
			listScopes: async () => ({ version: 1, items: scopes }),
			getScopeSnapshot: async (_groupId, scopeId) => {
				const scope = scopes.find((item) => item.scope_id === scopeId);
				if (!scope) throw new Error("Unknown synthetic scope");
				return cacheWireSnapshot(scope, [cacheMember(scope, store.deviceId)]);
			},
		},
	});
	for (const project of ["alpha", "beta"])
		store.db
			.prepare(`INSERT INTO project_scope_mappings
		(project_pattern, scope_id, priority, source, created_at, updated_at) VALUES (?, ?, 100, 'user', ?, ?)`)
			.run(
				`/synthetic/${project}*`,
				`scope-${project}`,
				new Date().toISOString(),
				new Date().toISOString(),
			);
}

const observerOptions = {
	observer: {
		runtime: "api_key",
		observe: async () => ({
			raw: "<observation><type>bugfix</type><title>Parser validation before persistence</title><narrative>The parser rejects invalid input before persistence.</narrative><facts><fact>Invalid input is rejected before persistence</fact></facts><concepts><concept>validation</concept></concepts><files_read><file>parser.ts</file></files_read><files_modified><file>parser.ts</file></files_modified></observation>",
			parsed: null,
			provider: "test",
			model: "test-model",
		}),
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "api_key",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	},
	storeSummary: false,
} as unknown as IngestOptions;

describe("extraction and recall after session moves", () => {
	it("creates memories in each captured project's scope and preserves host identity through flush", async () => {
		await mapProjects();
		const streams = [
			ingestRawEvents(store, event("alpha", "alpha")),
			ingestRawEvents(store, event("beta", "beta")),
			ingestRawEvents(store, event("worktree", "alpha", "/synthetic/alpha-worktree")),
		];
		for (const result of streams) {
			const streamId = result.sessions[0]?.streamId;
			if (!streamId) throw new Error("Missing stream");
			expect(
				await flushRawEvents(store, observerOptions, { opencodeSessionId: streamId }),
			).toMatchObject({ flushed: 1 });
		}
		expect(
			store.db
				.prepare(
					`SELECT s.project, m.scope_id FROM memory_items m JOIN sessions s ON s.id = m.session_id ORDER BY s.id`,
				)
				.all(),
		).toEqual([
			{ project: "alpha", scope_id: "scope-alpha" },
			{ project: "beta", scope_id: "scope-beta" },
		]);
		const nativeSessions = store.db
			.prepare("SELECT session_id FROM opencode_sessions ORDER BY session_id")
			.all() as Array<{ session_id: number }>;
		expect(
			nativeSessions.map((row) => resolveSessionScopeId(store.db, { sessionId: row.session_id })),
		).toEqual(["scope-alpha", "scope-beta", "scope-alpha"]);
		for (const table of [
			"raw_events",
			"raw_event_sessions",
			"raw_event_flush_batches",
			"opencode_sessions",
		]) {
			expect(store.db.prepare(`SELECT DISTINCT opencode_session_id FROM ${table}`).all()).toEqual([
				{ opencode_session_id: host },
			]);
		}
		for (const project of ["alpha", "beta"]) {
			const pack = store.buildMemoryPack(
				"parser validation",
				10,
				null,
				{ project },
				{
					source: "opencode",
					hostSessionId: host,
				},
			);
			const expected = store.db
				.prepare(
					`SELECT m.id FROM memory_items m JOIN sessions s ON s.id = m.session_id WHERE s.project = ?`,
				)
				.all(project) as Array<{ id: number }>;
			expect(pack.item_ids).toEqual(expected.map((row) => row.id));
		}
	});
});

describe("automatic recall after session moves", () => {
	it("keeps automatic summary lookup inside the current project across worktrees", () => {
		const context = { source: "opencode", hostSessionId: host };
		const alpha = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: host,
			streamId: "alpha-stream",
			project: "alpha",
			cwd: "/synthetic/alpha",
		});
		const beta = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: host,
			streamId: "beta-stream",
			project: "beta",
			cwd: "/synthetic/beta",
		});
		expect(automaticSummarySession(store.db, context, "alpha")).toBe(alpha);
		expect(automaticSummarySession(store.db, context, "beta")).toBe(beta);
		expect(automaticSummarySession(store.db, context)).toBeNull();
		store.remember(
			alpha,
			"session_summary",
			"Alpha move summary",
			"Alpha parser validation before moving",
			0.9,
		);
		store.remember(
			beta,
			"session_summary",
			"Beta move summary",
			"Beta parser validation after moving",
			0.9,
		);
		const worktree = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: host,
			streamId: "alpha-worktree",
			project: "alpha",
			cwd: "/synthetic/alpha-worktree",
		});
		expect(automaticSummarySession(store.db, context, "alpha")).toBe(alpha);
		const pack = store.buildMemoryPack("move summary", 10, null, { project: "alpha" }, context);
		expect(pack.pack_text).toContain("Alpha move summary");
		expect(pack.pack_text).not.toContain("Beta move summary");
		store.remember(
			worktree,
			"session_summary",
			"Worktree move summary",
			"Alpha worktree parser validation continued",
			0.9,
		);
		expect(automaticSummarySession(store.db, context, "alpha")).toBe(worktree);
	});
});

describe("repair after session moves", () => {
	it("keeps separate native sessions and restores the original host mapping", () => {
		for (const project of ["alpha", "beta"]) {
			store.getOrCreateSessionForOpencodeSession({
				opencodeSessionId: host,
				streamId: `${project}-stream`,
				cwd: `/synthetic/${project}`,
				project,
				metadata: {
					session_context: {
						source: "opencode",
						flusher: "raw_events",
						streamId: `${project}-stream`,
						opencodeSessionId: host,
					},
				},
			});
		}
		store.db.prepare("DELETE FROM opencode_sessions WHERE stream_id = ?").run("alpha-stream");
		const repaired = applyRawEventRelinkPlanWithDb(store.db);
		expect(repaired.totals.bridge_creations).toBe(1);
		expect(repaired.totals.session_compactions).toBe(0);
		expect(
			store.db
				.prepare("SELECT stream_id, opencode_session_id FROM opencode_sessions ORDER BY stream_id")
				.all(),
		).toEqual([
			{ stream_id: "alpha-stream", opencode_session_id: host },
			{ stream_id: "beta-stream", opencode_session_id: host },
		]);
	});
});
