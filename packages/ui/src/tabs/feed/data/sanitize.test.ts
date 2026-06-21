import { describe, expect, it } from "vitest";

import { isSafeHref, renderMarkdownSafe, sanitizeHtml } from "./sanitize";

describe("isSafeHref", () => {
	it("allows fragment, absolute path, http(s), and mailto", () => {
		expect(isSafeHref("#anchor")).toBe(true);
		expect(isSafeHref("/projects")).toBe(true);
		expect(isSafeHref("http://example.com")).toBe(true);
		expect(isSafeHref("https://example.com")).toBe(true);
		expect(isSafeHref("mailto:a@b.com")).toBe(true);
	});

	it("rejects empty, javascript:, and other schemes", () => {
		expect(isSafeHref("")).toBe(false);
		expect(isSafeHref("   ")).toBe(false);
		expect(isSafeHref("javascript:alert(1)")).toBe(false);
		expect(isSafeHref("data:text/html,<script>")).toBe(false);
		expect(isSafeHref("vbscript:msgbox(1)")).toBe(false);
	});
});

describe("renderMarkdownSafe — XSS vectors neutralized", () => {
	it("strips an <img onerror> payload (img not allowed)", () => {
		const out = renderMarkdownSafe("<img src=x onerror=alert(1)>");
		expect(out).not.toContain("<img");
		expect(out).not.toContain("onerror");
		expect(out).not.toContain("alert(1)");
	});

	it("strips a <script> tag", () => {
		const out = renderMarkdownSafe("<script>alert(1)</script>");
		expect(out).not.toContain("<script");
		expect(out.toLowerCase()).not.toContain("alert(1)");
	});

	it("drops a javascript: href but keeps the anchor text", () => {
		const out = renderMarkdownSafe('<a href="javascript:alert(1)">x</a>');
		expect(out).not.toContain("javascript:");
		expect(out).not.toContain("href=");
		expect(out).toContain("x");
	});

	it("strips an <svg onload> payload (svg not allowed)", () => {
		const out = renderMarkdownSafe("<svg onload=alert(1)>");
		expect(out).not.toContain("<svg");
		expect(out).not.toContain("onload");
	});

	it("strips inline event-handler attributes", () => {
		const out = renderMarkdownSafe('<p onclick="alert(1)">hi</p>');
		expect(out).not.toContain("onclick");
		expect(out).not.toContain("alert(1)");
		expect(out).toContain("hi");
	});
});

describe("renderMarkdownSafe — mXSS and obfuscated vectors", () => {
	// Assert no executable form survives. Inert text (e.g. a literal "alert(1)"
	// rendered as visible text) is harmless, so we check the dangerous tags,
	// event-handler attributes, and js scheme rather than the bare payload text.
	const assertInert = (out: string): void => {
		const lower = out.toLowerCase();
		expect(lower).not.toContain("onerror");
		expect(lower).not.toContain("onload");
		expect(lower).not.toContain("<img");
		expect(lower).not.toContain("<script");
		expect(lower).not.toContain("<svg");
		expect(lower).not.toContain("javascript:");
	};

	it("neutralizes a noscript-breakout mXSS payload", () => {
		assertInert(
			renderMarkdownSafe('<noscript><p title="</noscript><img src=x onerror=alert(1)>">'),
		);
	});

	it("neutralizes an svg/style-wrapped mXSS payload", () => {
		assertInert(renderMarkdownSafe("<svg><style><img src=x onerror=alert(1)></style></svg>"));
	});

	it("neutralizes a form/math/mglyph mXSS breakout", () => {
		assertInert(
			renderMarkdownSafe(
				"<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
			),
		);
	});

	it("drops an href with an HTML-entity-encoded javascript scheme", () => {
		const out = renderMarkdownSafe('<a href="&#74;avascript:alert(1)">x</a>');
		expect(out).not.toContain("href=");
		expect(out.toLowerCase()).not.toContain("javascript:");
		expect(out).toContain("x");
	});

	it("drops an href with a tab-obfuscated javascript scheme", () => {
		const out = renderMarkdownSafe('<a href="java\tscript:alert(1)">x</a>');
		expect(out).not.toContain("href=");
		expect(out.toLowerCase()).not.toContain("javascript:");
	});

	it("drops an href with a leading-whitespace javascript scheme", () => {
		const out = renderMarkdownSafe('<a href="  javascript:alert(1)">x</a>');
		expect(out).not.toContain("href=");
		expect(out.toLowerCase()).not.toContain("javascript:");
	});
});

describe("renderMarkdownSafe — safe content survives", () => {
	it("renders bold as <strong>", () => {
		const out = renderMarkdownSafe("**bold**");
		expect(out).toContain("<strong>bold</strong>");
	});

	it("renders a markdown link with href + rel + target", () => {
		const out = renderMarkdownSafe("[x](https://example.com)");
		expect(out).toContain('href="https://example.com"');
		expect(out).toContain('rel="noopener noreferrer"');
		expect(out).toContain('target="_blank"');
		expect(out).toContain(">x</a>");
	});

	it("renders headings", () => {
		const out = renderMarkdownSafe("# Title\n\n## Subtitle");
		expect(out).toContain("<h1>Title</h1>");
		expect(out).toContain("<h2>Subtitle</h2>");
	});

	it("renders unordered lists", () => {
		const out = renderMarkdownSafe("- one\n- two");
		expect(out).toContain("<ul>");
		expect(out).toContain("<li>one</li>");
		expect(out).toContain("<li>two</li>");
	});
});

describe("sanitizeHtml", () => {
	it("applies the same allowlist + anchor policy to raw HTML", () => {
		expect(sanitizeHtml("<script>alert(1)</script>")).not.toContain("<script");
		const link = sanitizeHtml('<a href="https://example.com" title="t">x</a>');
		expect(link).toContain('href="https://example.com"');
		expect(link).toContain('title="t"');
		expect(link).toContain('rel="noopener noreferrer"');
		expect(link).toContain('target="_blank"');
		expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
	});

	it("strips disallowed tags but preserves their text content", () => {
		const out = sanitizeHtml("<div>kept text</div>");
		expect(out).not.toContain("<div");
		expect(out).toContain("kept text");
	});

	it("strips data-* attributes (e.g. data-lucide) so post-render processors can't act on them", () => {
		const out = sanitizeHtml('<p data-lucide="x" data-foo="y">text</p>');
		expect(out).not.toContain("data-lucide");
		expect(out).not.toContain("data-foo");
		expect(out).toContain("text");
		expect(renderMarkdownSafe("<p data-lucide=skull>m</p>")).not.toContain("data-lucide");
	});
});
