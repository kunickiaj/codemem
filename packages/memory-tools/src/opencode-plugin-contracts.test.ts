import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listMemoryToolContracts } from "./contracts.js";

/**
 * The OpenCode plugin ships plain JS without a build step, so it reads the
 * contracts from a committed JSON copy. This test keeps that copy in sync.
 */
const PLUGIN_CONTRACTS_PATH = resolve(
	import.meta.dirname,
	"../../opencode-plugin/.opencode/lib/memory-tool-contracts.json",
);
const REGENERATE_ENV = "CODEMEM_WRITE_PLUGIN_CONTRACTS";
const REGENERATE_HINT = `memory-tool-contracts.json is stale. Regenerate it with: ${REGENERATE_ENV}=1 pnpm exec vitest run packages/memory-tools/src/opencode-plugin-contracts.test.ts`;

function pluginContracts() {
	return listMemoryToolContracts().map(({ name, description, input }) => ({
		name,
		description,
		input,
	}));
}

describe("OpenCode plugin contract copy", () => {
	it("matches the shared memory tool contracts", () => {
		const expected = pluginContracts();
		if (process.env[REGENERATE_ENV] === "1") {
			writeFileSync(PLUGIN_CONTRACTS_PATH, `${JSON.stringify(expected, null, "\t")}\n`);
		}
		const committed: unknown = JSON.parse(readFileSync(PLUGIN_CONTRACTS_PATH, "utf8"));
		expect(committed, REGENERATE_HINT).toEqual(expected);
	});
});
