import { describe, expect, it } from "vitest";
import { extractApplyPatchPaths, MUTATING_TOOL_NAMES } from "./apply-patch.js";

describe("MUTATING_TOOL_NAMES", () => {
	it("includes OpenCode and Claude Code file-mutation tools", () => {
		expect(MUTATING_TOOL_NAMES.has("edit")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("write")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("multiedit")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("notebookedit")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("apply_patch")).toBe(true);
	});

	it("does not include read/search tools", () => {
		expect(MUTATING_TOOL_NAMES.has("read")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("grep")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("glob")).toBe(false);
	});
});

describe("extractApplyPatchPaths", () => {
	it("returns empty for empty input", () => {
		expect(extractApplyPatchPaths("")).toEqual([]);
	});

	it("returns empty for completely non-patch input", () => {
		expect(extractApplyPatchPaths("not a patch at all\njust prose")).toEqual([]);
	});

	it("extracts Add/Update/Delete paths in order", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: src/new.ts",
			"+export const x = 1;",
			"*** Update File: src/existing.ts",
			"@@ -1 +1 @@",
			"-export const y = 1;",
			"+export const y = 2;",
			"*** Delete File: src/old.ts",
			"*** End Patch",
		].join("\n");
		expect(extractApplyPatchPaths(patch)).toEqual(["src/new.ts", "src/existing.ts", "src/old.ts"]);
	});

	it("preserves first-seen order and deduplicates repeats", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: z.ts",
			"*** Update File: a.ts",
			"*** Add File: z.ts",
			"*** End Patch",
		].join("\n");
		expect(extractApplyPatchPaths(patch)).toEqual(["z.ts", "a.ts"]);
	});

	it("handles CRLF line endings", () => {
		const patch = "*** Begin Patch\r\n*** Add File: win.ts\r\n+x\r\n*** End Patch\r\n";
		expect(extractApplyPatchPaths(patch)).toEqual(["win.ts"]);
	});

	it("ignores non-matching marker-like lines", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: real.ts",
			"+content",
			"*** NOT A VALID MARKER: fake.ts",
			"*** End Patch",
		].join("\n");
		expect(extractApplyPatchPaths(patch)).toEqual(["real.ts"]);
	});

	it("does not match marker lines with leading whitespace", () => {
		// The patch format is strict: markers MUST start at column 0. A leading
		// space means the line is part of diff context, not a real marker.
		const patch = [
			"*** Begin Patch",
			" *** Add File: indented.ts",
			"*** Add File: real.ts",
			"*** End Patch",
		].join("\n");
		expect(extractApplyPatchPaths(patch)).toEqual(["real.ts"]);
	});

	it("returns empty when the patch has begin/end markers but no file entries", () => {
		expect(extractApplyPatchPaths("*** Begin Patch\n*** End Patch")).toEqual([]);
	});
});
