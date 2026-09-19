/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";

describe("compact feed card layout contract", () => {
	const css = html.replace(/\s+/g, " ");

	it("uses the approved token-based three-column compact grid", () => {
		expect(css).toContain("grid-template-columns: 104px minmax(0, 1fr) auto");
		expect(css).toContain("padding: var(--sp-4) var(--sp-5)");
		expect(css).toContain("border-radius: var(--radius-lg)");
		expect(css).toContain("background: var(--surface-1)");
	});

	it("stacks at 755px without forcing fixed-width controls", () => {
		const narrow = css.slice(css.indexOf("@media (max-width: 755px)"));
		expect(narrow).toContain("grid-template-columns: minmax(0, 1fr) auto");
		expect(narrow).toContain(
			".feed-visibility-select { box-sizing: border-box; width: 100%; min-width: 0; }",
		);
		expect(narrow).toContain(".feed-meta-line { max-width: 100%; }");
	});

	it("removes feed motion for reduced-motion users", () => {
		const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).toContain(".feed-detail");
		expect(reduced).toContain(".feed-item.new-item");
		expect(reduced).toContain("animation: none");
	});

	it("prints visible content without menus or editable card controls", () => {
		const print = css.slice(css.indexOf("@media print"));
		expect(print).toContain(
			".feed-menu-trigger, .feed-card-side-bottom { display: none !important; }",
		);
		expect(print).toContain("break-inside: avoid");
	});
});
