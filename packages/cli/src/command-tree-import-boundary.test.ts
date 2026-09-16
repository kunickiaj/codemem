import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compatibilityCommands = ["commands/export-memories.ts", "commands/import-memories.ts"];

describe("command-tree import boundary", () => {
	it("keeps compatibility commands independent of command assembly", () => {
		for (const path of compatibilityCommands) {
			const source = readFileSync(new URL(path, import.meta.url), "utf8");
			expect(source).not.toMatch(/from ["']\.\.\/command-tree\.js["']/);
		}
	});
});
