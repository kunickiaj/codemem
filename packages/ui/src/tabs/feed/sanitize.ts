/* Feed sanitize — HTML/Markdown sanitizer + safe-href check. */

export function isSafeHref(value: string): boolean {
	const href = String(value || "").trim();
	if (!href) return false;
	if (href.startsWith("#") || href.startsWith("/")) return true;
	const lower = href.toLowerCase();
	return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:");
}

export function sanitizeHtml(html: string): string {
	const template = document.createElement("template");
	template.innerHTML = String(html || "");
	const allowedTags = new Set([
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
	]);

	template.content
		.querySelectorAll("script, iframe, object, embed, link, style")
		.forEach((node) => {
			node.remove();
		});

	template.content.querySelectorAll("*").forEach((node) => {
		const tag = node.tagName.toLowerCase();
		if (!allowedTags.has(tag)) {
			node.replaceWith(document.createTextNode(node.textContent || ""));
			return;
		}

		const allowedAttrs = tag === "a" ? new Set(["href", "title"]) : new Set<string>();
		for (const attr of Array.from(node.attributes)) {
			const name = attr.name.toLowerCase();
			if (!allowedAttrs.has(name)) {
				node.removeAttribute(attr.name);
			}
		}

		if (tag === "a") {
			const href = node.getAttribute("href") || "";
			if (!isSafeHref(href)) {
				node.removeAttribute("href");
			} else {
				node.setAttribute("rel", "noopener noreferrer");
				node.setAttribute("target", "_blank");
			}
		}
	});

	return template.innerHTML;
}

export function renderMarkdownSafe(value: string): string {
	const source = String(value || "");
	try {
		const globalMarked = (globalThis as { marked?: { parse: (src: string) => string } }).marked;
		if (!globalMarked) throw new Error("marked is not available");
		const rawHtml = globalMarked.parse(source);
		return sanitizeHtml(rawHtml);
	} catch {
		const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		return escaped;
	}
}
