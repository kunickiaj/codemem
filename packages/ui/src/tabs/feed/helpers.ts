/* Pure helper functions for the Feed tab — no rendering, no state mutation.
 *
 * Extracted verbatim from packages/ui/src/tabs/feed.ts as part of the
 * feed/ split (tracked under codemem-ug38). Each function below is
 * exported so feed.ts can import it; nothing else changed.
 */

import { normalize } from "../../lib/format";
import { state } from "../../lib/state";
import type { FeedItem, FeedItemMetadata } from "./types";

export function mergeMetadata(metadata: unknown): FeedItemMetadata {
	if (!metadata || typeof metadata !== "object") return {};
	const meta = metadata as FeedItemMetadata;
	const importMeta = meta.import_metadata;
	if (importMeta && typeof importMeta === "object") {
		return { ...importMeta, ...meta };
	}
	return meta;
}

export function extractFactsFromBody(text: unknown): string[] {
	if (!text) return [];
	const lines = String(text)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const bullets = lines.filter((l) => /^[-*\u2022]\s+/.test(l) || /^\d+\./.test(l));
	if (!bullets.length) return [];
	return bullets.map((l) => l.replace(/^[-*\u2022]\s+/, "").replace(/^\d+\.\s+/, ""));
}

export function sentenceFacts(text: string, limit = 6): string[] {
	const raw = String(text || "").trim();
	if (!raw) return [];
	const collapsed = raw.replace(/\s+/g, " ").trim();
	const parts = collapsed
		.split(/(?<=[.!?])\s+/)
		.map((p) => p.trim())
		.filter(Boolean);
	const facts: string[] = [];
	for (const part of parts) {
		if (part.length < 18) continue;
		facts.push(part);
		if (facts.length >= limit) break;
	}
	return facts;
}

export function isLowSignalObservation(item: FeedItem): boolean {
	const title = normalize(item.title);
	const body = normalize(item.body_text);
	if (!title && !body) return true;
	const combined = body || title;
	if (combined.length < 10) return true;
	if (title && body && title === body && combined.length < 40) return true;
	const lead = title.charAt(0);
	if ((lead === "\u2514" || lead === "\u203a") && combined.length < 40) return true;
	if (title.startsWith("list ") && combined.length < 20) return true;
	if (combined === "ls" || combined === "list ls") return true;
	return false;
}

export function itemSignature(item: FeedItem): string {
	return String(
		item.id ??
			item.memory_id ??
			item.observation_id ??
			item.session_id ??
			item.created_at_utc ??
			item.created_at ??
			"",
	);
}

export function itemKey(item: FeedItem): string {
	return `${String(item.kind || "").toLowerCase()}:${itemSignature(item)}`;
}

export function feedScopeLabel(scope: string): string {
	if (scope === "mine") return " · my memories";
	if (scope === "theirs") return " · other people";
	return "";
}

export function trustStateLabel(trustState: string): string {
	if (trustState === "legacy_unknown") return "legacy provenance";
	if (trustState === "unreviewed") return "unreviewed";
	return trustState.replace(/_/g, " ");
}

export function authorLabel(item: FeedItem): string {
	if (item?.owned_by_self === true) return "You";
	const actorId = String(item.actor_id || "").trim();
	const actorName = String(item.actor_display_name || "").trim();
	if (actorId && actorId === state.lastStatsPayload?.identity?.actor_id) return "You";
	return actorName || actorId || "Unknown author";
}

export function mergeFeedItems(currentItems: FeedItem[], incomingItems: FeedItem[]): FeedItem[] {
	const byKey = new Map<string, FeedItem>();
	currentItems.forEach((item) => {
		byKey.set(itemKey(item), item);
	});
	incomingItems.forEach((item) => {
		byKey.set(itemKey(item), item);
	});
	return Array.from(byKey.values()).sort((a, b) => {
		return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
	});
}

export function mergeRefreshFeedItems(
	currentItems: FeedItem[],
	firstPageItems: FeedItem[],
): FeedItem[] {
	const firstPageKeys = new Set(firstPageItems.map(itemKey));
	const olderItems = currentItems.filter((item) => !firstPageKeys.has(itemKey(item)));
	return mergeFeedItems(olderItems, firstPageItems);
}
