/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";

describe("Owner review dialog layout", () => {
	it("wraps long fingerprints, IDs, and URLs inside the dialog", () => {
		const rule = html.match(/\.account-owner-recovery-body\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(rule).toContain("overflow-wrap: anywhere");
		expect(rule).toContain("min-width: 0");
	});
});
