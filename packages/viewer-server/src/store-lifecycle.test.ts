import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { closeStoreAsync, getStore } from "./index.js";

it("shares async cleanup and releases the viewer store only after draining", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codemem-viewer-close-"));
	vi.stubEnv("CODEMEM_DB", join(directory, "memory.sqlite"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const store = getStore();
	const cleanup = Promise.withResolvers<void>();
	const original = store.closeAsync.bind(store);
	const close = vi.spyOn(store, "close").mockImplementation(() => {
		throw new Error("semantic_store_close_async_required");
	});
	vi.spyOn(store, "closeAsync").mockImplementation(async () => {
		await cleanup.promise;
		await original();
	});
	try {
		const closing = closeStoreAsync();
		expect(closeStoreAsync()).toBe(closing);
		expect(getStore()).toBe(store);
		expect(store.db.open).toBe(true);
		cleanup.resolve();
		await closing;
		expect(store.db.open).toBe(false);
		expect(getStore()).not.toBe(store);
		expect(close).not.toHaveBeenCalled();
	} finally {
		cleanup.resolve();
		await closeStoreAsync();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}
});
