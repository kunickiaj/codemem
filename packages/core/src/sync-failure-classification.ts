import { categorizeSyncFailure, type SyncFailureCategory } from "./sync-pass.js";

export type RecordedSyncFailureCategory = SyncFailureCategory | "compatibility";

const SCOPED_PREFIX = "scoped sync incomplete:";
const INBOUND_PREFIX = "inbound apply incomplete";
// Peer addresses can contain any word (for example `http://authbox.local`).
const PEER_ADDRESS_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+?(?=:\s|\s|\||$)/gi;

function classifySingleFailure(error: string): RecordedSyncFailureCategory {
	const text = error.replace(PEER_ADDRESS_PATTERN, " ");
	if (text.toLowerCase().includes("protocol mismatch")) return "compatibility";
	return categorizeSyncFailure(text);
}

function classifyScopedFailures(detail: string): RecordedSyncFailureCategory {
	// Each entry is `<scope id>=<error>`; scope IDs are arbitrary text, so drop them.
	const categories = new Set(
		detail
			.split(/;\s*/)
			.filter(Boolean)
			.map((entry) => classifySingleFailure(entry.slice(entry.indexOf("=") + 1))),
	);
	return categories.size === 1 ? ([...categories][0] ?? "other") : "other";
}

/**
 * Classify an error string persisted in `sync_attempts`, matching the
 * categories the sync pass assigns at runtime. Mixed per-Space failures and
 * incomplete inbound apply are `other`, as in `aggregateScopeFailureCategory`.
 */
export function classifyRecordedSyncFailure(
	error: string | null | undefined,
): RecordedSyncFailureCategory {
	const text = String(error ?? "").trim();
	if (!text) return "other";
	if (text.startsWith(INBOUND_PREFIX)) return "other";
	if (text.startsWith(SCOPED_PREFIX))
		return classifyScopedFailures(text.slice(SCOPED_PREFIX.length));
	return classifySingleFailure(text);
}
