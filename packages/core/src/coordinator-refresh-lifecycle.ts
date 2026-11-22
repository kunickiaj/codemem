/** Own one lifecycle per served store. The callbacks run refresh work, not the daemon timer. */
export function createCoordinatorRefreshLifecycle() {
	let tail = Promise.resolve();

	function runRefresh<T>(work: () => Promise<T>): Promise<T> {
		const result = tail.then(work);
		// One failing refresh must not prevent later attempts.
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * Create one pair of hooks per removal attempt. After coordinator proof,
	 * waitForRefresh reserves the next slot until local cleanup has finished.
	 * The caller must call refresh to release that slot even if cleanup failed.
	 * The fresh work runs in the same slot and must not enqueue itself.
	 * An optional queue budget expires only before acquisition. Expired slots
	 * reject both hooks and skip fresh work without interrupting the queue.
	 */
	function forRemoval(
		freshWork: () => Promise<void>,
		{ queueWaitTimeoutMs }: { queueWaitTimeoutMs?: number } = {},
	) {
		let slot: ReturnType<typeof reserve> | undefined;

		function reserve() {
			const ready = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let timedOut = false;
			const timer =
				queueWaitTimeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							ready.reject(new Error("coordinator_refresh_queue_timeout"));
							release.resolve();
						}, queueWaitTimeoutMs);
			const queued = runRefresh(async () => {
				if (timedOut) return;
				clearTimeout(timer);
				ready.resolve();
				await release.promise;
				await freshWork();
			});
			// A timed-out reservation remains in queue order but must never run fresh work.
			// Report its failure immediately, even while earlier work is still running.
			const refreshed = ready.promise.then(() => queued);
			// The caller may still be waiting for acquisition when this promise rejects.
			void refreshed.catch(() => {});
			return { ready: ready.promise, release: release.resolve, refreshed };
		}

		return {
			waitForRefresh(): Promise<void> {
				slot ??= reserve();
				return slot.ready;
			},
			refresh(): Promise<void> {
				slot ??= reserve();
				slot.release();
				return slot.refreshed;
			},
		};
	}

	return { runRefresh, forRemoval };
}
