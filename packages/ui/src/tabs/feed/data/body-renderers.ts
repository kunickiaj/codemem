/* Feed body renderers — facts lists and narrative blocks. */

import { h } from "preact";
import { renderMarkdownSafe } from "./sanitize";

export function renderFactsContent(facts: unknown[]) {
	const trimmed = facts.map((f) => String(f || "").trim()).filter(Boolean);
	if (!trimmed.length) return null;
	return h(
		"div",
		{ className: "feed-body" },
		h(
			"ul",
			null,
			trimmed.map((fact, index) => h("li", { key: `${fact}-${index}` }, fact)),
		),
	);
}

export function renderNarrativeContent(narrative: string, className = "feed-body") {
	const content = String(narrative || "").trim();
	if (!content) return null;
	return h("div", {
		className,
		dangerouslySetInnerHTML: { __html: renderMarkdownSafe(content) },
	});
}
