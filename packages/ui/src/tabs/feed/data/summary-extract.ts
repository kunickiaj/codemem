/* Feed summary extraction — parse a FeedItem's metadata/body/adapter-output
 * into a normalized FeedSummary object and classify it as summary-like. */

import { toTitleLabel } from "../../../lib/format";
import type { FeedItem, FeedItemMetadata, FeedSummary } from "../types";
import { extractFactsFromBody } from "./helpers";

/**
 * A feed summary object parsed from a memory item's metadata, body text,
 * or adapter output. Keys are semantic sections (request / completed /
 * learned / etc.) but the server has enough shape variance that values
 * are typed as `unknown` — callers are expected to coerce via
 * `String(v || "")` or a `typeof` narrowing before rendering.
 */
export function getSummaryObject(item: FeedItem): FeedSummary | null {
	const preferredKeys = [
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
	const looksLikeSummary = (v: unknown): v is FeedSummary => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return false;
		const obj = v as FeedSummary;
		return preferredKeys.some((k) => {
			const value = obj[k];
			return typeof value === "string" && value.trim().length > 0;
		});
	};
	const rawSummary = item?.summary;
	if (rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)) {
		const nestedSummary = (rawSummary as { summary?: unknown }).summary;
		if (looksLikeSummary(rawSummary)) return rawSummary;
		if (looksLikeSummary(nestedSummary)) return nestedSummary;
	}
	const metadata = item?.metadata_json;
	if (looksLikeSummary(metadata)) return metadata;
	if (metadata && looksLikeSummary(metadata.summary)) return metadata.summary;
	const bodyText = String(item?.body_text || "").trim();
	if (bodyText.includes("## ")) {
		const headingMap: Record<string, string> = {
			request: "request",
			completed: "completed",
			learned: "learned",
			investigated: "investigated",
			"next steps": "next_steps",
			notes: "notes",
		};
		const parsed: Record<string, string> = {};
		const sectionRe = /(?:^|\n)##\s+([^\n]+)\n([\s\S]*?)(?=\n##\s+|$)/g;
		for (let match = sectionRe.exec(bodyText); match; match = sectionRe.exec(bodyText)) {
			const rawLabel = String(match[1] || "")
				.trim()
				.toLowerCase();
			const key = headingMap[rawLabel];
			const content = String(match[2] || "").trim();
			if (key && content) parsed[key] = content;
		}
		if (looksLikeSummary(parsed)) return parsed;
	}
	return null;
}

export function isSummaryLikeItem(item: FeedItem, metadata: FeedItemMetadata): boolean {
	const kindValue = String(item?.kind || "").toLowerCase();
	if (kindValue === "session_summary") return true;
	if (metadata?.is_summary === true) return true;
	const source = String(metadata?.source || "")
		.trim()
		.toLowerCase();
	return source === "observer_summary";
}

export function canonicalKind(item: FeedItem, metadata: FeedItemMetadata): string {
	const kindValue = String(item?.kind || "")
		.trim()
		.toLowerCase();
	return isSummaryLikeItem(item, metadata) ? "session_summary" : kindValue || "change";
}

export function _getFactsList(item: FeedItem): string[] {
	const summary = getSummaryObject(item);
	if (summary) {
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
		const remaining = keys.filter((k) => !preferred.includes(k)).sort();
		const ordered = [...preferred.filter((k) => keys.includes(k)), ...remaining];
		const facts: string[] = [];
		ordered.forEach((key) => {
			const content = String(summary[key] || "").trim();
			if (!content) return;
			const bullets = extractFactsFromBody(content);
			if (bullets.length) {
				bullets.forEach((b) => {
					facts.push(`${toTitleLabel(key)}: ${b}`.trim());
				});
				return;
			}
			facts.push(`${toTitleLabel(key)}: ${content}`.trim());
		});
		return facts;
	}
	return extractFactsFromBody(String(item?.body_text || ""));
}
