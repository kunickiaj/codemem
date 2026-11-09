import { describe, expect, it } from "vitest";
import { type HookDeliveryOutcome, normalizeHookDeliveryOutcome } from "./hook-delivery-outcome.js";

describe("normalizeHookDeliveryOutcome", () => {
	const cases: Array<{ label: string; input: unknown; expected: HookDeliveryOutcome }> = [
		{ label: "boolean true", input: true, expected: { outcome: "accepted" } },
		{ label: "boolean false", input: false, expected: { outcome: "retryable" } },
		{ label: "accepted", input: { outcome: "accepted" }, expected: { outcome: "accepted" } },
		{ label: "retryable", input: { outcome: "retryable" }, expected: { outcome: "retryable" } },
		{
			label: "invalid payload",
			input: { outcome: "terminal", status: 400, reason: "invalid_payload" },
			expected: { outcome: "terminal", status: 400, reason: "invalid_payload" },
		},
		{
			label: "oversized payload",
			input: { outcome: "terminal", status: 413, reason: "payload_too_large" },
			expected: { outcome: "terminal", status: 413, reason: "payload_too_large" },
		},
		{
			label: "400 with mismatched reason",
			input: { outcome: "terminal", status: 400, reason: "payload_too_large" },
			expected: { outcome: "retryable" },
		},
		{
			label: "413 with mismatched reason",
			input: { outcome: "terminal", status: 413, reason: "invalid_payload" },
			expected: { outcome: "retryable" },
		},
		{ label: "unknown object", input: {}, expected: { outcome: "retryable" } },
		{ label: "missing value", input: undefined, expected: { outcome: "retryable" } },
	];

	it.each(cases)("normalizes $label", ({ input, expected }) => {
		// Arrange: valid outcomes and malformed runtime values share the public boundary.
		const value: unknown = input;

		// Act.
		const result = normalizeHookDeliveryOutcome(value);

		// Assert: only exact terminal status/reason pairs keep their classification.
		expect(result).toEqual(expected);
	});
});
