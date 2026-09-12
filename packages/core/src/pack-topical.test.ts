import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemoryPackTrace } from "./pack.js";
import * as retrieval from "./search.js";
import { MemoryStore } from "./store.js";

let store: MemoryStore;
let session: number;
const automatic = { source: "opencode", hostSessionId: "synthetic-topical" };

function useTopicalFixture() {
	beforeEach(() => {
		store = new MemoryStore(":memory:");
		session = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: automatic.hostSessionId,
			project: "synthetic",
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		store.close();
	});
}

describe("topical pack routing", () => {
	useTopicalFixture();
	it.each(["continue", "resume", "next"])(
		"keeps %s with a named topic out of backlog mode",
		(verb) => {
			const topic = store.remember(
				session,
				"feature",
				"Orchid indexing",
				"Orchid indexing uses segments.",
				0.9,
			);
			const unrelated = store.remember(
				session,
				"decision",
				"Pending invoice task",
				"TODO: continue invoice cleanup next.",
				0.9,
			);
			const trace = buildMemoryPackTrace(
				store,
				`${verb} Orchid indexing`,
				10,
				null,
				undefined,
				undefined,
				undefined,
				automatic,
			);
			expect(trace.mode.selected).toBe("default");
			expect(trace.assembly.sections.timeline[0]).toBe(topic);
			// A shared query word can still retrieve the weaker row; it must not win.
			expect(trace.assembly.sections.timeline[0]).not.toBe(unrelated);
		},
	);

	it.each([
		"show backlog",
		"pending tasks",
		"list todos",
		"follow-ups",
		"show me pending tasks for Orchid",
		"list tasks for Orchid",
		" PLEASE show us OUR open pending todos about Orchid?! ",
		"the my our pending open follow ups",
		"list followup in Orchid",
		"show\tme\tpending\ttasks\tfor\tOrchid",
		"show tasks for\nOrchid",
	])("supports explicit task browsing: %s", (query) => {
		const id = store.remember(
			session,
			"decision",
			"Pending invoice task",
			"TODO: reconcile invoices.",
			0.9,
		);
		const trace = buildMemoryPackTrace(
			store,
			query,
			10,
			null,
			undefined,
			undefined,
			undefined,
			automatic,
		);
		expect(trace.mode.selected).toBe("task");
		expect(Object.values(trace.assembly.sections).flat()).toContain(id);
	});

	it.each([
		{
			query: "debug the task queue crash",
			title: "Task queue crash",
			body: "The queue crashes while dispatching retries.",
		},
		{
			query: "why is the request pending",
			title: "Pending request state",
			body: "The request remains pending while its lease is renewed.",
		},
		{
			query: "explain backlog processing",
			title: "Backlog processing",
			body: "The scheduler processes its backlog in bounded batches.",
		},
	])("treats technical task vocabulary as a topic: $query", ({ query, title, body }) => {
		// Arrange
		const topic = store.remember(session, "bugfix", title, body, 0.9);
		store.remember(session, "decision", "Unrelated follow-up", "TODO: reconcile invoices.", 0.9);

		// Act
		const trace = buildMemoryPackTrace(
			store,
			query,
			10,
			null,
			undefined,
			undefined,
			undefined,
			automatic,
		);

		// Assert
		expect(trace.mode.selected).toBe("default");
		expect(trace.assembly.sections.timeline[0]).toBe(topic);
	});
});

describe("linear task intent parsing", () => {
	useTopicalFixture();
	it.each([
		"please tasks",
		"show me tasks Orchid",
		"show tasks for",
		"follow\tups",
		"follow  ups",
		"show tasks for Orchid\nindexing",
		"tasKs",
	])("preserves unsupported grammar: %s", (query) => {
		expect(buildMemoryPackTrace(store, query).mode.selected).toBe("default");
	});

	it("handles long near-matching requests and suffix paths without backtracking", () => {
		const queries = [
			{ query: `show ${"open ".repeat(20_000)}tasks trailing`, mode: "default" },
			{ query: `show ${" ".repeat(100_000)}!`, mode: "default" },
			{ query: `tasks${"!".repeat(100_000)}`, mode: "task" },
			{ query: `tasks${"!".repeat(100_000)}x`, mode: "default" },
		];
		// Keep this regression focused on parsing; retrieval has its own input contracts.
		vi.spyOn(retrieval, "search").mockReturnValue([]);
		for (const { query, mode } of queries) {
			expect(buildMemoryPackTrace(store, query).mode.selected).toBe(mode);
		}
		for (const { path, basename } of [
			{ path: `src/${"/".repeat(100_000)}x`, basename: "x" },
			{ path: `src/file.ts${"/".repeat(100_000)}`, basename: "file.ts" },
			{ path: "C:\\src\\file.ts\\", basename: "file.ts" },
			{ path: "/".repeat(100_000), basename: "" },
		]) {
			const suffix = ["synthetic", basename].filter(Boolean).join(" ");
			const trace = buildMemoryPackTrace(store, `list tasks ${suffix}`, 10, null, {
				project: "synthetic",
				working_set_paths: [path],
			});
			expect(trace.mode.selected).toBe("task");
		}
	});
});

