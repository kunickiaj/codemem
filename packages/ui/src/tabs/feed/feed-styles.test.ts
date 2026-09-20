/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import html from "../../../static/index.html?raw";

describe("Feed metadata wrapping cascade", () => {
	it("keeps narrow-card metadata wrapping stronger than the shared chip rule", () => {
		const wrapping = html.match(
			/\.feed-item \.feed-meta-line > \*, \.feed-item \.feed-expanded-provenance > \*\s*\{([^}]+)\}/,
		);
		expect(wrapping?.[1]).toContain("white-space: normal");
		expect(wrapping?.[1]).toContain("overflow-wrap: anywhere");
		expect(wrapping?.[1]).toContain("min-width: 0");
		expect(wrapping?.[1]).toContain("max-width: 100%");
		// Two class selectors beat the shared chip's one, even if its order changes.
		const nowrapRules = [...html.matchAll(/([^{}]+)\{[^{}]*white-space:\s*nowrap[^{}]*\}/g)];
		for (const rule of nowrapRules) {
			expect(rule[1]).not.toMatch(/feed-meta-line|feed-expanded-provenance/);
		}
		expect(html).toContain(".feed-meta-line { max-width: 100%; }");
	});
});
