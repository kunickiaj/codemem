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

/** A peer's sync_entry_too_large reply, after every field was checked. */
export interface SyncEntryTooLargeRefusal {
	readonly kind: SyncEntryKind;
	/** Only plain identifier characters, or "unknown". */
	readonly key: string;
	readonly bytes: number;
	readonly limit: number;
}

const byteCount = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The checked refusal in a peer's reply, or null for any other reply. */
export function parseSyncEntryTooLarge(
	payload: Record<string, unknown> | null,
): SyncEntryTooLargeRefusal | null {
	if (payload?.error !== SYNC_ENTRY_TOO_LARGE) return null;
	if (payload.kind !== "op" && payload.kind !== "snapshot_item") return null;
	const bytes = byteCount(payload.bytes);
	const limit = byteCount(payload.limit);
	if (bytes === null || limit === null) return null;
	return { kind: payload.kind, key: printableKey(payload.key), bytes, limit };
}

/**
 * Recovery guidance, composed here from a checked refusal. Peer text never
 * reaches it, so callers keep it as structured data and build the message
 * from that, never by searching an error string.
 */
export function syncEntryTooLargeMessage(refusal: SyncEntryTooLargeRefusal): string {
	const size = `is ${mebibytes(refusal.bytes)} MiB, over the ${mebibytes(refusal.limit)} MiB this connection carries.`;
	// The op log keeps the oversized change, so editing the memory adds a new change behind it.
	if (refusal.kind === "op")
		return `${SYNC_ENTRY_TOO_LARGE}: change ${refusal.key} ${size} Exclude its Project from this pairing, then sync again. Trimming or deleting the memory won't clear it, because the peer still has the oversized change.`;
	return `${SYNC_ENTRY_TOO_LARGE}: memory ${refusal.key} ${size} Trim or delete it on the peer, or exclude its project, then sync again.`;
}

/** A snapshot page refused as too large. It carries the checked refusal for the caller. */
export class SyncEntryTooLargeReply extends Error {
	constructor(
		readonly refusal: SyncEntryTooLargeRefusal,
		context: string,
	) {
		super(`${context}: ${syncEntryTooLargeMessage(refusal)}`);
		this.name = "SyncEntryTooLargeReply";
	}
}

/** The checked refusal an error carries, if it is a snapshot page refused as too large. */
export function entryTooLargeOf(error: unknown): SyncEntryTooLargeRefusal | undefined {
	return error instanceof SyncEntryTooLargeReply ? error.refusal : undefined;
}
