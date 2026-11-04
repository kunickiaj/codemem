import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { types } from "node:util";
import type { OwnedPeerHttpConnection } from "./peer-http-client.js";
import {
	PEER_HTTP_LIMITS,
	PeerHttpExchangeError,
	type PeerHttpExchangeErrorCode,
} from "./peer-http-policy.js";

/** One exchange's absolute deadline and first locally classified failure. */
export class PeerHttpLifetime {
	readonly controller = new AbortController();
	private readonly stopped = Promise.withResolvers<never>();
	private readonly timer: ReturnType<typeof setTimeout>;
	private failure?: PeerHttpExchangeError;
	private readonly abort = (): void => {
		this.fail("cancelled");
	};

	constructor(
		readonly deadlineMs: number,
		private readonly signal?: AbortSignal,
	) {
		void this.stopped.promise.catch(() => {});
		this.timer = setTimeout(
			() => this.fail("deadline"),
			Math.max(0, deadlineMs - performance.now()),
		);
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	get failed(): boolean {
		return this.failure !== undefined;
	}

	fail(code: PeerHttpExchangeErrorCode): PeerHttpExchangeError {
		this.failure ??= new PeerHttpExchangeError(code);
		// The relay route reads this reason to tell a malformed response from a deadline.
		this.controller.abort(this.failure);
		this.stopped.reject(this.failure);
		return this.failure;
	}

	check(): void {
		if (this.failure) throw this.failure;
		if (performance.now() >= this.deadlineMs) throw this.fail("deadline");
	}

	async wait<T>(promise: Promise<T>): Promise<T> {
		const value = await Promise.race([promise, this.stopped.promise]);
		this.check();
		return value;
	}

	close(): void {
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.abort);
	}
}

/** The trusted port owns raw I/O and disposal. This wrapper calls its disposer at most once. */
export function adoptPeerHttpConnection(connection: OwnedPeerHttpConnection) {
	const dispose = connection.dispose.bind(connection);
	let cleanup: Promise<void> | undefined;
	const cleanupOwner = {
		dispose: (error: Error): Promise<void> => {
			cleanup ??= boundedCleanup(() => dispose(error));
			return cleanup;
		},
	};
	try {
		// A missing value or arbitrary thenable cannot prove clean raw I/O and disposal.
		const completion = connection.completion;
		if (!types.isPromise(completion)) return { valid: false as const, ...cleanupOwner };
		void completion.catch(() => {});
		const duplex = connection.duplex;
		if (!(duplex instanceof Duplex)) return { valid: false as const, ...cleanupOwner };
		return { valid: true as const, ...cleanupOwner, duplex, completion };
	} catch {
		// Preserve the captured disposer when a later port getter or validation fails.
		return { valid: false as const, ...cleanupOwner };
	}
}

async function boundedCleanup(dispose: () => Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(dispose),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new PeerHttpExchangeError("cleanup")),
					PEER_HTTP_LIMITS.cleanupMs,
				);
			}),
		]);
	} catch {
		throw new PeerHttpExchangeError("cleanup");
	} finally {
		clearTimeout(timer);
	}
}
