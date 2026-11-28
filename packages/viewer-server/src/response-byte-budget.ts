/**
 * Bounds the response bytes a listener may hold in memory at once. Each
 * exchange reserves the largest response it could produce before the response
 * is collected, and releases the reservation once the response is written.
 * Waiters are served in arrival order.
 */
export class ResponseByteBudget {
	private available: number;
	private readonly waiters: Array<{ bytes: number; resolve: () => void }> = [];

	constructor(readonly totalBytes: number) {
		if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
			throw new RangeError("Response byte budget must be a positive integer");
		this.available = totalBytes;
	}

	/** Resolves with a release function once the bytes are reserved. */
	async acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
		if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.totalBytes)
			throw new RangeError("Response reservation exceeds the budget");
		signal?.throwIfAborted();
		if (this.waiters.length === 0 && this.available >= bytes) {
			this.available -= bytes;
			return this.releaser(bytes);
		}
		await new Promise<void>((resolve, reject) => {
			const waiter = { bytes, resolve };
			this.waiters.push(waiter);
			signal?.addEventListener(
				"abort",
				() => {
					const index = this.waiters.indexOf(waiter);
					if (index < 0) return;
					this.waiters.splice(index, 1);
					reject(signal.reason ?? new Error("Response reservation cancelled"));
					this.drain();
				},
				{ once: true },
			);
		});
		return this.releaser(bytes);
	}

	get availableBytes(): number {
		return this.available;
	}

	private releaser(bytes: number): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.available += bytes;
			this.drain();
		};
	}

	private drain(): void {
		while (this.waiters[0] && this.available >= this.waiters[0].bytes) {
			const next = this.waiters.shift();
			if (!next) return;
			this.available -= next.bytes;
			next.resolve();
		}
	}
}
