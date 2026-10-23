import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileContextRunner, type FileContextRunnerOptions } from "./file-context.js";
import type { RefQueryResult } from "./ref-queries.js";
import { tryUpdateRetrievalDelivery } from "./retrieval-ledger.js";
import { recordRetrievalSurface, resolveRetrievalSession } from "./retrieval-surface-ledger.js";
import type { MemoryStore } from "./store.js";

vi.mock("./retrieval-ledger.js", () => ({ tryUpdateRetrievalDelivery: vi.fn() }));
vi.mock("./retrieval-surface-ledger.js", () => ({
	recordRetrievalSurface: vi.fn(),
	resolveRetrievalSession: vi.fn(() => null),
}));

const timestamp = "2026-04-15T12:00:00Z";
const request = { relativePath: "auth.ts", project: "codemem", fileMtimeMs: 0 };
// Same baseline row as the CLI parity fixtures, without filesystem or database setup.
const row = (overrides: Partial<RefQueryResult> = {}): RefQueryResult => ({
	id: 1,
	session_id: 1,
	kind: "decision",
	title: "Untitled",
	subtitle: null,
	body_text: "",
	narrative: null,
	confidence: 0.5,
	tags_text: "",
	created_at: timestamp,
	updated_at: timestamp,
	files_read: null,
	files_modified: null,
	concepts: null,
	metadata_json: null,
	...overrides,
});

function fixture(rows = [row()], overrides: Partial<FileContextRunnerOptions> = {}) {
	const findByFile = vi.fn(() => rows);
	const store = { db: {} as MemoryStore["db"], findByFile };
	const dependencies = {
		getStore: vi.fn(() => store),
		findByFile,
		sourceSessionId: "claude-session-1",
		recordAttempt: vi.fn<NonNullable<FileContextRunnerOptions["recordAttempt"]>>(),
		updateDelivery: vi.fn<NonNullable<FileContextRunnerOptions["updateDelivery"]>>(),
		log: vi.fn(),
		now: () => new Date(timestamp),
		createAttemptId: () => "attempt-1",
	};
	return {
		...dependencies,
		runner: createFileContextRunner({ ...dependencies, ...overrides }),
		store,
	};
}

afterEach(() => vi.clearAllMocks());

describe("createFileContextRunner selection parity", () => {
	it.each(["codemem", null])(
		"fetches 40 candidates with project %s and displays only 15",
		(project) => {
			// Arrange: equal scores retain query order, not reversed numeric IDs.
			const rows = Array.from({ length: 40 }, (_, i) => row({ id: 40 - i, session_id: i }));
			const f = fixture(rows, { findByFile: undefined });
			// Act
			const result = f.runner.run({ ...request, project });
			// Assert
			expect(f.store.findByFile).toHaveBeenCalledWith("auth.ts", {
				limit: 40,
				...(project ? { project } : {}),
			});
			expect(f.recordAttempt).toHaveBeenCalledWith(
				expect.objectContaining({
					candidateIds: rows.map((r) => r.id),
					candidateCount: 40,
					selectedIds: rows.slice(0, 15).map((r) => r.id),
				}),
			);
			const text = result.hookSpecificOutput?.additionalContext ?? "";
			expect(text.match(/\(decision\)/g)).toHaveLength(15);
			expect(text).toContain(
				"memory.get_observations([40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26])",
			);
			expect(text).not.toMatch(/^25 /m);
		},
	);

	it("scores files_modified, ignores files_read breadth, and dedupes by origin session", () => {
		// Arrange: reuse the CLI's broad crawl / older targeted-fix case, plus ties.
		const f = fixture([
			row({ id: 200, session_id: 9, files_modified: '["a.ts","b.ts","c.ts","d.ts"]' }),
			row({
				id: 201,
				session_id: 9,
				files_modified: '["auth.ts"]',
				files_read: JSON.stringify(Array(50).fill("other.ts")),
			}),
			row({ id: 202, session_id: 9, files_modified: '["auth.ts"]' }),
			row({ id: 203, session_id: 10, files_modified: '["auth.ts","b.ts"]' }),
			row({ id: 204, session_id: 11, files_modified: '["other.ts"]', files_read: '["auth.ts"]' }),
			row({ id: 205, session_id: 12, files_modified: '["auth.ts","b.ts","c.ts","d.ts"]' }),
		]);
		// Act
		const result = f.runner.run(request);
		// Assert: target+one=4, target+two=3, non-target+one=2, target+four=2.
		expect(f.recordAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ selectedIds: [201, 203, 204, 205] }),
		);
		expect(result.hookSpecificOutput?.additionalContext).not.toMatch(/\b(200|202)\b/);
		expect(f.getStore).not.toHaveBeenCalled();
	});

	it.each([null, "not json", "{}", '[3,null,"other.ts"]'])(
		"handles malformed/non-array modified metadata %s without losing context",
		(files_modified) => {
			// Arrange
			const f = fixture([
				row({ id: 1, files_modified }),
				row({ id: 2, files_modified: '["src\\\\auth.ts"]' }),
			]);
			// Act
			const result = f.runner.run({ ...request, relativePath: "src/auth.ts" });
			// Assert: normalized modified-path match beats malformed/non-matching metadata.
			expect(f.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ selectedIds: [2] }));
			expect(result.hookSpecificOutput?.additionalContext).toContain(
				"memory.get_observations([2])",
			);
		},
	);
});

