import { PEER_HTTP_LIMITS } from "./peer-http-policy.js";

/**
 * A pull page always carries at least one entry, so a single entry larger than
 * a channel's response ceiling can never be delivered. Channels refuse it by
 * name instead of failing the exchange, and the reader's cursor stays where it
 * was until someone trims, deletes or excludes the entry.
 */
export type SyncEntryKind = "op" | "snapshot_item";

/** Room left in a channel response for the page envelope around one entry. */
const ENVELOPE_RESERVE_BYTES = 64 * 1024;

/** Largest serialized entry a relay or direct Noise channel response can carry. */
export const CHANNEL_MAX_ENTRY_BYTES = PEER_HTTP_LIMITS.responseBytes - ENVELOPE_RESERVE_BYTES;

export const SYNC_ENTRY_TOO_LARGE = "sync_entry_too_large";

export class SyncEntryTooLargeError extends Error {
	constructor(
		readonly kind: SyncEntryKind,
		readonly key: string,
		readonly bytes: number,
		readonly limit: number,
	) {
		super(SYNC_ENTRY_TOO_LARGE);
		this.name = "SyncEntryTooLargeError";
	}

	/** The 409 body a channel returns. The entry is one the peer may read, so naming it leaks nothing. */
	toResponseBody() {
		return {
			error: SYNC_ENTRY_TOO_LARGE,
			kind: this.kind,
			key: this.key,
			bytes: this.bytes,
			limit: this.limit,
		};
	}
}

/** Serialized size of one page entry, as the page JSON carries it. */
export function syncEntryBytes(entry: unknown): number {
	return Buffer.byteLength(JSON.stringify(entry)) + 1;
}

/** Returns the entries unchanged, or throws for the first one over the limit. */
export function entriesWithinLimit<T>(
	kind: SyncEntryKind,
	entries: T[],
	keyOf: (entry: T) => string,
	limit: number | undefined,
): T[] {
	if (limit === undefined) return entries;
	for (const entry of entries) {
		const bytes = syncEntryBytes(entry);
		if (bytes > limit) throw new SyncEntryTooLargeError(kind, keyOf(entry), bytes, limit);
	}
	return entries;
}

function mebibytes(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

/** The peer chooses the key text, so only plain identifier characters reach local errors and logs. */
function printableKey(value: unknown): string {
	return typeof value === "string" && /^[A-Za-z0-9:_.+/=-]{1,200}$/.test(value) ? value : "unknown";
}

/** Recovery guidance for a peer's sync_entry_too_large reply, or null for any other reply. */
export function syncEntryTooLargeMessage(payload: Record<string, unknown> | null): string | null {
	if (payload?.error !== SYNC_ENTRY_TOO_LARGE) return null;
	const key = printableKey(payload.key);
	const bytes = Number(payload.bytes);
	const limit = Number(payload.limit);
	if (!Number.isFinite(bytes) || !Number.isFinite(limit)) return SYNC_ENTRY_TOO_LARGE;
	const entry = payload.kind === "op" ? "change" : "memory";
	return `${SYNC_ENTRY_TOO_LARGE}: ${entry} ${key} is ${mebibytes(bytes)} MiB, over the ${mebibytes(limit)} MiB this connection carries. Trim or delete it on the peer, or exclude its project, then sync again.`;
}

/** The guidance inside a local error string, so wrappers that replace error text can keep it. */
export function syncEntryTooLargeGuidance(error: string | undefined): string | null {
	const start = error?.indexOf(`${SYNC_ENTRY_TOO_LARGE}: `) ?? -1;
	if (!error || start < 0) return null;
	const guidance = error.slice(start);
	return guidance.endsWith(")") ? guidance.slice(0, -1) : guidance;
}
