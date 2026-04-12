import { describe, expect, it } from "vitest";
import { buildSessionContext } from "./raw-event-flush.js";

describe("buildSessionContext — OpenCode file-mutation tools", () => {
	it("extracts filesModified from apply_patch patchText (Add/Update/Delete)", () => {
		const patchText = [
			"*** Begin Patch",
			"*** Add File: src/new.ts",
			"+export const x = 1;",
			"*** Update File: src/existing.ts",
			"@@ -1,1 +1,1 @@",
			"-export const y = 1;",
			"+export const y = 2;",
			"*** Delete File: src/old.ts",
			"*** End Patch",
		].join("\n");

		const context = buildSessionContext([
			{
				type: "tool.execute.after",
				tool: "apply_patch",
				args: { patchText },
				timestamp_wall_ms: 1_700_000_000_000,
			},
		]);

		expect(context.filesModified).toEqual(["src/existing.ts", "src/new.ts", "src/old.ts"]);
		expect(context.filesRead).toEqual([]);
		expect(context.toolCount).toBe(1);
	});

	it("also accepts `patch` as an alternate patchText key", () => {
		const patchText = "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch";
		const context = buildSessionContext([
			{
				type: "tool.execute.after",
				tool: "apply_patch",
				args: { patch: patchText },
				timestamp_wall_ms: 1,
			},
		]);
		expect(context.filesModified).toEqual(["a.ts"]);
	});

	it("deduplicates paths across multiple apply_patch calls", () => {
		const patchA = "*** Begin Patch\n*** Add File: shared.ts\n+1\n*** End Patch";
		const patchB = "*** Begin Patch\n*** Update File: shared.ts\n+2\n*** End Patch";
		const context = buildSessionContext([
			{ type: "tool.execute.after", tool: "apply_patch", args: { patchText: patchA } },
			{ type: "tool.execute.after", tool: "apply_patch", args: { patchText: patchB } },
		]);
		expect(context.filesModified).toEqual(["shared.ts"]);
	});

	it("treats write/edit tools identically to apply_patch for filesModified", () => {
		const context = buildSessionContext([
			{
				type: "tool.execute.after",
				tool: "write",
				args: { filePath: "/repo/out.ts" },
			},
			{
				type: "tool.execute.after",
				tool: "edit",
				args: { filePath: "/repo/existing.ts" },
			},
			{
				type: "tool.execute.after",
				tool: "apply_patch",
				args: { patchText: "*** Begin Patch\n*** Add File: /repo/patched.ts\n+x\n*** End Patch" },
			},
		]);
		expect(context.filesModified).toEqual([
			"/repo/existing.ts",
			"/repo/out.ts",
			"/repo/patched.ts",
		]);
	});

	it("recognizes Claude Code multiedit and notebookedit tools", () => {
		const context = buildSessionContext([
			{
				type: "tool.execute.after",
				tool: "multiedit",
				args: { file_path: "/repo/m.ts" },
			},
			{
				type: "tool.execute.after",
				tool: "notebookedit",
				args: { file_path: "/repo/n.ipynb" },
			},
		]);
		expect(context.filesModified).toEqual(["/repo/m.ts", "/repo/n.ipynb"]);
	});

	it("ignores apply_patch events whose patchText has no file markers", () => {
		const context = buildSessionContext([
			{
				type: "tool.execute.after",
				tool: "apply_patch",
				args: { patchText: "*** Begin Patch\n*** End Patch" },
			},
		]);
		expect(context.filesModified).toEqual([]);
	});
});