describe("createFileContextRunner timeline parity", () => {
	it("escapes paths and titles, orders days and times, and omits invalid dates from the timeline", () => {
		// Arrange: noon UTC avoids local day boundaries; no timezone-dependent time assertions.
		const f = fixture([
			row({ id: 1, session_id: 1, title: "Latest", created_at: "2026-04-16T14:00:00Z" }),
			row({
				id: 2,
				session_id: 2,
				title: ` Earlier\r\n\t${"x".repeat(170)}`,
				created_at: "2026-04-16T12:00:00Z",
				kind: "unknown",
			}),
			row({ id: 3, session_id: 3, title: "First day", created_at: timestamp }),
			row({ id: 4, session_id: 4, title: "Invalid date", created_at: "invalid" }),
			row({ id: 5, session_id: 5, title: "Epoch date", created_at: "1970-01-01T00:00:00Z" }),
			row({ id: 6, session_id: 6, title: "", created_at: timestamp }),
		]);
		// Act
		const result = f.runner.run({ ...request, relativePath: 'src\\"odd\nfile.ts' });
		// Assert
		const text = result.hookSpecificOutput?.additionalContext ?? "";
		expect(text).toContain('src\\\\\\"odd\\nfile.ts');
		expect(text).toContain(`❔ (unknown) ${`Earlier ${"x".repeat(170)}`.slice(0, 160)}\n`);
		expect(text).toContain("(decision) Untitled");
		expect(text.indexOf("First day")).toBeLessThan(text.indexOf("Earlier"));
		expect(text.indexOf("Earlier")).toBeLessThan(text.indexOf("Latest"));
		expect(text).not.toMatch(/Invalid date|Epoch date|\r|\t/);
		expect(text).toContain("memory.get_observations([1, 2, 3, 4, 5, 6])");
	});

	it.each([
		{ drift: 300_000, stale: false },
		{ drift: 300_001, stale: true },
		{ drift: -1, stale: false },
		{ drift: Number.NaN, stale: false },
	])("uses the strict five-minute staleness boundary for drift $drift", ({ drift, stale }) => {
		// Arrange
		const f = fixture();
		// Act
		const result = f.runner.run({ ...request, fileMtimeMs: Date.parse(timestamp) + drift });
		// Assert
		expect(result.hookSpecificOutput?.additionalContext?.includes("Heads up")).toBe(stale);
		expect(f.log).toHaveBeenCalledWith(expect.stringContaining(`stale=${stale}`));
	});

	it.each(["invalid", "1970-01-01T00:00:00Z"])("does not infer staleness from %s", (created_at) => {
		// Arrange
		const f = fixture([row({ created_at })]);
		// Act
		const result = f.runner.run({ ...request, fileMtimeMs: Date.parse(timestamp) });
		// Assert: IDs remain fetchable even when no date can be rendered.
		expect(result.hookSpecificOutput?.additionalContext).toContain("memory.get_observations([1])");
		expect(result.hookSpecificOutput?.additionalContext).not.toMatch(/Heads up|###/);
	});

	it("checks staleness against selected observations, not a discarded newer candidate", () => {
		// Arrange
		const f = fixture([
			row({ id: 2, created_at: "2026-04-16T12:00:00Z", files_modified: '["a","b","c","d"]' }),
			row({ files_modified: '["auth.ts"]' }),
		]);
		// Act
		const result = f.runner.run({ ...request, fileMtimeMs: Date.parse(timestamp) + 300_001 });
		// Assert
		expect(result.hookSpecificOutput?.additionalContext).toContain("Heads up");
		expect(result.hookSpecificOutput?.additionalContext).toContain("memory.get_observations([1])");
	});
});

describe("createFileContextRunner skip and retrieval parity", () => {
	it.each(["file_context_disabled", "outside_cwd", "stat_failed", "below_size_gate"] as const)(
		"records %s without querying or attempting delivery",
		(reason) => {
			// Arrange
			const stages = {
				file_context_disabled: "configuration",
				outside_cwd: "path_validation",
				stat_failed: "file_access",
				below_size_gate: "size_gate",
			};
			const f = fixture();
			const repositoryPaths = reason === "outside_cwd" ? undefined : ["auth.ts"];
			// Act
			const result = f.runner.skip({ reason, repositoryPaths });
			// Assert
			expect(result).toEqual({ continue: true });
			expect(f.recordAttempt).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					retrievalStatus: "skipped",
					deliveryStatus: "not_attempted",
					failureCode: reason,
					failureStage: stages[reason],
				}),
			);
			expect(f.recordAttempt.mock.calls[0]?.[0].repositoryPaths).toEqual(repositoryPaths);
			expect(f.findByFile).not.toHaveBeenCalled();
			expect(f.updateDelivery).not.toHaveBeenCalled();
		},
	);

	it.each(["empty", "throw"])("records %s retrieval without delivery", (mode) => {
		// Arrange
		const f = fixture([]);
		if (mode === "throw")
			f.findByFile.mockImplementation(() => {
				throw new Error("private query detail");
			});
		// Act
		const result = f.runner.run(request);
		// Assert
		expect(result).toEqual({ continue: true });
		expect(f.recordAttempt).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				retrievalStatus: mode === "empty" ? "no_results" : "failed",
				deliveryStatus: "not_attempted",
				project: "codemem",
				filters: { project: "codemem" },
				repositoryPaths: ["auth.ts"],
			}),
		);
		if (mode === "throw")
			expect(f.recordAttempt.mock.calls[0]?.[0]).toMatchObject({
				failureCode: "query_failed",
				failureStage: "retrieval",
			});
		expect(JSON.stringify(f.recordAttempt.mock.calls)).not.toContain("private query detail");
		expect(f.updateDelivery).not.toHaveBeenCalled();
	});
});

