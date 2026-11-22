import type { MemoryStore } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import {
	createServeCoordinatorRefresh,
	VIEWER_REMOVAL_QUEUE_WAIT_TIMEOUT_MS,
} from "./serve-coordinator-refresh.js";

afterEach(() => vi.useRealTimers());

function fixtureOptions() {
	const store = { db: {} as MemoryStore["db"], dbPath: ":memory:" };
	const abort = new AbortController();
	return { store, signal: abort.signal, abort };
}

it("limits Viewer removal queue acquisition without releasing an active daemon pass", async () => {
	vi.useFakeTimers();
	const fresh = vi.fn(async () => ({ refreshed: true, peers: [] }));
	const { daemon, viewer } = createServeCoordinatorRefresh(fixtureOptions(), fresh);
	const release = Promise.withResolvers<void>();
	const existing = daemon.runCoordinatorRefresh(() => release.promise);
	const removal = viewer.createDeviceRemovalRefreshHooks();
	const cleanup = vi.fn();
	const rejected = expect(removal.waitForRefresh().then(cleanup)).rejects.toThrow(
		"coordinator_refresh_queue_timeout",
	);
	const manualWork = vi.fn(async () => "manual result");
	const manual = viewer.runManualCoordinatorRefresh(manualWork);

	await vi.advanceTimersByTimeAsync(VIEWER_REMOVAL_QUEUE_WAIT_TIMEOUT_MS);
	await rejected;
	await expect(removal.refresh()).rejects.toThrow("coordinator_refresh_queue_timeout");
	expect(manualWork).not.toHaveBeenCalled();
	expect(fresh).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);

	release.resolve();
	await existing;
	await expect(manual).resolves.toBe("manual result");
	expect(cleanup).not.toHaveBeenCalled();
	expect(fresh).not.toHaveBeenCalled();
});

it("clears the Viewer removal deadline after fast acquisition and retains exclusive cleanup", async () => {
	vi.useFakeTimers();
	const fresh = vi.fn(async () => ({ refreshed: true, peers: [] }));
	const { daemon, viewer } = createServeCoordinatorRefresh(fixtureOptions(), fresh);
	const removal = viewer.createDeviceRemovalRefreshHooks();
	await removal.waitForRefresh();
	expect(vi.getTimerCount()).toBe(0);
	const nextWork = vi.fn(async () => {});
	const next = daemon.runCoordinatorRefresh(nextWork);
	await vi.advanceTimersByTimeAsync(VIEWER_REMOVAL_QUEUE_WAIT_TIMEOUT_MS * 2);
	expect(nextWork).not.toHaveBeenCalled();
	expect(fresh).not.toHaveBeenCalled();
	await removal.refresh();
	await next;
	expect(fresh).toHaveBeenCalledOnce();
	expect(nextWork).toHaveBeenCalledOnce();
});

it("shares the daemon refresh queue with each Viewer removal", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const events: string[] = [];
	const fresh = vi.fn(async () => {
		events.push("fresh coordinator pass");
		return { refreshed: true, peers: [] };
	});
	const options = fixtureOptions();
	const { daemon, viewer } = createServeCoordinatorRefresh(options, fresh);
	const existing = daemon.runCoordinatorRefresh(async () => {
		events.push("daemon refresh");
		entered.resolve();
		await release.promise;
		events.push("daemon maintenance complete");
		return "daemon result";
	});
	await entered.promise;

	const removal = viewer.createDeviceRemovalRefreshHooks();
	const cleanup = (async () => {
		await removal.waitForRefresh();
		events.push("verified local cleanup");
		await removal.refresh();
	})();
	expect(events).toEqual(["daemon refresh"]);
	const next = daemon.runCoordinatorRefresh(async () => {
		events.push("next daemon refresh");
	});
	release.resolve();
	await Promise.all([cleanup, next]);
	expect(await existing).toBe("daemon result");
	expect(events).toEqual([
		"daemon refresh",
		"daemon maintenance complete",
		"verified local cleanup",
		"fresh coordinator pass",
		"next daemon refresh",
	]);
	expect(fresh).toHaveBeenCalledOnce();
	expect(fresh).toHaveBeenCalledWith(
		options.store.db,
		options.store.dbPath,
		process.env.CODEMEM_KEYS_DIR?.trim() || undefined,
	);
});

it("does not start a fresh pass after the foreground runtime is aborted", async () => {
	const options = fixtureOptions();
	const fresh = vi.fn(async () => ({ refreshed: true, peers: [] }));
	const { daemon, viewer } = createServeCoordinatorRefresh(options, fresh);
	const hooks = viewer.createDeviceRemovalRefreshHooks();
	await hooks.waitForRefresh();
	options.abort.abort(new Error("foreground runtime stopped"));
	await expect(hooks.refresh()).rejects.toThrow("foreground runtime stopped");
	expect(fresh).not.toHaveBeenCalled();
	await expect(daemon.runCoordinatorRefresh(async () => "queue released")).resolves.toBe(
		"queue released",
	);
});

it("does not combine separate foreground stores or start refresh work on construction", async () => {
	const fresh = vi.fn(async () => ({ refreshed: true, peers: [] }));
	const first = createServeCoordinatorRefresh(fixtureOptions(), fresh);
	const second = createServeCoordinatorRefresh(fixtureOptions(), fresh);
	const release = Promise.withResolvers<void>();
	const existing = first.daemon.runCoordinatorRefresh(() => release.promise);
	try {
		expect(await second.daemon.runCoordinatorRefresh(async () => "other store")).toBe(
			"other store",
		);
		expect(fresh).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await existing;
	}
});

it("does not start a queued manual refresh after the foreground runtime aborts", async () => {
	const options = fixtureOptions();
	const { daemon, viewer } = createServeCoordinatorRefresh(options);
	const release = Promise.withResolvers<void>();
	const existing = daemon.runCoordinatorRefresh(() => release.promise);
	const work = vi.fn(async () => "manual work");
	const pending = viewer.runManualCoordinatorRefresh(work);
	options.abort.abort(new Error("foreground runtime stopped"));
	release.resolve();
	await existing;
	await expect(pending).rejects.toThrow("foreground runtime stopped");
	expect(work).not.toHaveBeenCalled();
});
