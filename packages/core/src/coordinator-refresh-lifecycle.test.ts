import { expect, it, vi } from "vitest";
import { createCoordinatorRefreshLifecycle } from "./coordinator-refresh-lifecycle.js";

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
