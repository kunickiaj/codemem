import { MemoryStore, resolveDbPath } from "@codemem/core";

let sharedStore: MemoryStore | null = null;
let sharedStoreClosePromise: Promise<void> | null = null;

/** Share the default connection across viewer and sync listeners. */
export function getStore(): MemoryStore {
	if (!sharedStore) {
		sharedStore = new MemoryStore(resolveDbPath());
	}
	return sharedStore;
}

/** Close a synchronous-only shared store. Async pack owners use closeStoreAsync(). */
export function closeStore(): void {
	sharedStore?.close();
	sharedStore = null;
}

/** Drain semantic work before closing SQLite and releasing the shared store. */
export function closeStoreAsync(): Promise<void> {
	if (sharedStoreClosePromise) return sharedStoreClosePromise;
	if (!sharedStore) return Promise.resolve();
	const store = sharedStore;
	sharedStoreClosePromise = store.closeAsync().then(() => {
		if (sharedStore === store) sharedStore = null;
		sharedStoreClosePromise = null;
	});
	return sharedStoreClosePromise;
}
