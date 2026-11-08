import { afterEach, describe, expect, it, vi } from "vitest";
import { logRelayDecision } from "./relay-decision-logger.js";

const sessionId = "0123456789abcdef0123456789abcdef";
afterEach(() => vi.restoreAllMocks());

describe("temporary relay decision logger", () => {
	it.each([
		["route_opened", undefined],
		["route_forwarded", undefined],
		["route_accepted", undefined],
		["route_rejected", "target_registration_absent"],
		["route_closed", "route_completed"],
	] as const)("serializes %s with only the allowed fields", (event, reason) => {
		// Arrange: raw data must never reach the serializer, even on valid decisions.
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const raw = "private-raw-data-sentinel";
		const input = {
			event,
			sessionId,
			...(reason ? { reason } : {}),
			payload: raw,
			headers: { authorization: raw },
			packet: raw,
			key: raw,
			address: raw,
			deviceId: raw,
			groupId: raw,
			toJSON: () => {
				throw new Error(raw);
			},
		};
		// Act.
		logRelayDecision(input);
		// Assert: exact JSON also excludes the optional reason when absent.
		expect(log.mock.calls).toEqual([
			[
				JSON.stringify({
					event: "codemem.relay.decision",
					decision: event,
					route_id: sessionId,
					...(reason ? { reason } : {}),
				}),
			],
		]);
	});

	it.each([
		null,
		undefined,
		[],
		"private-raw-data-sentinel",
		{ event: "private-raw-data-sentinel", sessionId },
		{ event: "route_opened", sessionId, reason: "private-raw-data-sentinel" },
		{ event: "route_opened", sessionId, reason: null },
		...[
			"",
			"a".repeat(31),
			"a".repeat(33),
			"A".repeat(32),
			"g".repeat(32),
			`${sessionId}\n`,
			123,
		].map((id) => ({ event: "route_opened", sessionId: id })),
		{ event: "route_opened" },
		{ sessionId },
	])("does not log invalid diagnostic %#", (value) => {
		// Arrange.
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		// Act.
		logRelayDecision(value);
		// Assert.
		expect(log).not.toHaveBeenCalled();
	});

	it("rejects throwing accessors without logging exception text", () => {
		// Arrange.
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const value = {
			get event() {
				throw new Error("private-accessor-sentinel");
			},
		};
		// Act.
		const invoke = () => logRelayDecision(value);
		// Assert.
		expect(invoke).not.toThrow();
		expect(log).not.toHaveBeenCalled();
	});

	it("does not interrupt the host when console.log throws", () => {
		// Arrange.
		const log = vi.spyOn(console, "log").mockImplementation(() => {
			throw new Error("console unavailable");
		});
		// Act.
		const invoke = () => logRelayDecision({ event: "route_opened", sessionId });
		// Assert.
		expect(invoke).not.toThrow();
		expect(log).toHaveBeenCalledTimes(1);
	});
});
