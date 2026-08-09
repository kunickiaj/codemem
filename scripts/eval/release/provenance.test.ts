import { describe, expect, it } from "vitest";
import { digestComponentContents } from "./provenance.js";

describe("evaluator component provenance", () => {
	it("is deterministic and changes with behavior content", () => {
		const manifest = { schema_version: 1 as const, components: { evaluator: ["b.ts", "a.ts"] } };
		const first = digestComponentContents(manifest, { "a.ts": "a", "b.ts": "b" });
		const reordered = digestComponentContents(
			{ ...manifest, components: { evaluator: ["a.ts", "b.ts"] } },
			{ "a.ts": "a", "b.ts": "b" },
		);
		expect(reordered).toBe(first);
		expect(digestComponentContents(manifest, { "a.ts": "changed", "b.ts": "b" })).not.toBe(first);
	});

	it("fails closed when content is missing", () => {
		expect(() =>
			digestComponentContents({ schema_version: 1, components: { evaluator: ["missing.ts"] } }, {}),
		).toThrow("Missing content");
	});
});
