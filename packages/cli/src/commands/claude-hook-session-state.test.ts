import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildInjectQuery,
	clearSessionState,
	defaultSessionState,
	extractModifiedPathsFromHook,
	loadSessionState,
	saveSessionState,
	statePathForSession,
	trackHookSessionState,
	workingSetPathsFromState,
} from "./claude-hook-session-state.js";

describe("claude-hook-session-state", () => {
	let stateDir: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR;
		stateDir = mkdtempSync(join(tmpdir(), "codemem-cli-claude-hook-state-"));
		process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR = stateDir;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR;
		else process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR = originalEnv;
		rmSync(stateDir, { recursive: true, force: true });
	});

	describe("statePathForSession", () => {
		it("derives a deterministic filesystem-safe path per session id", () => {
			const a = statePathForSession("session-A");
			const b = statePathForSession("session-A");
			const c = statePathForSession("session-B");
			expect(a).toBe(b);
			expect(a).not.toBe(c);
			expect(a.startsWith(stateDir)).toBe(true);
			expect(a.endsWith(".json")).toBe(true);
		});

		it("keeps long session ids within filename limits", () => {
			const path = statePathForSession("session-".repeat(200));
			expect(basename(path).length).toBeLessThanOrEqual(64);
		});
	});

	describe("loadSessionState", () => {
		it("returns default state when no file exists", () => {
			expect(loadSessionState("missing")).toEqual(defaultSessionState());
		});

		it("returns default state when file is malformed JSON", () => {
			saveSessionState("ok", {
				first_prompt: "kept",
				last_prompt: "kept",
				files_modified: [],
				updated_at: "",
			});
			const path = statePathForSession("ok");
			writeFileSync(path, "not-json", "utf8");
			expect(loadSessionState("ok")).toEqual(defaultSessionState());
		});

		it("normalizes and caps fields when reading back", () => {
			saveSessionState("normalize", {
				first_prompt: "  first  ",
				last_prompt: "  last  ",
				files_modified: ["  a.ts  ", "", "b.ts"],
				updated_at: "2026-04-09T00:00:00Z",
			});
			const loaded = loadSessionState("normalize");
			expect(loaded.first_prompt).toBe("first");
			expect(loaded.last_prompt).toBe("last");
			expect(loaded.files_modified).toEqual(["a.ts", "b.ts"]);
			expect(loaded.updated_at).toBe("2026-04-09T00:00:00Z");
		});
	});

	describe("saveSessionState + clearSessionState", () => {
		it("roundtrips state through disk", () => {
			const original = {
				first_prompt: "investigate flaky test",
				last_prompt: "now check the fixture",
				files_modified: ["packages/cli/src/foo.ts", "packages/cli/src/bar.ts"],
				updated_at: "2026-04-09T01:00:00Z",
			};
			saveSessionState("rt", original);
			const path = statePathForSession("rt");
			expect(existsSync(path)).toBe(true);

			const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			expect(persisted.first_prompt).toBe(original.first_prompt);
			expect(persisted.files_modified).toEqual(original.files_modified);

			expect(loadSessionState("rt")).toEqual(original);
		});

		it("clear removes the state file", () => {
			saveSessionState("clr", {
				first_prompt: "x",
				last_prompt: "x",
				files_modified: [],
				updated_at: "",
			});
			const path = statePathForSession("clr");
			expect(existsSync(path)).toBe(true);
			clearSessionState("clr");
			expect(existsSync(path)).toBe(false);
		});

		it("clear is a no-op when the file does not exist", () => {
			expect(() => clearSessionState("never-saved")).not.toThrow();
		});
	});

	describe("extractModifiedPathsFromHook", () => {
		it("returns paths for Edit/Write/MultiEdit/NotebookEdit tool inputs", () => {
			expect(
				extractModifiedPathsFromHook({
					tool_name: "Edit",
					tool_input: { filePath: "packages/cli/src/a.ts" },
				}),
			).toEqual(["packages/cli/src/a.ts"]);

			expect(
				extractModifiedPathsFromHook({
					tool_name: "write",
					tool_input: { file_path: "packages/cli/src/b.ts" },
				}),
			).toEqual(["packages/cli/src/b.ts"]);

			expect(
				extractModifiedPathsFromHook({
					tool_name: "NotebookEdit",
					tool_input: { path: "notebooks/c.ipynb" },
				}),
			).toEqual(["notebooks/c.ipynb"]);
		});

		it("falls back to apply_patch `patch` field when `patchText` is an empty string", () => {
			// `??` would stop at the empty string and miss the real patch.
			expect(
				extractModifiedPathsFromHook({
					tool_name: "apply_patch",
					tool_input: {
						patchText: "",
						patch: "*** Add File: packages/cli/src/fallback.ts\n+content",
					},
				}),
			).toEqual(["packages/cli/src/fallback.ts"]);
		});

		it("parses apply_patch patchText for Add/Update/Delete entries", () => {
			const patch = [
				"*** Begin Patch",
				"*** Update File: packages/cli/src/x.ts",
				"@@",
				"-old",
				"+new",
				"*** Add File: packages/cli/src/y.ts",
				"+brand new",
				"*** Delete File: packages/cli/src/z.ts",
				"*** End Patch",
			].join("\n");

			expect(
				extractModifiedPathsFromHook({
					tool_name: "apply_patch",
					tool_input: { patchText: patch },
				}),
			).toEqual(["packages/cli/src/x.ts", "packages/cli/src/y.ts", "packages/cli/src/z.ts"]);
		});

		it("returns empty for non-mutating tools", () => {
			expect(
				extractModifiedPathsFromHook({
					tool_name: "Read",
					tool_input: { filePath: "packages/cli/src/a.ts" },
				}),
			).toEqual([]);
		});

		it("dedupes overlapping path keys preserving first-seen order", () => {
			expect(
				extractModifiedPathsFromHook({
					tool_name: "edit",
					tool_input: {
						filePath: "shared.ts",
						file_path: "shared.ts",
						path: "other.ts",
					},
				}),
			).toEqual(["shared.ts", "other.ts"]);
		});
	});

	describe("trackHookSessionState", () => {
		it("returns null when payload has no usable session id", () => {
			expect(trackHookSessionState({ hook_event_name: "UserPromptSubmit" })).toBeNull();
			expect(
				trackHookSessionState({ session_id: "   ", hook_event_name: "UserPromptSubmit" }),
			).toBeNull();
		});

		it("UserPromptSubmit sets first_prompt once and keeps tracking last_prompt", () => {
			const sessionId = "track-1";
			trackHookSessionState({
				session_id: sessionId,
				hook_event_name: "UserPromptSubmit",
				prompt: "investigate flaky test",
			});
			let state = loadSessionState(sessionId);
			expect(state.first_prompt).toBe("investigate flaky test");
			expect(state.last_prompt).toBe("investigate flaky test");

			trackHookSessionState({
				session_id: sessionId,
				hook_event_name: "UserPromptSubmit",
				prompt: "now check the fixture",
			});
			state = loadSessionState(sessionId);
			expect(state.first_prompt).toBe("investigate flaky test"); // unchanged
			expect(state.last_prompt).toBe("now check the fixture");
		});

		it("PostToolUse appends modified files and dedupes across calls", () => {
			const sessionId = "track-2";
			trackHookSessionState({
				session_id: sessionId,
				hook_event_name: "PostToolUse",
				tool_name: "edit",
				tool_input: { filePath: "packages/cli/src/a.ts" },
			});
			trackHookSessionState({
				session_id: sessionId,
				hook_event_name: "PostToolUseFailure",
				tool_name: "write",
				tool_input: { file_path: "packages/cli/src/b.ts" },
			});
			trackHookSessionState({
				session_id: sessionId,
				hook_event_name: "PostToolUse",
				tool_name: "edit",
				tool_input: { filePath: "packages/cli/src/a.ts" }, // duplicate
			});
			const state = loadSessionState(sessionId);
			expect(state.files_modified).toEqual(["packages/cli/src/a.ts", "packages/cli/src/b.ts"]);
		});

		it("SessionEnd clears the on-disk state", () => {
			const sessionId = "track-3";
			trackHookSessionState({
				session_id: sessionId,
				hook_event_name: "UserPromptSubmit",
				prompt: "kick off work",
			});
			expect(existsSync(statePathForSession(sessionId))).toBe(true);

			const result = trackHookSessionState({
				session_id: sessionId,
				hook_event_name: "SessionEnd",
			});
			expect(result).toBeNull();
			expect(existsSync(statePathForSession(sessionId))).toBe(false);
		});

		it("returns loaded state without writing for unrelated events", () => {
			const sessionId = "track-4";
			const result = trackHookSessionState({
				session_id: sessionId,
				hook_event_name: "SessionStart",
			});
			expect(result).toEqual(defaultSessionState());
			expect(existsSync(statePathForSession(sessionId))).toBe(false);
		});
	});

	describe("buildInjectQuery", () => {
		it("returns 'recent work' when nothing useful is available", () => {
			expect(buildInjectQuery({ prompt: "", project: null, state: null })).toBe("recent work");
		});

		it("includes first_prompt + project + file basenames, skipping duplicate prompt", () => {
			const state = {
				first_prompt: "investigate flaky test",
				last_prompt: "investigate flaky test",
				files_modified: ["packages/cli/src/foo.ts", "packages/cli/src/bar.ts"],
				updated_at: "",
			};
			const query = buildInjectQuery({
				prompt: "investigate flaky test", // identical to first_prompt → skipped
				project: "codemem",
				state,
			});
			expect(query).toBe("investigate flaky test codemem foo.ts bar.ts");
		});

		it("includes the current prompt when it differs from first_prompt", () => {
			const state = {
				first_prompt: "kick off work",
				last_prompt: "now check fixture",
				files_modified: [],
				updated_at: "",
			};
			const query = buildInjectQuery({
				prompt: "now check fixture",
				project: null,
				state,
			});
			expect(query).toBe("kick off work now check fixture");
		});

		it("drops short current prompts (length <= 5) to avoid noise", () => {
			const query = buildInjectQuery({
				prompt: "fix",
				project: "codemem",
				state: defaultSessionState(),
			});
			expect(query).toBe("codemem");
		});

		it("caps the query at 500 characters", () => {
			const query = buildInjectQuery({
				prompt: "x".repeat(2000),
				project: null,
				state: defaultSessionState(),
			});
			expect(query.length).toBe(500);
		});
	});

	describe("workingSetPathsFromState", () => {
		it("returns the last 8 paths only", () => {
			const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
			const state = {
				first_prompt: "",
				last_prompt: "",
				files_modified: files,
				updated_at: "",
			};
			expect(workingSetPathsFromState(state)).toEqual(files.slice(-8));
		});

		it("returns an empty array when state is null", () => {
			expect(workingSetPathsFromState(null)).toEqual([]);
		});
	});
});