describe("createFileContextRunner ledger parity", () => {
	it.each(["claude-session-1", null])(
		"records nullable caller session %s using the default ledger adapters",
		(sourceSessionId) => {
			// Arrange
			const sessionId = sourceSessionId ? 7 : null;
			vi.mocked(resolveRetrievalSession).mockReturnValueOnce(sessionId);
			const f = fixture(undefined, {
				sourceSessionId,
				recordAttempt: undefined,
				updateDelivery: undefined,
			});
			// Act
			const result = f.runner.run({ ...request, project: null });
			// Assert
			expect(result.hookSpecificOutput?.permissionDecision).toBe("allow");
			expect(resolveRetrievalSession).toHaveBeenCalledWith(f.store.db, "claude", sourceSessionId);
			expect(recordRetrievalSurface).toHaveBeenCalledWith(
				f.store.db,
				expect.objectContaining({
					attemptId: "attempt-1",
					source: "claude",
					streamId: sourceSessionId,
					sourceSessionId,
					sessionId,
					surface: "file_context",
					trigger: "automatic",
					mode: "claude_pre_tool_use_read",
					recorderVersion: "claude-file-context-v1",
					startedAt: new Date(timestamp).toISOString(),
					completedAt: new Date(timestamp).toISOString(),
					latencyMs: 0,
					project: null,
					filters: undefined,
				}),
			);
			expect(tryUpdateRetrievalDelivery).toHaveBeenCalledWith(
				f.store.db,
				"attempt-1",
				"handed_off",
			);
		},
	);

	it.each(["run", "skip"] as const)(
		"does not acquire storage for disabled-ledger %s with an injected query",
		(operation) => {
			// Arrange
			const f = fixture(undefined, { ledgerEnabled: () => false });
			// Act
			const result =
				operation === "run" ? f.runner.run(request) : f.runner.skip({ reason: "stat_failed" });
			// Assert
			expect(Boolean(result.hookSpecificOutput)).toBe(operation === "run");
			expect(f.getStore).not.toHaveBeenCalled();
			expect(f.recordAttempt).not.toHaveBeenCalled();
			expect(f.updateDelivery).not.toHaveBeenCalled();
		},
	);

	it.each(["recordAttempt", "updateDelivery"] as const)(
		"still delivers when %s throws",
		(callback) => {
			// Arrange
			const fail = vi.fn(() => {
				throw new Error("ledger unavailable");
			});
			const f = fixture(undefined, { [callback]: fail });
			// Act
			const result = f.runner.run(request);
			// Assert
			expect(result.hookSpecificOutput).toMatchObject({
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
			});
			expect(fail).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps skip fail-open when acquiring storage for its ledger fails", () => {
		// Arrange
		const getStore = vi.fn(() => {
			throw new Error("store unavailable");
		});
		const f = fixture(undefined, { recordAttempt: undefined, getStore });
		// Act
		const result = f.runner.skip({ reason: "file_context_disabled" });
		// Assert
		expect(result).toEqual({ continue: true });
		expect(getStore).toHaveBeenCalledTimes(1);
		expect(f.findByFile).not.toHaveBeenCalled();
	});

	it("keeps skip fail-open when its ledger callback throws", () => {
		// Arrange
		const recordAttempt = vi.fn(() => {
			throw new Error("ledger unavailable");
		});
		const f = fixture(undefined, { recordAttempt });
		// Act
		const result = f.runner.skip({ reason: "file_context_disabled" });
		// Assert
		expect(result).toEqual({ continue: true });
		expect(recordAttempt).toHaveBeenCalledTimes(1);
		expect(f.getStore).not.toHaveBeenCalled();
	});
});

