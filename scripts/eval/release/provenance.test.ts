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

	it("orders non-ASCII paths by deterministic code point", () => {
		const contents = { "😀.ts": "emoji", "é.ts": "accent" };
		const first = digestComponentContents(
			{ schema_version: 1, components: { evaluator: ["😀.ts", "é.ts"] } },
			contents,
		);
		const reordered = digestComponentContents(
			{ schema_version: 1, components: { evaluator: ["é.ts", "😀.ts"] } },
			contents,
		);
		expect(reordered).toBe(first);
	});

	it("binds retrieval provenance only to retrieval-scoped inputs", () => {
		const manifest = {
			schema_version: 1 as const,
			components: {
				evaluator: ["observer.ts"],
				retrieval: ["pack.ts", "retrieval-scoring.ts"],
			},
		};
		const contents = {
			"observer.ts": "observer",
			"pack.ts": "pack",
			"retrieval-scoring.ts": "score",
		};
		const retrieval = digestComponentContents(manifest, contents, "retrieval");
		expect(
			digestComponentContents(
				manifest,
				{ ...contents, "observer.ts": "changed observer" },
				"retrieval",
			),
		).toBe(retrieval);
		expect(
			digestComponentContents(manifest, { ...contents, "pack.ts": "changed pack" }, "retrieval"),
		).not.toBe(retrieval);
	});
});
