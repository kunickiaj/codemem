import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	APPROVAL,
	cancelled,
	created,
	createLocalDevice,
	errorCode,
	fakeCoordinator,
	finalized,
	json,
	polled,
	runHeadless,
} from "./coordinator-account-link-headless-test-fixtures.js";
import { deviceKey, NOW } from "./coordinator-device-headless-link-test-fixtures.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));
vi.mock("node:timers/promises", async (importOriginal) => {
	const timers = await importOriginal<typeof import("node:timers/promises")>();
	return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

const key = deviceKey("device-a");
let local: ReturnType<typeof createLocalDevice>;
let waits: number[];
beforeEach(() => {
	local = createLocalDevice(key);
	waits = [];
	vi.mocked(delay).mockImplementation(async (ms, _value, options) => {
		waits.push(Number(ms));
		options?.signal?.throwIfAborted();
		return undefined;
	});
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	local.cleanup();
});

const rateLimited = (retryAfter: string) => () =>
	json({ error: "rate_limited", retry_after_s: 1 }, 429, { "Retry-After": retryAfter });
const unreachable = () => Promise.reject(new Error("request timed out"));

describe("headless link polling cadence", () => {
	it("slows down after a rate-limit reply", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [rateLimited("2"), rateLimited("30"), polled("confirmed", APPROVAL)],
			finalize: [finalized],
		});
		// Act
		const { result } = runHeadless(local, coordinator);
		// Assert
		await expect(result).resolves.toMatchObject({ state: "finalized" });
		// interval+5 s beats a 2 s Retry-After; a 30 s Retry-After beats interval+5 s.
		expect(waits).toEqual([5000, 10_000, 30_000]);
	});

	it("backs off on transport failures and resets after a reply", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [
				unreachable,
				unreachable,
				unreachable,
				unreachable,
				polled("pending"),
				polled("confirmed", APPROVAL),
			],
			finalize: [finalized],
		});
		// Act
		const { result } = runHeadless(local, coordinator);
		// Assert
		await expect(result).resolves.toMatchObject({ state: "finalized" });
		expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 5000]);
	});
});

describe("headless link stops", () => {
	it("stops without cancelling once the attempt expires", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("pending"), polled("expired")],
		});
		// Act
		const { result } = runHeadless(local, coordinator);
		// Assert
		expect(await errorCode(result)).toBe("link_stopped");
		expect(coordinator.routes()).toEqual(["create", "status", "status"]);
	});

	it("stops polling when the attempt deadline passes", async () => {
		// Arrange
		const now = vi.mocked(Date.now);
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("pending")],
			cancel: [cancelled],
		});
		// Act
		const { result } = runHeadless(local, coordinator, {
			onState: () => now.mockReturnValue(NOW + 600_001),
		});
		// Assert
		expect(await errorCode(result)).toBe("link_stopped");
		expect(coordinator.routes()).toEqual(["create", "cancel"]);
	});

	it("cancels the attempt when the caller aborts", async () => {
		// Arrange
		const controller = new AbortController();
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("pending"), polled("browser_claimed")],
			cancel: [cancelled],
		});
		// Act
		const { result } = runHeadless(local, coordinator, {
			signal: controller.signal,
			onState: (state) => {
				if (state === "browser_claimed") controller.abort();
			},
		});
		// Assert
		expect(await errorCode(result)).toBe("link_stopped");
		expect(coordinator.routes()).toEqual(["create", "status", "status", "cancel"]);
	});

	it("treats a prompt cut short by cancellation as a stop and cancels", async () => {
		// Arrange
		const controller = new AbortController();
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("confirmed", APPROVAL)],
			cancel: [cancelled],
		});
		// Act
		const { result } = runHeadless(local, coordinator, {
			signal: controller.signal,
			approve: async () => {
				controller.abort();
				return true;
			},
		});
		// Assert
		expect(await errorCode(result)).toBe("link_stopped");
		expect(coordinator.routes()).toEqual(["create", "status", "cancel"]);
	});

	it("reports unconfirmed cancellation when the cancel request fails", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("confirmed", APPROVAL)],
			cancel: [unreachable],
		});
		// Act
		const { result } = runHeadless(local, coordinator, { approve: async () => false });
		// Assert
		expect(await errorCode(result)).toBe("cancellation_unconfirmed");
	});
});
