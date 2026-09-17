import { describe, expect, it, vi } from "vitest";
import { createRawEventTargetState } from "./serve.js";

describe("createRawEventTargetState", () => {
	it("refreshes cached identity state without checking SQLite on each read", () => {
		const hasCurrentIdentity = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
		const store = {
			actorId: "actor-before",
			dbPath: "/memory.sqlite",
			deviceId: "device-1",
			hasCurrentIdentity,
		};
		const target = createRawEventTargetState(store);

		expect(target.hasCurrentIdentity()).toBe(true);
		expect(target.hasCurrentIdentity()).toBe(true);
		expect(hasCurrentIdentity).toHaveBeenCalledOnce();
		store.actorId = "actor-after";
		expect(target.hasCurrentIdentity()).toBe(false);
		expect(hasCurrentIdentity).toHaveBeenCalledOnce();

		target.refreshCurrentIdentity();

		expect(target.hasCurrentIdentity()).toBe(false);
		expect(hasCurrentIdentity).toHaveBeenCalledTimes(2);
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
			hasCurrentIdentity,
		});

		target.refreshCurrentIdentity();

		expect(target.hasCurrentIdentity()).toBe(false);
	});
});
