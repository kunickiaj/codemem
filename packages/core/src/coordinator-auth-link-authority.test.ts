import { describe, expect, it } from "vitest";
import {
	type AuthLinkAttemptAuthorityRow,
	type AuthLinkRecordAuthorityRow,
	isOperatorReviewedAuthority,
	readAuthLinkAttemptAuthority,
	readAuthLinkRecordAuthority,
} from "./coordinator-auth-link-authority.js";

const ATTESTED_ATTEMPT: AuthLinkAttemptAuthorityRow = {
	authority_kind: "controller_attestation",
	controller_attestation_id: "attestation-a",
	controller_review_receipt_id: "receipt-a",
	controller_revision: 1,
};
const CLAIM_ATTEMPT: AuthLinkAttemptAuthorityRow = {
	authority_kind: "device_claim",
	controller_attestation_id: null,
	controller_review_receipt_id: null,
	controller_revision: null,
};
const ATTESTED_RECORD: AuthLinkRecordAuthorityRow = {
	authority_kind: "controller_attestation",
	controller_attestation_id: "attestation-a",
	device_claim_id: null,
};
const CLAIM_RECORD: AuthLinkRecordAuthorityRow = {
	authority_kind: "device_claim",
	controller_attestation_id: null,
	device_claim_id: "claim-a",
};

describe("readAuthLinkAttemptAuthority", () => {
	it("reads an attested attempt with its review references", () => {
		expect(readAuthLinkAttemptAuthority(ATTESTED_ATTEMPT)).toEqual({
			kind: "controller_attestation",
			controllerAttestationId: "attestation-a",
			controllerReviewReceiptId: "receipt-a",
		});
	});

	it("reads a pending device-claim attempt without review references", () => {
		expect(readAuthLinkAttemptAuthority(CLAIM_ATTEMPT)).toEqual({ kind: "device_claim" });
	});

	it.each<[string, Partial<AuthLinkAttemptAuthorityRow>]>([
		["unknown kind", { authority_kind: "operator" }],
		["missing kind", { authority_kind: null }],
		["attested without attestation", { controller_attestation_id: null }],
		["attested with empty attestation", { controller_attestation_id: "" }],
		["attested with a control character", { controller_attestation_id: "attestation\u0000a" }],
		["attested with an oversized reference", { controller_attestation_id: "a".repeat(257) }],
		["attested with padded receipt", { controller_review_receipt_id: " receipt-a" }],
		["attested with an invalid receipt", { controller_review_receipt_id: "receipt\u0000a" }],
		["attested with another revision", { controller_revision: 2 }],
	])("rejects an attested attempt with %s", (_label, change) => {
		expect(readAuthLinkAttemptAuthority({ ...ATTESTED_ATTEMPT, ...change })).toBeNull();
	});

	it.each<[string, Partial<AuthLinkAttemptAuthorityRow>]>([
		["an attestation reference", { controller_attestation_id: "attestation-a" }],
		["an empty attestation reference", { controller_attestation_id: "" }],
		["a review receipt", { controller_review_receipt_id: "receipt-a" }],
		["a controller revision", { controller_revision: 1 }],
	])("rejects a device-claim attempt carrying %s", (_label, change) => {
		expect(readAuthLinkAttemptAuthority({ ...CLAIM_ATTEMPT, ...change })).toBeNull();
	});
});

describe("readAuthLinkRecordAuthority", () => {
	it("reads attested and device-claim records", () => {
		expect(readAuthLinkRecordAuthority(ATTESTED_RECORD)).toEqual({
			kind: "controller_attestation",
			controllerAttestationId: "attestation-a",
		});
		expect(readAuthLinkRecordAuthority(CLAIM_RECORD)).toEqual({
			kind: "device_claim",
			deviceClaimId: "claim-a",
		});
	});

	it.each<[string, AuthLinkRecordAuthorityRow]>([
		["attested record with a claim", { ...ATTESTED_RECORD, device_claim_id: "claim-a" }],
		["attested record, no attestation", { ...ATTESTED_RECORD, controller_attestation_id: null }],
		["claim record with an attestation", { ...CLAIM_RECORD, controller_attestation_id: "a" }],
		["claim record without a claim", { ...CLAIM_RECORD, device_claim_id: null }],
		["claim record with an empty claim", { ...CLAIM_RECORD, device_claim_id: "" }],
		["claim record with an invalid claim", { ...CLAIM_RECORD, device_claim_id: "claim\u0000a" }],
		["claim record with a long claim", { ...CLAIM_RECORD, device_claim_id: "a".repeat(257) }],
		["unknown kind", { ...CLAIM_RECORD, authority_kind: "admin" }],
	])("rejects %s", (_label, row) => {
		expect(readAuthLinkRecordAuthority(row)).toBeNull();
	});
});

describe("isOperatorReviewedAuthority", () => {
	it("accepts only controller attestations", () => {
		expect(isOperatorReviewedAuthority(readAuthLinkRecordAuthority(ATTESTED_RECORD))).toBe(true);
		expect(isOperatorReviewedAuthority(readAuthLinkRecordAuthority(CLAIM_RECORD))).toBe(false);
		expect(isOperatorReviewedAuthority(null)).toBe(false);
	});
});
