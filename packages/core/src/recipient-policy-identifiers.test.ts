import { describe, expect, it } from "vitest";
import {
	canonicalRecipientPolicyJson,
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
	legacyTeamRosterFingerprint,
} from "./recipient-policy-identifiers.js";

describe("recipient policy identifiers", () => {
	it("canonicalizes object keys while preserving array order", () => {
		expect(canonicalRecipientPolicyJson({ z: 1, a: [{ y: 2, x: 1 }] })).toBe(
			'{"a":[{"x":1,"y":2}],"z":1}',
		);
	});

	it("derives stable opaque candidate and Team identifiers", () => {
		const candidate = legacyTeamCandidateId("coordinator-private", "group-private");

		expect(candidate).toBe(legacyTeamCandidateId("coordinator-private", "group-private"));
		expect(candidate).not.toContain("coordinator-private");
		expect(candidate).not.toContain("group-private");
		expect(deterministicPolicyTeamId(candidate)).toBe(deterministicPolicyTeamId(candidate));
	});

	it("fingerprints stable roster evidence independently of ordering", () => {
		const devices = [
			{ deviceId: "b", fingerprint: "key-b", enabled: false, identityId: null },
			{ deviceId: "a", fingerprint: "key-a", enabled: true, identityId: "person-a" },
		];
		const reversed = [...devices].reverse();
		const [firstDevice, secondDevice] = devices;
		if (!firstDevice || !secondDevice) throw new Error("invalid test fixture");

		expect(legacyTeamRosterFingerprint(devices)).toBe(legacyTeamRosterFingerprint(reversed));
		expect(legacyTeamRosterFingerprint(devices)).not.toBe(
			legacyTeamRosterFingerprint([{ ...firstDevice, enabled: true }, secondDevice]),
		);
	});
});
