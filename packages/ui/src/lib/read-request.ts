export const DEFAULT_READ_DEADLINE_MS = 15_000;

export interface ReadRequestOptions {
	signal?: AbortSignal;
}

export class ReadTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Viewer read exceeded its ${timeoutMs}ms deadline`);
		this.name = "ReadTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The request was aborted", "AbortError");
}

export function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

export interface ReadDeadline {
	abort: (reason?: unknown) => void;
	dispose: () => void;
	signal: AbortSignal;
}

export function createReadDeadline(
	timeoutMs = DEFAULT_READ_DEADLINE_MS,
	parentSignal?: AbortSignal | null,
): ReadDeadline {
	const controller = new AbortController();
	const abortFromParent = () => controller.abort(abortReason(parentSignal as AbortSignal));
	if (parentSignal?.aborted) {
		abortFromParent();
	} else {
		parentSignal?.addEventListener("abort", abortFromParent, { once: true });
	}
	const timeoutId = window.setTimeout(
		() => controller.abort(new ReadTimeoutError(timeoutMs)),
		timeoutMs,
	);
	return {
		abort: (reason = new DOMException("The request was aborted", "AbortError")) =>
			controller.abort(reason),
		dispose: () => {
			window.clearTimeout(timeoutId);
			parentSignal?.removeEventListener("abort", abortFromParent);
		},
		signal: controller.signal,
	};
}

export function isReadTimeout(error: unknown): error is ReadTimeoutError {
	return error instanceof ReadTimeoutError;
}
