/* Feed sanitize — Markdown rendering + HTML sanitization.
 *
 * Untrusted (including peer-synced) memory content is rendered with marked
 * and then sanitized with DOMPurify. We never round-trip through a bespoke
 * allowlist + template.innerHTML re-serialize pass, which is the classic
 * mXSS-bypassable pattern; DOMPurify is the sanitizer marked's own docs
 * mandate.
 *
 * BROWSER-ONLY: DOMPurify needs a real `window`/DOM. In a no-DOM context
 * (e.g. SSR) DOMPurify.sanitize is a no-op and would fail open on untrusted
 * input. This module is only ever called client-side (the viewer bundle runs
 * in the browser; tests run under jsdom). Do not call it server-side without
 * providing a DOM (e.g. via a jsdom window) first.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

/* Allowlist preserved verbatim from the previous hand-rolled sanitizer. */
const ALLOWED_TAGS = [
	"p",
	"br",
	"strong",
	"em",
	"code",
	"pre",
	"ul",
	"ol",
	"li",
	"blockquote",
	"a",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
];

/* ALLOWED_ATTR is global (DOMPurify does not scope attributes per tag). That
 * is safe here: `title` is inert text, and `href` is only meaningful on URL
 * elements and is independently scheme-filtered by DOMPurify's IS_ALLOWED_URI
 * (blocking javascript:/data:/etc.). The dangerous href carriers (svg/use)
 * are excluded by ALLOWED_TAGS. The anchor hook below adds the rel/target
 * hardening and our stricter isSafeHref check on top. */
const ALLOWED_ATTR = ["href", "title"];

/* Shared DOMPurify options for both sanitize paths (kept in one place so they
 * can't drift). ALLOW_DATA_ATTR must be false: DOMPurify keeps data-* attributes
 * by default even with ALLOWED_ATTR set, and the feed runs lucide.createIcons()
 * after rendering, which would turn a peer-supplied `data-lucide="..."` into an
 * SVG — mutating sanitized content and bypassing this allowlist. */
const SANITIZE_OPTIONS = { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false };

export function isSafeHref(value: string): boolean {
	const href = String(value || "").trim();
	if (!href) return false;
	if (href.startsWith("#") || href.startsWith("/")) return true;
	const lower = href.toLowerCase();
	return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:");
}

/* Enforce anchor policy: drop unsafe hrefs, and harden safe ones with
 * rel="noopener noreferrer" + target="_blank". Registered once at module
 * load so it applies to every DOMPurify.sanitize call in this module. */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		const href = node.getAttribute("href") || "";
		if (!isSafeHref(href)) {
			node.removeAttribute("href");
		} else {
			node.setAttribute("rel", "noopener noreferrer");
			node.setAttribute("target", "_blank");
		}
	}
});

export function sanitizeHtml(html: string): string {
	return DOMPurify.sanitize(String(html || ""), SANITIZE_OPTIONS);
}

export function renderMarkdownSafe(value: string): string {
	const rawHtml = marked.parse(String(value || ""), { async: false });
	return DOMPurify.sanitize(rawHtml, SANITIZE_OPTIONS);
}
