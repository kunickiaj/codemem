import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const bridgeUrl = pathToFileURL(
	path.resolve(import.meta.dirname, "../.opencode/lib/v2-notification-bridge.js"),
).href;
const { createNotificationBacklog, registerV2NotificationBridge } = await import(bridgeUrl);

describe("OpenCode 2 notification bridge", () => {
	it("keeps only the newest notices and drains them once", () => {
		let nextID = 0;
		const backlog = createNotificationBacklog({
			maxNotices: 2,
			createID: () => `notice-${++nextID}`,
		});
		backlog.push({ message: "one", variant: "warning" });
		backlog.push({ message: "two", variant: "success" });
		backlog.push({ message: "three", variant: "error" });

		expect(backlog.drain()).toEqual([
			{ id: "notice-2", message: "two", variant: "success" },
			{ id: "notice-3", message: "three", variant: "error" },
		]);
		expect(backlog.drain()).toEqual([]);
		backlog.push({ message: "four", variant: "info" });
		expect(backlog.drain()).toEqual([]);
	});

	it("publishes live and preserves replay when event delivery fails", async () => {
		const emit = vi.fn(async () => {
			throw new Error("no subscribers");
		});
		let handlers: { drain: () => Promise<{ notices: unknown[] }> } | undefined;
		const dispose = vi.fn(async () => undefined);
		const context = {
			rpc: {
				register: vi.fn(async (_definition, registeredHandlers) => {
					handlers = registeredHandlers;
					return { dispose, events: { emit } };
				}),
			},
		};
		const bridge = await registerV2NotificationBridge(context, { createID: () => "notice-1" });

		await expect(bridge.notify?.({ message: "ready", variant: "info" })).resolves.toBeUndefined();
		expect(emit).toHaveBeenCalledWith("notice", {
			id: "notice-1",
			message: "ready",
			variant: "info",
		});
		await expect(handlers?.drain()).resolves.toEqual({
			notices: [{ id: "notice-1", message: "ready", variant: "info" }],
		});
		await bridge.notify?.({ message: "delivered live", variant: "success" });
		await expect(handlers?.drain()).resolves.toEqual({ notices: [] });

		await bridge.registration?.dispose();
		expect(dispose).toHaveBeenCalledOnce();
		await bridge.notify?.({ message: "late", variant: "warning" });
		expect(emit).toHaveBeenCalledTimes(2);
	});

	it("contains synchronous event publication failures", async () => {
		const emit = vi.fn(() => {
			throw new Error("event transport failed");
		});
		const context = {
			rpc: {
				register: vi.fn(async () => ({
					dispose: vi.fn(async () => undefined),
					events: { emit },
				})),
			},
		};
		const bridge = await registerV2NotificationBridge(context);

		await expect(bridge.notify?.({ message: "ready", variant: "info" })).resolves.toBeUndefined();
	});

	it("disables notifications when RPC registration fails", async () => {
		const context = {
			rpc: { register: vi.fn(async () => Promise.reject(new Error("RPC unavailable"))) },
		};

		await expect(registerV2NotificationBridge(context)).resolves.toEqual({
			notify: null,
			registration: null,
		});
	});

	it("bounds stalled registration and disposes a late registration", async () => {
		let resolveRegistration:
			| ((registration: {
					dispose: () => Promise<void>;
					events: { emit: () => Promise<void> };
			  }) => void)
			| undefined;
		const dispose = vi.fn(async () => undefined);
		const registration = new Promise<{
			dispose: () => Promise<void>;
			events: { emit: () => Promise<void> };
		}>((resolve) => {
			resolveRegistration = resolve;
		});
		const context = { rpc: { register: vi.fn(() => registration) } };

		const outcome = await Promise.race([
			registerV2NotificationBridge(context, { registrationTimeoutMs: 5 }).then(
				(bridge: { notify: unknown; registration: unknown }) => ({
					kind: "bridge" as const,
					bridge,
				}),
			),
			new Promise<{ kind: "timeout" }>((resolve) =>
				setTimeout(() => resolve({ kind: "timeout" }), 100),
			),
		]);
		expect(outcome).toEqual({
			kind: "bridge",
			bridge: { notify: null, registration: null },
		});
		resolveRegistration?.({ dispose, events: { emit: async () => undefined } });
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
	});
});
