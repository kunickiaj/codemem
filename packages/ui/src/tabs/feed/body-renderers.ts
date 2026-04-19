/* Feed body renderers — summary sections, facts lists, narrative blocks. */

import { h } from "preact";
import { toTitleLabel } from "../../lib/format";
import { renderMarkdownSafe } from "./sanitize";
import type { FeedSummary } from "./types";

export function renderSummarySections(summary: FeedSummary) {
	const preferred = [
		"request",
		"outcome",
		"plan",
		"completed",
		"learned",
		"investigated",
		"next",
		"next_steps",
		"notes",
	];
	const keys = Object.keys(summary);
	const ordered = preferred.filter((k) => keys.includes(k));
	return ordered
		.map((key) => {
			const content = String(summary[key] || "").trim();
			if (!content) return null;
			return h(
				"div",
				{ className: "summary-section", key },
				h("div", { className: "summary-section-label" }, toTitleLabel(key)),
				h("div", {
					className: "summary-section-content",
					dangerouslySetInnerHTML: { __html: renderMarkdownSafe(content) },
				}),
			);
		})
		.filter(Boolean);
}

export function renderFactsContent(facts: unknown[]) {
	const trimmed = facts.map((f) => String(f || "").trim()).filter(Boolean);
	if (!trimmed.length) return null;
	const labeledFacts = trimmed.every((f) => /.+?:\s+.+/.test(f));
	if (labeledFacts) {
		const rows = trimmed
			.map((fact, index) => {
				const splitAt = fact.indexOf(":");
				const labelText = fact.slice(0, splitAt).trim();
				const contentText = fact.slice(splitAt + 1).trim();
				if (!labelText || !contentText) return null;
				return h(
					"div",
					{ className: "summary-section", key: `${labelText}-${index}` },
					h("div", { className: "summary-section-label" }, labelText),
					h("div", {
						className: "summary-section-content",
						dangerouslySetInnerHTML: { __html: renderMarkdownSafe(contentText) },
					}),
				);
			})
			.filter(Boolean);
		if (rows.length) return h("div", { className: "feed-body facts" }, rows);
	}
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
