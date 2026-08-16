import { describe, expect, it } from "vitest";
import {
	arePromptTransportProtocolRangesCompatible,
	classifyPromptTransportFailure,
	normalizePromptTransportProtocolRange,
	PROMPT_TRANSPORT_PROTOCOL_RANGE,
} from "./prompt-transport.js";

function protocolRange(protocolVersion: number, minSupportedProtocolVersion?: number) {
	const range = normalizePromptTransportProtocolRange(protocolVersion, minSupportedProtocolVersion);
	if (!range) throw new Error("expected a valid prompt transport protocol range");
	return range;
}

describe("prompt transport protocol ranges", () => {
	it("defines the current supported range explicitly", () => {
		expect(PROMPT_TRANSPORT_PROTOCOL_RANGE).toEqual({
			minSupportedProtocolVersion: 1,
			protocolVersion: 1,
		});
	});

	it("supports old-client/new-Viewer and new-client/old-Viewer overlap", () => {
		const oldClient = protocolRange(1);
		const newViewer = protocolRange(2, 1);
		const newClient = protocolRange(2, 1);
		const oldViewer = protocolRange(1);

		expect(arePromptTransportProtocolRangesCompatible(oldClient, newViewer)).toBe(true);
		expect(arePromptTransportProtocolRangesCompatible(newClient, oldViewer)).toBe(true);
	});

	it("rejects malformed and non-overlapping ranges", () => {
		expect(normalizePromptTransportProtocolRange(0)).toBeNull();
		expect(normalizePromptTransportProtocolRange(1.5)).toBeNull();
		expect(normalizePromptTransportProtocolRange(1, null)).toBeNull();
		expect(normalizePromptTransportProtocolRange(1, 2)).toBeNull();

		const client = protocolRange(1);
		const viewer = protocolRange(3, 2);
		expect(arePromptTransportProtocolRangesCompatible(client, viewer)).toBe(false);
	});
});

describe("prompt transport failure classification", () => {
	it.each([
		"profile_absent",
		"profile_malformed",
		"protocol_range_mismatch",
		"network_unavailable",
		"network_timeout",
		"network_reset",
		"viewer_restart",
		"malformed_response",
	] as const)("classifies %s as fallback", (kind) => {
		expect(classifyPromptTransportFailure({ kind })).toBe("fallback");
	});

	it.each([
		"database_mismatch",
		"runtime_identity_mismatch",
	] as const)("classifies %s as one-shot local fallback", (kind) => {
		expect(classifyPromptTransportFailure({ kind })).toBe("local_fallback");
	});

	it.each([
		"invalid_request",
		"policy_failure",
		"authorization_failure",
	] as const)("classifies %s as terminal", (kind) => {
		expect(classifyPromptTransportFailure({ kind })).toBe("terminal");
	});

	it("distinguishes contract skew before and after a compatible profile", () => {
		expect(
			classifyPromptTransportFailure({
				kind: "viewer_contract_unsupported",
				compatibleProfile: false,
			}),
		).toBe("fallback");
		expect(
			classifyPromptTransportFailure({
				kind: "viewer_contract_unsupported",
				compatibleProfile: true,
			}),
		).toBe("terminal");
	});
});
