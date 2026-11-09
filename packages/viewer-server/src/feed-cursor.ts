import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export type FeedCursorPosition = {
	created_at: string;
	id: number;
};

export type FeedCursorPayload = FeedCursorPosition & {
	v: 1;
	filter: string;
};

export type FeedCursorFilterOptions = {
	classification: "observation" | "summary";
	project?: string;
	scope?: "mine" | "theirs";
	q?: string;
	actorId: string;
	dbPath: string;
};

export const MAX_FEED_CURSOR_LENGTH = 4096;

export function feedCursorFilterKey(options: FeedCursorFilterOptions): string {
	// Bind the selector and viewer, never a snapshot of current read permissions.
	return createHash("sha256")
		.update(
			JSON.stringify([
				options.classification,
				options.project ?? null,
				options.scope ?? null,
				options.q ?? null,
				options.actorId,
				options.dbPath,
			]),
		)
		.digest("hex");
}

function isFeedCursorPayload(value: unknown): value is FeedCursorPayload {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return (
		Object.keys(payload).length === 4 &&
		payload.v === 1 &&
		typeof payload.created_at === "string" &&
		payload.created_at.length <= 256 &&
		typeof payload.id === "number" &&
		Number.isSafeInteger(payload.id) &&
		payload.id > 0 &&
		typeof payload.filter === "string" &&
		/^[a-f0-9]{64}$/.test(payload.filter)
	);
}

export function tryEncodeFeedCursor(options: {
	position: FeedCursorPosition;
	filter: string;
}): string | null {
	const payload: FeedCursorPayload = {
		v: 1,
		created_at: options.position.created_at,
		id: options.position.id,
		filter: options.filter,
	};
	if (!isFeedCursorPayload(payload)) return null;
	const token = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	if (token.length > MAX_FEED_CURSOR_LENGTH) return null;
	return token;
}

export function encodeFeedCursor(options: {
	position: FeedCursorPosition;
	filter: string;
}): string {
	const token = tryEncodeFeedCursor(options);
	if (token === null) throw new Error("invalid feed cursor position");
	return token;
}

export function decodeFeedCursor(options: {
	cursor: string;
	filter: string;
}): FeedCursorPosition | null {
	const { cursor, filter } = options;
	if (!cursor || cursor.length > MAX_FEED_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
		return null;
	}
	const bytes = Buffer.from(cursor, "base64url");
	if (bytes.toString("base64url") !== cursor) return null;
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isFeedCursorPayload(payload) || payload.filter !== filter) return null;
	if (tryEncodeFeedCursor({ position: payload, filter }) !== cursor) return null;
	return { created_at: payload.created_at, id: payload.id };
}
