import {
	createCoordinatorRefreshLifecycle,
	type MemoryStore,
	refreshCoordinatorForDaemon,
} from "@codemem/core";

/** Share one queue between foreground daemon work and each Viewer removal. */
export function createServeCoordinatorRefresh(
	{ store, signal }: { store: Pick<MemoryStore, "db" | "dbPath">; signal: AbortSignal },
	refresh = refreshCoordinatorForDaemon,
) {
	const lifecycle = createCoordinatorRefreshLifecycle();
	const refreshAfterRemoval = async () => {
		signal.throwIfAborted();
		const result = await refresh(
			store.db,
			store.dbPath,
			process.env.CODEMEM_KEYS_DIR?.trim() || undefined,
		);
		if (!result.refreshed) throw new Error("coordinator_refresh_unavailable");
	};
	return {
		daemon: { runCoordinatorRefresh: lifecycle.runRefresh },
		viewer: {
			createDeviceRemovalRefreshHooks: () => lifecycle.forRemoval(refreshAfterRemoval),
			runManualCoordinatorRefresh: <T>(work: () => Promise<T>) =>
				lifecycle.runRefresh(() => {
					signal.throwIfAborted();
					return work();
				}),
		},
	};
}
