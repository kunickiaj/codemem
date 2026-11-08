import { type ReadRequestOptions, waitForAbort } from "../read-request";
import { fetchJson } from "./internal";

interface PendingSyncStatus {
	controller: AbortController;
	promise: Promise<unknown>;
	subscribers: number;
}

const pendingStatuses = new Map<string, PendingSyncStatus>();

function startSyncStatus(url: string): PendingSyncStatus {
	const controller = new AbortController();
	const request: PendingSyncStatus = {
		controller,
		promise: fetchJson(url, { signal: controller.signal }).finally(() => {
			// An abandoned request must not remove a newer request for the same URL.
			if (pendingStatuses.get(url) === request) pendingStatuses.delete(url);
		}),
		subscribers: 0,
	};
	pendingStatuses.set(url, request);
	return request;
}

export async function requestSyncStatus(
	url: string,
	{ signal }: ReadRequestOptions = {},
): Promise<unknown> {
	signal?.throwIfAborted();
	const request = pendingStatuses.get(url) ?? startSyncStatus(url);
	request.subscribers += 1;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		signal?.removeEventListener("abort", release);
		request.subscribers -= 1;
		if (request.subscribers !== 0 || pendingStatuses.get(url) !== request) return;
		// Remove synchronously on the last abort so immediate retries start fresh.
		pendingStatuses.delete(url);
		request.controller.abort();
	};
	signal?.addEventListener("abort", release, { once: true });
	try {
		return await (signal ? waitForAbort(request.promise, signal) : request.promise);
	} finally {
		release();
	}
}