describe("automatic topical fallback", () => {
	useTopicalFixture();
	it.each([
		"Orchid indexing",
		"remember Orchid indexing",
		"resume Orchid indexing",
		"multitasking scheduler",
		"debug the task queue crash",
		"why is the request pending",
		"show the task queue crash",
		"explain backlog processing",
		"show how the scheduler queues tasks",
	])("leaves an automatic miss empty: %s", (query) => {
		store.remember(
			session,
			"decision",
			"Invoice reconciliation",
			"Accounting totals are balanced.",
			0.9,
		);
		store.remember(
			session,
			"session_summary",
			"Accounting recap",
			"Invoices were reconciled.",
			0.9,
		);
		store.remember(
			session,
			"discovery",
			"Accounting observation",
			"Invoice batches complete overnight.",
			0.9,
		);
		const trace = buildMemoryPackTrace(
			store,
			query,
			10,
			null,
			undefined,
			undefined,
			undefined,
			automatic,
		);
		expect(trace.mode.selected).not.toBe("task");
		expect(Object.values(trace.assembly.sections).flat()).toEqual([]);
	});

	it("preserves manual miss browsing and intentional manual or automatic recap", () => {
		// Arrange
		const fact = store.remember(
			session,
			"decision",
			"Invoice reconciliation",
			"Accounting totals are balanced.",
			0.9,
		);
		const summary = store.remember(
			session,
			"session_summary",
			"Accounting handoff",
			"Invoices were reconciled.",
			0.9,
		);

		// Act
		const manual = buildMemoryPackTrace(store, "Orchid indexing");
		const manualRecap = buildMemoryPackTrace(store, "recap");
		const recap = buildMemoryPackTrace(
			store,
			"recap",
			10,
			null,
			undefined,
			undefined,
			undefined,
			automatic,
		);

		// Assert
		expect(Object.values(manual.assembly.sections).flat()).toContain(fact);
		expect(manualRecap.assembly.sections.summary).toContain(summary);
		expect(recap.assembly.sections.summary).toContain(summary);
	});
});

describe("automatic topical scope", () => {
	useTopicalFixture();
	it("keeps automatic summaries on the requester session and durable results in the project", () => {
		// Arrange
		const siblingSession = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "synthetic-sibling",
			project: "synthetic",
		});
		const otherProjectSession = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "other-project",
			project: "other-project",
		});
		const currentSummary = store.remember(
			session,
			"session_summary",
			"Orchid indexing recap",
			"Current Orchid indexing summary.",
			0.9,
		);
		const durable = store.remember(
			siblingSession,
			"decision",
			"Orchid indexing segments",
			"Orchid indexing uses durable segment boundaries.",
			0.9,
		);
		const siblingSummary = store.remember(
			siblingSession,
			"session_summary",
			"Orchid indexing sibling recap",
			"Sibling Orchid indexing summary.",
			0.9,
		);
		const otherProject = store.remember(
			otherProjectSession,
			"decision",
			"Orchid indexing foreign project",
			"Other-project Orchid indexing details.",
			0.9,
		);

		// Act
		const trace = buildMemoryPackTrace(
			store,
			"recap Orchid indexing",
			10,
			null,
			{ project: "synthetic" },
			undefined,
			undefined,
			automatic,
		);
		const selected = Object.values(trace.assembly.sections).flat();

		// Assert
		expect(selected).toContain(currentSummary);
		expect(selected).toContain(durable);
		expect(selected).not.toContain(siblingSummary);
		expect(selected).not.toContain(otherProject);
	});
});

describe("automatic timeline expansion", () => {
	useTopicalFixture();
	it("keeps quartz recall topical automatically while manual recall expands neighbors", () => {
		const before = store.remember(session, "discovery", "Accounting", "Invoices balance.", 0.9);
		const anchor = store.remember(session, "decision", "Quartz", "Quartz uses segments.", 0.9);
		const after = store.remember(session, "feature", "Tooling", "Formatter configuration.", 0.9);
		const query = "What did we decide last time about quartz?";
		const automaticTrace = buildMemoryPackTrace(
			store,
			query,
			10,
			null,
			undefined,
			undefined,
			undefined,
			automatic,
		);
		const manual = buildMemoryPackTrace(store, query);
		expect([...new Set(Object.values(automaticTrace.assembly.sections).flat())]).toEqual([anchor]);
		expect(Object.values(manual.assembly.sections).flat()).toEqual(
			expect.arrayContaining([before, anchor, after]),
		);
	});
});

