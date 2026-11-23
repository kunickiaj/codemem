import { describe, expect, it } from "vitest";
import { exposureOf, toolCallFor } from "./scripted-host.mjs";

const codeModeTools = [{ function: { name: "execute" } }, { function: { name: "read" } }];
const system = (content) => [{ role: "system", content }];
const remember = { tool: "memory_remember", args: { title: "t" } };

// Catalog excerpts in the shape each OpenCode version sends.
const CATALOG_ONE_SHOWN = `## Code Mode tools (call only inside \`execute\`)

- codemem (15 tools, 1 shown)
  - tools.codemem.memory_distill_candidates({
  limit?: number,
}): Promise<unknown>
- opencode (8 tools, 6 shown)`;
const CATALOG_NONE_SHOWN = `The catalog is partial. Before calling a tool that is not listed below, find it with the global \`search(...)\` function.

- codemem (15 tools, none shown)
- opencode (9 tools, 6 shown)`;

describe("exposureOf", () => {
	it("finds direct memory tools", () => {
		// Act
		const exposure = exposureOf([{ function: { name: "codemem_memory_remember" } }], []);

		// Assert
		expect(exposure.mode).toBe("direct");
	});

	it("counts a codemem namespace with no tools shown as Code Mode", () => {
		// Act
		const exposure = exposureOf(codeModeTools, system(CATALOG_NONE_SHOWN));

		// Assert
		expect(exposure).toMatchObject({ mode: "codemode", shown: [] });
	});

	it("records the tools a partial catalog shows", () => {
		// Act
		const exposure = exposureOf(codeModeTools, system(CATALOG_ONE_SHOWN));

		// Assert
		expect(exposure).toMatchObject({ mode: "codemode", shown: ["memory_distill_candidates"] });
	});

	it("reports absent when the catalog has no codemem namespace", () => {
		// Act
		const exposure = exposureOf(codeModeTools, system("- opencode (9 tools, 6 shown)"));

		// Assert
		expect(exposure.mode).toBe("absent");
	});

	it("reports absent without the execute tool", () => {
		// Act
		const exposure = exposureOf([{ function: { name: "read" } }], system(CATALOG_ONE_SHOWN));

		// Assert
		expect(exposure.mode).toBe("absent");
	});
});

describe("toolCallFor in Code Mode", () => {
	it("calls a shown tool directly", () => {
		// Arrange
		const exposure = exposureOf(codeModeTools, system(CATALOG_ONE_SHOWN));

		// Act
		const call = toolCallFor({ tool: "memory_distill_candidates", args: {} }, exposure);

		// Assert
		expect(JSON.parse(call.arguments).code).toBe("return await tools.codemem.memory_distill_candidates({});");
	});

	it("looks up an unshown tool with search before calling it", () => {
		// Arrange
		const exposure = exposureOf(codeModeTools, system(CATALOG_NONE_SHOWN));

		// Act
		const { code } = JSON.parse(toolCallFor(remember, exposure).arguments);

		// Assert
		expect(code).toContain('await search({ query: "memory_remember", namespace: "codemem" })');
		expect(code).toContain('item.path === "tools.codemem.memory_remember"');
		expect(code.endsWith('return await tools.codemem.memory_remember({"title":"t"});')).toBe(true);
	});
});
