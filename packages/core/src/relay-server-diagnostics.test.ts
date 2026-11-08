import { describe, expect, it } from "vitest";
import { sanitizeRelayServerDiagnostic } from "./relay-server-diagnostics.js";

const sessionId = "e".repeat(32);
const events = [
	"route_opened",
	"route_forwarded",
	"route_accepted",
	"route_rejected",
	"route_closed",
] as const;
const reasons = [
	"source_registration_unavailable",
	"admission_context_invalid",
	"source_binding_mismatch",
	"duplicate_session",
	"route_capacity",
	"device_route_capacity",
	"parallel_route",
	"open_quota_rejected",
	"admission_check_failed",
	"source_registration_lost",
	"route_expired",
	"target_registration_absent",
	"target_registration_expired_or_invalid",
	"target_key_mismatch",
	"target_is_source",
	"target_rejected",
	"route_aborted",
	"route_completed",
	"control_busy",
] as const;

describe("relay server diagnostic serialization", () => {
	it.each(events)("copies the allowed %s event", (event) => {
		// Arrange
		const input = { event, sessionId };
		// Act
		const result = sanitizeRelayServerDiagnostic(input);
		// Assert
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
	});
	it.each(reasons)("preserves the allowed %s reason", (reason) => {
		// Arrange
		const input = { event: "route_rejected", sessionId, reason };
		// Act
		const result = sanitizeRelayServerDiagnostic(input);
		// Assert
		expect(result).toEqual(input);
	});
	it("copies only diagnostic fields without reading unrelated sensitive fields", () => {
		// Arrange: accidental engine objects must not become log records.
		const input = {
			event: "route_rejected",
			sessionId,
			reason: "admission_check_failed",
			deviceId: "private-device",
			groupId: "private-group",
			key: "private-key",
			packet: new Uint8Array([1, 2, 3]),
			headers: { authorization: "private-token" },
			url: "https://example.invalid/private",
			address: "192.0.2.1",
			error: new Error("private-exception"),
			get unrelated() {
				throw new Error("must not enumerate or read unrelated fields");
			},
		};
		// Act
		const result = sanitizeRelayServerDiagnostic(input);
		// Assert
		expect(result).toEqual({ event: input.event, sessionId, reason: input.reason });
	});
	it.each([
		null,
		undefined,
		false,
		1,
		"route_opened",
		[],
		{},
		{ event: "data", sessionId },
		{ event: "route_opened", sessionId, reason: "private exception" },
		{ event: "route_rejected", sessionId, reason: null },
		{ event: "route_rejected", sessionId, reason: 1 },
		{ event: "route_opened", sessionId: "E".repeat(32) },
		{ event: "route_opened", sessionId: "g".repeat(32) },
		{ event: "route_opened", sessionId: "e".repeat(31) },
		{ event: "route_opened", sessionId: "e".repeat(33) },
		{ event: "route_opened", sessionId: `${sessionId}\n` },
		{ event: "route_opened", sessionId: 1 },
	])("rejects malformed or unknown diagnostic %#", (input) => {
		// Arrange
		const value: unknown = input;
		// Act
		const result = sanitizeRelayServerDiagnostic(value);
		// Assert
		expect(result).toBeNull();
	});
	it("rejects throwing accessors without exposing the exception", () => {
		// Arrange
		const input = {
			get event() {
				throw new Error("private diagnostic property");
			},
			sessionId,
		};
		// Act
		const result = sanitizeRelayServerDiagnostic(input);
		// Assert
		expect(result).toBeNull();
	});
});
