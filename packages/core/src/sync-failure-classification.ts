import { categorizeSyncFailure, type SyncFailureCategory } from "./sync-pass.js";

export type RecordedSyncFailureCategory = SyncFailureCategory | "compatibility";

// Aggregated per-Space and inbound-apply errors embed arbitrary Space IDs and
// nested error text whose delimiters are ambiguous, and the runtime category
// for them is not persisted. Report them as `other` rather than guess.
const AGGREGATE_PREFIXES = ["scoped sync incomplete:", "inbound apply incomplete"];

// The sync pass writes these phrases only after the peer returned an HTTP
// response (status/error formats vary); transport failures are recorded as raw
// fetch errors instead. A response is a reachability problem only when a
// gateway or unavailable status says so.
const ANSWERED_RESPONSE_PHRASES = [
	"peer status failed",
	"peer ops fetch failed",
	"peer ops push failed",
	"snapshot fetch failed",
];
// JSON error bodies can drop the status (for example `snapshot fetch failed:
// sync_auth_store_busy` from a 503), so also match stable busy codes.
const UNREACHABLE_STATUS_PATTERN = /\b50[234]\b|sync_auth_store_busy/;

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
	if (AGGREGATE_PREFIXES.some((prefix) => text.toLowerCase().startsWith(prefix))) return "other";
	const withoutAddresses = withoutPeerAddresses(text);
	const lower = withoutAddresses.toLowerCase();
	if (lower.includes("protocol mismatch")) return "compatibility";
	const category = categorizeSyncFailure(withoutAddresses);
	const peerAnswered = ANSWERED_RESPONSE_PHRASES.some((phrase) => lower.includes(phrase));
	if (category === "connectivity" && peerAnswered && !UNREACHABLE_STATUS_PATTERN.test(lower)) {
		return "other";
	}
	return category;
}

const ADDRESS_SUMMARY_PREFIX = "all addresses failed |";

type ConnectivityEvidence = "genuine" | "false-positive" | "none";

function connectivityEvidence(segment: string): ConnectivityEvidence {
	const withoutAddresses = withoutPeerAddresses(segment);
	const lower = withoutAddresses.toLowerCase();
	const peerAnswered = ANSWERED_RESPONSE_PHRASES.some((phrase) => lower.includes(phrase));
	if (peerAnswered && !UNREACHABLE_STATUS_PATTERN.test(lower)) return "false-positive";
	if (categorizeSyncFailure(withoutAddresses) === "connectivity") return "genuine";
	if (categorizeSyncFailure(segment) === "connectivity") return "false-positive";
	return "none";
}

// Multi-address failures are recorded as `all addresses failed | a: err || b: err`.
function addressErrorSegments(text: string): string[] {
	if (!text.toLowerCase().startsWith(ADDRESS_SUMMARY_PREFIX)) return [text];
	return text.slice(ADDRESS_SUMMARY_PREFIX.length).split(" || ");
}

/**
 * Stored `connectivity` comes from broad text matching when the attempt was
 * recorded. Keep it unless the error text shows only known false positives:
 * a peer that answered with a non-gateway error, or a connectivity word that
 * appears only in a peer URL. Any genuine connectivity failure among several
 * addresses keeps the category.
 */
export function refineStoredSyncConnectivity(
	error: string | null | undefined,
): RecordedSyncFailureCategory {
	const text = String(error ?? "").trim();
	if (!text) return "connectivity";
	const evidence = addressErrorSegments(text).map(connectivityEvidence);
	if (evidence.includes("genuine")) return "connectivity";
	return evidence.includes("false-positive") ? "other" : "connectivity";
}
