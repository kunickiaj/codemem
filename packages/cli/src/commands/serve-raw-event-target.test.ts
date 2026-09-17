import { describe, expect, it, vi } from "vitest";
import { createRawEventTargetState } from "./serve.js";

describe("createRawEventTargetState", () => {
	it("refreshes cached identity state without checking SQLite on each read", () => {
		let notifyIdentityChanged = () => {};
		const stop = vi.fn();
		const hasCurrentIdentity = vi.fn().mockReturnValue(true);
		const store = {
			dbPath: "/memory.sqlite",
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
			dbPath: "/memory.sqlite",
			hasCurrentIdentity,
			onIdentityChanged: (listener) => {
				listener();
				return () => {};
			},
		});

		expect(target.hasCurrentIdentity()).toBe(false);
	});
});
