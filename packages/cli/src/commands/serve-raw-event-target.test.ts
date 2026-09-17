import { describe, expect, it, vi } from "vitest";
import { createRawEventTargetState } from "./serve.js";

describe("createRawEventTargetState", () => {
	it("refreshes cached identity state without checking SQLite on each read", () => {
		let notifyIdentityChanged = () => {};
		const stop = vi.fn();
		const hasCurrentIdentity = vi.fn().mockReturnValue(true);
		const store = {
			actorId: "actor-before",
			dbPath: "/memory.sqlite",
			deviceId: "device-1",
			hasCurrentConfiguredIdentity: vi.fn().mockReturnValue(true),
			hasCurrentIdentity,
			onIdentityChanged: vi.fn((listener: () => void) => {
				notifyIdentityChanged = listener;
				return stop;
			}),
		};
		const target = createRawEventTargetState(store);

		expect(target.hasCurrentIdentity()).toBe(true);
		expect(target.hasCurrentIdentity()).toBe(true);
		expect(hasCurrentIdentity).toHaveBeenCalledOnce();
		store.actorId = "actor-after";
		expect(target.hasCurrentIdentity()).toBe(false);

		notifyIdentityChanged();

		expect(target.hasCurrentIdentity()).toBe(true);
		expect(hasCurrentIdentity).toHaveBeenCalledTimes(2);
		target.stop();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("fails closed when identity refresh cannot read persisted state", () => {
		const hasCurrentIdentity = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockImplementationOnce(() => {
				throw new Error("database unavailable");
			});
		const target = createRawEventTargetState({
			actorId: "actor-1",
			dbPath: "/memory.sqlite",
			deviceId: "device-1",
			hasCurrentConfiguredIdentity: () => true,
			hasCurrentIdentity,
			onIdentityChanged: (listener) => {
				listener();
				return () => {};
			},
		});

		expect(target.hasCurrentIdentity()).toBe(false);
	});

	it("fails closed when external configuration no longer matches the running store", () => {
		const hasCurrentConfiguredIdentity = vi.fn().mockReturnValue(false);
		const target = createRawEventTargetState({
			actorId: "actor-before",
			dbPath: "/memory.sqlite",
			deviceId: "device-1",
			hasCurrentConfiguredIdentity,
			hasCurrentIdentity: () => true,
			onIdentityChanged: () => () => {},
		});

		expect(target.hasCurrentIdentity()).toBe(false);
		expect(hasCurrentConfiguredIdentity).toHaveBeenCalledOnce();
	});
});