describe("automatic recap fallback scope", () => {
	useTopicalFixture();
	it("does not expand a matching automatic recap into unrelated timeline observations", () => {
		const summary = store.remember(
			session,
			"session_summary",
			"Yesterday handoff",
			"Accounting completed.",
			0.9,
		);
		store.remember(session, "discovery", "Unrelated tooling", "Use a different formatter.", 0.9);
		const trace = buildMemoryPackTrace(
			store,
			"what happened yesterday",
			10,
			null,
			undefined,
			undefined,
			undefined,
			automatic,
		);
		expect(Object.values(trace.assembly.sections).flat()).toEqual([summary]);
	});
	it.each(["recap of the sprint", "what happened yesterday"])(
		"falls back only to the requester's summary: %s",
		(query) => {
			const summary = store.remember(
				session,
				"session_summary",
				"Accounting handoff",
				"Invoices balanced.",
				0.9,
			);
			store.remember(
				session,
				"discovery",
				"Unrelated accounting detail",
				"Invoice batches complete overnight.",
				0.9,
			);
			const foreign = store.getOrCreateSessionForOpencodeSession({
				opencodeSessionId: "foreign-recap",
				project: "synthetic",
			});
			store.remember(
				foreign,
				"session_summary",
				"Sprint recap yesterday",
				"What happened during the sprint.",
				0.9,
			);
			store.remember(foreign, "decision", "Unrelated tooling", "Use a different formatter.", 0.9);
			for (const requester of [
				automatic,
				null,
				{ source: "opencode", hostSessionId: "unknown" },
				{ source: "opencode", hostSessionId: "unmapped" },
			]) {
				const trace = buildMemoryPackTrace(
					store,
					query,
					10,
					null,
					{ project: "synthetic" },
					undefined,
					undefined,
					requester,
				);
				const expected = requester === automatic ? [summary] : [];
				expect(Object.values(trace.assembly.sections).flat()).toEqual(expected);
			}
		},
	);
	it("leaves a mapped recap miss empty when the requester has no summary", () => {
		store.remember(
			session,
			"discovery",
			"Accounting detail",
			"Invoice batches complete overnight.",
			0.9,
		);
		const trace = buildMemoryPackTrace(
			store,
			"recap of the sprint",
			10,
			null,
			undefined,
			undefined,
			undefined,
			automatic,
		);
		expect(Object.values(trace.assembly.sections).flat()).toEqual([]);
	});
});

describe("topical pack ordering", () => {
	useTopicalFixture();
	it.each(["Orchid indexing", "recall Orchid indexing", "list tasks for Orchid indexing"])(
		"preserves retrieval order through timeline and observations: %s",
		(query) => {
			const ids = ["feature", "discovery", "refactor", "exploration", "decision"].map(
				(kind, index) =>
					store.remember(
						session,
						kind,
						`Orchid ${index}`,
						`Segment design ${index}`,
						0.9,
						index === 4 ? ["Orchid", "indexing", "recall", "tasks"] : [],
					),
			);
			const rows = retrieval.search(store, "Orchid", 10);
			const ranked = ids.map((id) => {
				const row = rows.find((row) => row.id === id);
				if (!row) throw new Error(`Missing synthetic memory ${id}`);
				return row;
			});
			vi.spyOn(retrieval, "search").mockReturnValue(ranked);
			const trace = buildMemoryPackTrace(
				store,
				query,
				10,
				null,
				undefined,
				undefined,
				{ compressionMode: "off" },
				automatic,
			);
			expect(Object.values(trace.assembly.sections).flat()).toEqual(ids);
		},
	);

	it("does not supplement a small automatic topical hit with unrelated observations or summary", () => {
		const id = store.remember(session, "feature", "Orchid indexing", "Segment design", 0.9);
		store.remember(session, "decision", "Accounting rule", "Reconcile invoices", 0.9);
		store.remember(session, "session_summary", "Accounting handoff", "Invoices balanced", 0.9);
		const trace = buildMemoryPackTrace(
			store,
			"Orchid indexing",
			10,
			null,
			undefined,
			undefined,
			undefined,
			automatic,
		);
		expect([...new Set(Object.values(trace.assembly.sections).flat())]).toEqual([id]);
	});
});
