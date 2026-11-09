import {
	createReadDeadline,
	DEFAULT_READ_DEADLINE_MS,
	isReadTimeout,
	waitForAbort,
} from "../read-request";
import type { FetchJsonOptions } from "./internal";
import type { PaginatedResponse } from "./types";

export class FeedCursorUnavailableError extends Error {
	constructor() {
		super("Feed cursor unavailable.");
		this.name = "FeedCursorUnavailableError";
	}
}

export function validateFeedPagination(payload: PaginatedResponse): PaginatedResponse {
	const page = payload.pagination;
	if (page?.paging !== "cursor") return payload;
	const validCursor =
		typeof page.next_cursor === "string" &&
		page.next_cursor.length > 0 &&
		page.next_cursor.length <= 4096;
	if (
		!Number.isSafeInteger(page.limit) ||
		typeof page.limit !== "number" ||
		page.limit <= 0 ||
		page.offset !== null ||
		page.next_offset !== null ||
		typeof page.has_more !== "boolean" ||
		(page.has_more ? !validCursor : page.next_cursor !== null)
	) {
		throw new Error("Feed unavailable. Refresh and try again.");
	}
	return payload;
}

/** Only the cursor protocol needs an error body, under the same read deadline. */
export async function fetchFeedCursorPage(
	url: string,
	options: FetchJsonOptions = {},
): Promise<PaginatedResponse> {
	const { deadlineMs = DEFAULT_READ_DEADLINE_MS, signal: parentSignal, ...init } = options;
	const deadline = createReadDeadline(deadlineMs, parentSignal);
	try {
		await waitForAbort(Promise.resolve(), deadline.signal);
		const response = await waitForAbort(
			fetch(url, { ...init, signal: deadline.signal }),
			deadline.signal,
		);
		if (!response.ok && response.status !== 409) throw new Error("Feed unavailable.");
		const payload = await waitForAbort(response.json(), deadline.signal);
		if (response.status === 409) {
			if (payload?.error === "cursor_unavailable") throw new FeedCursorUnavailableError();
			throw new Error("Feed unavailable.");
		}
		return validateFeedPagination(payload);
	} catch (error) {
		if (error instanceof FeedCursorUnavailableError) throw error;
		if (deadline.signal.aborted) {
			if (isReadTimeout(deadline.signal.reason)) throw deadline.signal.reason;
			throw new DOMException("Request aborted", "AbortError");
		}
		throw new Error("Feed unavailable. Refresh and try again.");
	} finally {
		deadline.dispose();
	}
}
