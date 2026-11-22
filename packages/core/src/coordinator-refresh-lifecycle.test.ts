import { afterEach, expect, it, vi } from "vitest";
import { createCoordinatorRefreshLifecycle } from "./coordinator-refresh-lifecycle.js";

afterEach(() => vi.useRealTimers());

it("rejects a pending reservation at its deadline and skips its work when the queue resumes", async () => {
	vi.useFakeTimers();
	const lifecycle = createCoordinatorRefreshLifecycle();
	const prior = Promise.withResolvers<void>();
	const existing = lifecycle.runRefresh(() => prior.promise);
	const freshWork = vi.fn(async () => {});
	const cleanup = vi.fn();
	const hooks = lifecycle.forRemoval(freshWork, { queueWaitTimeoutMs: 5_000 });
	const wait = hooks.waitForRefresh();
	const removal = wait.then(cleanup);
	const rejected = expect(removal).rejects.toThrow("coordinator_refresh_queue_timeout");
	const laterWork = vi.fn(async () => "later result");
	const later = lifecycle.runRefresh(laterWork);

	await vi.advanceTimersByTimeAsync(4_999);
	expect(cleanup).not.toHaveBeenCalled();
	expect(laterWork).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await rejected;
	await expect(hooks.waitForRefresh()).rejects.toThrow("coordinator_refresh_queue_timeout");
	await expect(hooks.refresh()).rejects.toThrow("coordinator_refresh_queue_timeout");
	expect(vi.getTimerCount()).toBe(0);
	expect(laterWork).not.toHaveBeenCalled();

	prior.resolve();
	await existing;
	await expect(later).resolves.toBe("later result");
	expect(cleanup).not.toHaveBeenCalled();
	expect(freshWork).not.toHaveBeenCalled();
	const nextRemoval = lifecycle.forRemoval(freshWork, { queueWaitTimeoutMs: 5_000 });
	await nextRemoval.waitForRefresh();
	await nextRemoval.refresh();
	expect(freshWork).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it("clears the acquisition timer without timing out acquired cleanup or fresh work", async () => {
	vi.useFakeTimers();
	const lifecycle = createCoordinatorRefreshLifecycle();
	const finishFresh = Promise.withResolvers<void>();
	const freshWork = vi.fn(() => finishFresh.promise);
	const hooks = lifecycle.forRemoval(freshWork, { queueWaitTimeoutMs: 5_000 });
	await hooks.waitForRefresh();
	expect(vi.getTimerCount()).toBe(0);
	const laterWork = vi.fn(async () => {});
	const later = lifecycle.runRefresh(laterWork);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(laterWork).not.toHaveBeenCalled();
	expect(freshWork).not.toHaveBeenCalled();

	const refreshed = hooks.refresh();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(freshWork).toHaveBeenCalledOnce();
	expect(laterWork).not.toHaveBeenCalled();
	finishFresh.resolve();
	await Promise.all([refreshed, later]);
	expect(laterWork).toHaveBeenCalledOnce();
});

it("does not limit ordinary refresh work or removals without an acquisition budget", async () => {
	vi.useFakeTimers();
	const lifecycle = createCoordinatorRefreshLifecycle();
	const prior = Promise.withResolvers<void>();
	const existing = lifecycle.runRefresh(() => prior.promise);
	const freshWork = vi.fn(async () => {});
	const hooks = lifecycle.forRemoval(freshWork);
	const ready = hooks.waitForRefresh();
	expect(vi.getTimerCount()).toBe(0);
	await vi.advanceTimersByTimeAsync(60_000);
	prior.resolve();
	await Promise.all([existing, ready]);
	await hooks.refresh();
	expect(freshWork).toHaveBeenCalledOnce();
});

it("waits for an existing refresh before verified cleanup and refreshes again before queued work", async () => {
	const lifecycle = createCoordinatorRefreshLifecycle();
	const oldRefresh = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const verified = Promise.withResolvers<boolean>();
	const steps: string[] = [];
	const current = lifecycle.runRefresh(async () => {
		steps.push("existing refresh");
		entered.resolve();
		await oldRefresh.promise;
		steps.push("existing refresh complete");
	});
	await entered.promise;

	const hooks = lifecycle.forRemoval(async () => {
		steps.push("post-removal refresh");
	});
	const cleanup = vi.fn(() => steps.push("local cleanup"));
	const removal = (async () => {
		if (!(await verified.promise)) return;
		steps.push("verified");
		await hooks.waitForRefresh();
		cleanup();
		await hooks.refresh();
	})();
	expect(cleanup).not.toHaveBeenCalled();
	verified.resolve(true);
	await Promise.resolve();
	expect(steps).toEqual(["existing refresh", "verified"]);

	const next = lifecycle.runRefresh(async () => {
		steps.push("queued refresh");
	});
	oldRefresh.resolve();
	await Promise.all([current, removal, next]);
	expect(steps).toEqual([
		"existing refresh",
		"verified",
		"existing refresh complete",
		"local cleanup",
		"post-removal refresh",
		"queued refresh",
	]);
});

it("does not reserve the refresh slot when the caller has no verified removal", async () => {
	const lifecycle = createCoordinatorRefreshLifecycle();
	const afterRemoval = vi.fn(async () => {});
	lifecycle.forRemoval(afterRemoval);

	await expect(lifecycle.runRefresh(async () => "ordinary result")).resolves.toBe(
		"ordinary result",
	);
	expect(afterRemoval).not.toHaveBeenCalled();
});

it("keeps concurrent removals in separate slots and starts one fresh pass per removal", async () => {
	const lifecycle = createCoordinatorRefreshLifecycle();
	const steps: string[] = [];
	const first = lifecycle.forRemoval(async () => {
		steps.push("first refresh");
	});
	const second = lifecycle.forRemoval(async () => {
		steps.push("second refresh");
	});
	const firstReady = first.waitForRefresh();
	const secondReady = second.waitForRefresh().then(() => steps.push("second cleanup"));

	await firstReady;
	expect(steps).toEqual([]);
	steps.push("first cleanup");
	const refresh = first.refresh();
	expect(first.refresh()).toBe(refresh);
	await Promise.all([refresh, secondReady]);
	await second.refresh();
	expect(steps).toEqual(["first cleanup", "first refresh", "second cleanup", "second refresh"]);
});

it("releases the slot after a failed refresh without hiding the failure from its caller", async () => {
	const lifecycle = createCoordinatorRefreshLifecycle();
	const earlier = lifecycle.runRefresh(async () => {
		throw new Error("earlier refresh failed");
	});
	const hooks = lifecycle.forRemoval(async () => {
		throw new Error("follow-up refresh failed");
	});

	await expect(earlier).rejects.toThrow("earlier refresh failed");
	await hooks.waitForRefresh();
	await expect(hooks.refresh()).rejects.toThrow("follow-up refresh failed");
	await expect(lifecycle.runRefresh(async () => "resumed")).resolves.toBe("resumed");
});