describe("createFileContextRunner delivery parity", () => {
	it.each([false, true])(
		"records selection before formatting and delivery before return (format fails: %s)",
		(fails) => {
			// Arrange: title access marks formatting without mocking the renderer itself.
			const events: string[] = [];
			const selected = row();
			Object.defineProperty(selected, "title", {
				get() {
					events.push("format");
					if (fails) throw new Error("bad title");
					return "Selected then delivered";
				},
			});
			const recordAttempt = vi.fn(() => {
				events.push("selection");
			});
			const updateDelivery = vi.fn((_id: string, status: string) => {
				events.push(status);
			});
			const f = fixture([selected], { recordAttempt, updateDelivery });
			// Act
			const result = f.runner.run(request);
			events.push("return");
			// Assert
			expect(events).toEqual(["selection", "format", fails ? "failed" : "handed_off", "return"]);
			expect(recordAttempt).toHaveBeenCalledWith(
				expect.objectContaining({
					retrievalStatus: "succeeded",
					deliveryStatus: "not_attempted",
					candidateIds: [1],
					selectedIds: [1],
				}),
			);
			expect(updateDelivery).toHaveBeenCalledExactlyOnceWith(
				"attempt-1",
				fails ? "failed" : "handed_off",
			);
			if (fails) expect(result).toEqual({ continue: true });
			else
				expect(result.hookSpecificOutput?.additionalContext).toContain("Selected then delivered");
		},
	);
});
