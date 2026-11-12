import { describe, expect, it } from "vitest";
import {
	decideDeviceSelfBind,
	type SelfBindFacts,
	type SelfBindSubject,
} from "./coordinator-device-self-bind-decision.js";

const subject: SelfBindSubject = {
	coordinatorId: "c",
	identityId: "identity",
	groupId: "g1",
	deviceId: "d1",
	publicKey: "key",
	fingerprint: "fp",
	keyId: "key-id",
	issuer: "issuer",
	nowMs: 1,
	attemptId: null,
	aliases: ["key"],
};

function eligibleFacts(): SelfBindFacts {
	const enrollment = { device_id: "d1", public_key: "key", fingerprint: "fp", created_at: "at" };
	return {
		enrollments: [
			{ ...enrollment, group_id: "g1", identity_id: null, enabled: 1, group_live: 1 },
			{ ...enrollment, group_id: "g2", identity_id: "identity", enabled: 0, group_live: null },
		],
		attestations: [
			{
				coordinator_id: "c",
				attestation_id: "a1",
				identity_id: "identity",
				group_id: "g1",
				device_id: "d1",
				public_key: "key",
				fingerprint: "fp",
				review_receipt_id: "r1",
				evidence_digest: "e",
				enrollment_identity_id: null,
				revision: 1,
				created_at: "at",
				revoked_at: null,
			},
		],
		links: [
			{
				link: [
					"c",
					"l1",
					"identity",
					"issuer",
					"subject",
					"device_claim",
					null,
					"claim",
					"t",
					"rev",
					5,
				],
				issuer: "issuer",
				proven: 1,
				controller_receipt: 1,
				headless: 0,
				linkController: [],
				linkClaim: [["claim", "identity"]],
			},
		],
		inviteConflicts: [],
		bindingConflicts: [],
		claimConflicts: [],
		revocationConflicts: [],
		otherIdentityLinkAttemptConflicts: [],
		otherIdentityLinkAuditConflicts: [],
		ownerAttemptConflicts: [],
		linkAttemptConflicts: [],
		rebindAttemptConflicts: [],
		legacyDecisionConflicts: [],
	};
}

describe("self-bind decision", () => {
	it("uses the signed group's review when all group reviews agree on the same device owner", () => {
		const facts = eligibleFacts();
		const review = facts.attestations[0];
		if (!review) throw new Error("missing review fixture");
		const single = decideDeviceSelfBind(subject, facts);
		facts.attestations.unshift({ ...review, attestation_id: "a2", group_id: "g2" });
		const multiple = decideDeviceSelfBind(subject, facts);
		expect(multiple).not.toBeNull();
		expect(JSON.parse(multiple as string).controller).toEqual(
			JSON.parse(single as string).controller,
		);
		expect(JSON.parse(multiple as string).controllers).toHaveLength(2);
	});

	it.each([
		{ identity_id: "another-owner" },
		{ device_id: "another-device" },
		{ public_key: "another-key" },
		{ fingerprint: "another-fingerprint" },
		{ revoked_at: "revoked" },
		{ group_id: "unrelated-group" },
		{ group_id: "g1" },
	])("refuses an incompatible additional review: %j", (change) => {
		const facts = eligibleFacts();
		const review = facts.attestations[0];
		if (!review) throw new Error("missing review fixture");
		facts.attestations.push({ ...review, attestation_id: "a2", group_id: "g2", ...change });
		expect(decideDeviceSelfBind(subject, facts)).toBeNull();
	});

	it("pins the review, the link and the device's enrollments in the stored JSON shape", () => {
		// Arrange
		const facts = eligibleFacts();
		// Act
		const pin = decideDeviceSelfBind(subject, facts);
		// Assert
		expect(pin).toBe(
			'{"groupId":"g1","keyId":"key-id","controller":["c","a1","identity","g1","d1","key","fp","r1","e",null,1,"at"],' +
				'"link":["c","l1","identity","issuer","subject","device_claim",null,"claim","t","rev",5],' +
				'"linkController":[],"linkClaim":[["claim","identity"]],' +
				'"enrollments":[["g1","key","fp",null,1,"at"],["g2","key","fp","identity",0,"at"]]}',
		);
	});

	// Stored state cannot produce these facts when the decision runs, so the comparison
	// with the original SQL does not reach them.
	const refusals: [string, (facts: SelfBindFacts) => void][] = [
		["a proof verdict is NULL", (f) => Object.assign(f.links[0] as object, { proven: null })],
		[
			"the receipt verdict is NULL",
			(f) => Object.assign(f.links[0] as object, { controller_receipt: null }),
		],
		["the link has no issuer", (f) => Object.assign(f.links[0] as object, { issuer: null })],
		["a conflict list has a row", (f) => f.rebindAttemptConflicts.push({ attempt_id: "other" })],
	];
	it.each(refusals)("refuses when %s", (_name, change) => {
		// Arrange
		const facts = eligibleFacts();
		change(facts);
		// Act
		const pin = decideDeviceSelfBind(subject, facts);
		// Assert
		expect(pin).toBeNull();
	});
});
