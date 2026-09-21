/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";

describe("compact feed card layout contract", () => {
	const css = html.replace(/\s+/g, " ");

	it("wraps full titles instead of clipping them at any viewport width", () => {
		const title = css.match(/\.feed-title \{([^}]+)\}/)?.[1] || "";
		expect(title).toContain("white-space: normal");
		expect(title).toContain("overflow-wrap: anywhere");
		expect(title).not.toContain("ellipsis");
		expect(title).not.toContain("overflow: hidden");
		expect(css).not.toContain("button.feed-title");
	});

	it("keeps compact pill controls in the fixed top action column", () => {
		expect(css).toContain(".feed-card-side { display: flex; align-items: flex-start;");
		expect(css).toContain(".feed-disclosure { display: inline-flex;");
		expect(css).toContain("width: 30px; height: 30px; min-height: 30px; padding: 0;");
		expect(css).toContain(
			".feed-menu-trigger { width: 30px; height: 30px; border: 1px solid var(--border); border-radius: var(--radius-pill);",
		);
		expect(css).toContain(
			'.feed-disclosure[aria-expanded="false"] .feed-disclosure-icon { transform: rotate(-90deg);',
		);
	});

	it("sizes the kind rail to its content in the token-based compact grid", () => {
		expect(css).toContain("grid-template-columns: max-content minmax(0, 1fr) auto");
		expect(css).toContain("padding: var(--sp-4) var(--sp-5)");
		expect(css).toContain("border-radius: var(--radius-lg)");
		expect(css).toContain("background: var(--surface-1)");
	});

	it("preserves shared card spacing while removing it only from compact feed items", () => {
		expect(css).toContain(".feed-card-body { padding: var(--sp-4) var(--sp-5)");
		expect(css).toContain(".feed-item > .feed-card-body { padding: 0; min-width: 0;");
		expect(css).toContain(
			".feed-card-header { display: flex; align-items: flex-start; justify-content: space-between;",
		);
		expect(css).toContain(
			".feed-search-match > span:last-child { min-width: 0; overflow-wrap: anywhere;",
		);
	});

	it("stacks at 755px without forcing fixed-width controls", () => {
		const narrow = css.slice(css.indexOf("@media (max-width: 755px)"));
		expect(narrow).toContain("grid-template-columns: minmax(0, 1fr) auto");
		expect(narrow).toContain(".feed-card-side-top { grid-column: 2; grid-row: 1; }");
		expect(narrow).toContain(".feed-meta-line { max-width: 100%; }");
	});

	it("styles semantic summary sections without promoting body contrast", () => {
		expect(css).toContain(
			".feed-body.narrative { max-width: 76ch; line-height: 1.65; color: var(--text-secondary); }",
		);
		expect(css).toContain(
			".feed-body .feed-section-heading { --feed-section-color: var(--accent);",
		);
		expect(css).toContain("border-left: 3px solid var(--feed-section-color)");
		expect(css).toContain(
			".feed-body .feed-section-next-steps { --feed-section-color: var(--accent-ochre);",
		);
	});

	it("gives long kind labels and top actions separate rows on small screens", () => {
		const small = css.slice(css.indexOf("@media (max-width: 520px)"));
		expect(small).toContain(".feed-item { grid-template-columns: minmax(0, 1fr); }");
		expect(small).toContain(
			".feed-card-side-top { grid-column: 1; grid-row: 2; justify-self: end; }",
		);
		expect(small).toContain(".feed-item > .feed-card-body { grid-column: 1; grid-row: 3; }");
	});

	it("removes feed motion for reduced-motion users", () => {
		const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).toContain(".feed-detail");
		expect(reduced).toContain(".feed-item.new-item");
		expect(reduced).toContain("animation: none");
	});

	it("prints visible content without menus or editable card controls", () => {
		const print = css.slice(css.indexOf("@media print"));
		expect(print).toContain(".feed-menu-trigger, .feed-disclosure { display: none !important; }");
		expect(print).toContain("break-inside: avoid");
	});
});
