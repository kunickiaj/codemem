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
	 */
	function forRemoval(freshWork: () => Promise<void>) {
		let slot: ReturnType<typeof reserve> | undefined;

		function reserve() {
			const ready = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const refreshed = runRefresh(async () => {
				ready.resolve();
				await release.promise;
				await freshWork();
			});
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
