import type { ObserverClient, RawEventSweeper } from "@codemem/core";
import { expect, it, vi } from "vitest";
import { ObserverRuntimeController } from "./observer-runtime-controller.js";

function observer(model: string): ObserverClient {
	return {
		toConfig: () => ({
			observerProvider: "openai",
			observerModel: model,
			observerRuntime: "api_http",
			observerTierRoutingEnabled: false,
		}),
		getStatus: () => ({
			provider: "openai",
			model,
			runtime: "api_http",
			auth: { type: "api_direct", source: "env", hasToken: true },
		}),
	} as unknown as ObserverClient;
}

it("keeps the old observer active while draining, then applies only the latest saved model", async () => {
	let release: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = observer("old");
	const next = observer("newest");
	const createObserver = vi.fn(() => next);
	const reconfigureObserver = vi.fn(
		async (create: () => ObserverClient, options: { shouldResume?: () => boolean }) => {
			await pending;
			return options.shouldResume?.() ? create() : null;
		},
	);
	const controller = new ObserverRuntimeController(
		first,
		{ reconfigureObserver } as unknown as RawEventSweeper,
		createObserver,
	);
	expect(controller.requestApply()).toBe(true);
	expect(controller.getStatus()).toMatchObject({ state: "applying", active: { model: "old" } });
	expect(controller.getStatus().active.simple.model).toBe("old");
	expect(controller.requestApply()).toBe(true);
	release?.();
	await vi.waitFor(() =>
		expect(controller.getStatus()).toMatchObject({ state: "active", active: { model: "newest" } }),
	);
	expect(reconfigureObserver).toHaveBeenCalledTimes(2);
	expect(createObserver).toHaveBeenCalledTimes(1);
	await controller.stop();
});

it("keeps queued work paused when saved settings cannot initialize and retries explicitly", async () => {
	const first = observer("old");
	const next = observer("new");
	const createObserver = vi
		.fn()
		.mockImplementationOnce(() => {
			throw new Error("credential details must not leak");
		})
		.mockReturnValue(next);
	const reconfigureObserver = vi.fn(async (create: () => ObserverClient) => create());
	const controller = new ObserverRuntimeController(
		first,
		{ reconfigureObserver } as unknown as RawEventSweeper,
		createObserver,
	);
	controller.requestApply();
	await vi.waitFor(() =>
		expect(controller.getStatus()).toMatchObject({ state: "failed", active: { model: "old" } }),
	);
	expect(JSON.stringify(controller.getStatus())).not.toContain("credential details must not leak");
	controller.requestApply();
	await vi.waitFor(() =>
		expect(controller.getStatus()).toMatchObject({ state: "active", active: { model: "new" } }),
	);
	await controller.stop();
});

it("reports effective simple and rich models without returning credentials", () => {
	const active = observer("base");
	active.toConfig = () =>
		({
			observerProvider: "openai",
			observerModel: "base",
			observerRuntime: "api_http",
			observerTierRoutingEnabled: true,
			observerSimpleModel: "gpt-6-luna",
			observerRichModel: "gpt-5.6-terra",
			observerMaxTokens: 4000,
		}) as ReturnType<ObserverClient["toConfig"]>;
	const controller = new ObserverRuntimeController(active, {} as RawEventSweeper, () => active);
	const status = controller.getStatus();
	expect(status.active.simple.model).toBe("gpt-6-luna");
	expect(status.active.rich.model).toBe("gpt-5.6-terra");
	expect(JSON.stringify(status)).not.toContain("apiKey");
});
