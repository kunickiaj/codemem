import { categorizeSyncFailure, type SyncFailureCategory } from "./sync-pass.js";

export type RecordedSyncFailureCategory = SyncFailureCategory | "compatibility";

// Aggregated per-Space and inbound-apply errors embed arbitrary Space IDs and
// nested error text whose delimiters are ambiguous, and the runtime category
// for them is not persisted. Report them as `other` rather than guess.
const AGGREGATE_PREFIXES = ["scoped sync incomplete:", "inbound apply incomplete"];
const HTTP_STATUS_PATTERN = /failed \((\d{3})\b/;
const UNREACHABLE_HTTP_STATUSES = new Set(["502", "503", "504"]);

// Peer addresses can contain any word (for example `http://authbox.local`).
// Drop whitespace-separated tokens that contain a URL scheme separator; a
// linear token scan avoids backtracking on untrusted input.
function withoutPeerAddresses(text: string): string {
	return text
		.split(/\s+/)
		.filter((token) => !token.includes("://"))
		.join(" ");
}

/**
 * Classify an error string persisted in `sync_attempts`, using the same
 * categories the sync pass assigns at runtime. Returns `other` whenever the
 * stored text cannot be classified unambiguously.
 */
export function classifyRecordedSyncFailure(
	error: string | null | undefined,
): RecordedSyncFailureCategory {
	const text = String(error ?? "").trim();
	if (!text) return "other";
	const lower = text.toLowerCase();
	if (AGGREGATE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "other";
	const withoutAddresses = withoutPeerAddresses(text);
	if (withoutAddresses.toLowerCase().includes("protocol mismatch")) return "compatibility";
	const category = categorizeSyncFailure(withoutAddresses);
	// `peer status failed (404)` and similar mean the peer answered, so only
	// gateway/unavailable statuses count as a reachability problem.
	const httpStatus = HTTP_STATUS_PATTERN.exec(withoutAddresses)?.[1];
	if (category === "connectivity" && httpStatus && !UNREACHABLE_HTTP_STATUSES.has(httpStatus)) {
		return "other";
	}
	return category;
}
