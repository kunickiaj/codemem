import { describe, expect, it } from "vitest";
import type { ControllerHistoryEvidence } from "./coordinator-auth-controller-history.js";
import { historicalOwnerHints } from "./coordinator-auth-controller-owner-review.js";
import type { CoordinatorLegacyTeamCompletionDeviceDecisionV1 } from "./coordinator-legacy-team-completion.js";

type Snapshot = Parameters<typeof historicalOwnerHints>[1];

function history(decisions: CoordinatorLegacyTeamCompletionDeviceDecisionV1[]) {
	return [{ manifest: { device_decisions: decisions } }] as unknown as ControllerHistoryEvidence[];
}
const subject = {
	legacyHistory: { deviceId: "device-a", fingerprint: "1".repeat(64), keys: [] },
} as unknown as Snapshot;
const decision = (
	identityId: string,
	evidence?: "self" | "label",
): CoordinatorLegacyTeamCompletionDeviceDecisionV1 => ({
	device_id: "device-a",
	key_fingerprint: "1".repeat(64),
	enabled: true,
	identity_id: identityId,
	decision: "included",
	...(evidence ? { identity_evidence: evidence } : {}),
});

describe("historical owner hints", () => {
	it("suggests recorded and self-asserted owners but never another device's label", () => {
		// Arrange
		const rows = [
			...history([decision("identity-legacy")]),
			...history([decision("identity-self", "self")]),
			...history([decision("identity-guessed", "label")]),
		];
		// Act
		const hints = historicalOwnerHints(rows, subject);
		// Assert
		expect(hints).toEqual(["identity-legacy", "identity-self"]);
	});
});
