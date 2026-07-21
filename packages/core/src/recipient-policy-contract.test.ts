import { describe, expect, expectTypeOf, it } from "vitest";
import {
	RECIPIENT_POLICY_CONTRACT_VERSION,
	type RecipientPolicyIdentityDeviceV1,
	type RecipientPolicyIdentityV1,
	type RecipientPolicyProjectionV1,
	type RecipientPolicyProjectRecipientV1,
	type RecipientPolicyProjectV1,
	type RecipientPolicyReviewDecisionV1,
	type RecipientPolicyReviewItemV1,
	type RecipientPolicyTeamMembershipV1,
	type RecipientPolicyTeamV1,
} from "./recipient-policy-contract.js";
import type { RecipientPolicyIntentGraphV1 } from "./recipient-policy-intent.js";

const PERSONAL_IDENTITY = {
	version: RECIPIENT_POLICY_CONTRACT_VERSION,
	identityId: "identity-personal",
	displayName: "Personal",
	kind: "personal",
	verification: "local",
	status: "active",
	mergedIntoIdentityId: null,
} as const satisfies RecipientPolicyIdentityV1;

const WORK_IDENTITY = {
	...PERSONAL_IDENTITY,
	identityId: "identity-work",
	displayName: "Work",
	kind: "work",
} as const satisfies RecipientPolicyIdentityV1;

const TEAM = {
	version: RECIPIENT_POLICY_CONTRACT_VERSION,
	teamId: "team-oss",
	displayName: "Open Source Team",
	status: "active",
} as const satisfies RecipientPolicyTeamV1;

const TEAM_MEMBERSHIP = {
	version: RECIPIENT_POLICY_CONTRACT_VERSION,
	teamId: TEAM.teamId,
	identityId: PERSONAL_IDENTITY.identityId,
	role: "admin",
	status: "active",
} as const satisfies RecipientPolicyTeamMembershipV1;

const IDENTITY_DEVICES = [
	{
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		identityId: PERSONAL_IDENTITY.identityId,
		deviceId: "device-home",
		displayName: "Home laptop",
		status: "active",
	},
	{
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		identityId: WORK_IDENTITY.identityId,
		deviceId: "device-work",
		displayName: "Work laptop",
		status: "active",
	},
] as const satisfies readonly RecipientPolicyIdentityDeviceV1[];

const PROJECT_RECIPIENTS = [
	{
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		canonicalProjectIdentity: "git:https://example.invalid/example-oss.git",
		recipientKind: "identity",
		identityId: WORK_IDENTITY.identityId,
		intentSource: "user",
		policyRevision: "revision-1",
		status: "active",
	},
	{
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		canonicalProjectIdentity: "git:https://example.invalid/example-oss.git",
		recipientKind: "team",
		teamId: TEAM.teamId,
		intentSource: "user",
		policyRevision: "revision-1",
		status: "active",
	},
] as const satisfies readonly RecipientPolicyProjectRecipientV1[];

const SAME_NAME_PROJECTS = [
	{
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		canonicalIdentity: "git:https://example.invalid/one/example.git",
		displayName: "example",
	},
	{
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		canonicalIdentity: "git:https://example.invalid/two/example.git",
		displayName: "example",
	},
] as const satisfies readonly RecipientPolicyProjectV1[];

const KEEP_CURRENT_REVIEW = {
	version: RECIPIENT_POLICY_CONTRACT_VERSION,
	reviewItemId: "review-1",
	sourceFingerprint: "fingerprint-1",
	finding: "Existing access cannot be mapped unambiguously.",
	reason: "The legacy Space contains several Projects and device audiences.",
	recommendedDecision: "keep_current_setup",
	options: [
		{
			decision: "keep_current_setup",
			label: "Keep current setup unchanged",
			effect: "none",
			affectedProjectCount: 1,
			affectedMemoryCount: 0,
			affectedDeviceCount: 0,
		},
	],
	state: "open",
	resolution: null,
} as const satisfies RecipientPolicyReviewItemV1;

describe("recipient policy V1 contract", () => {
	it("uses a fixed contract version", () => {
		expect(RECIPIENT_POLICY_CONTRACT_VERSION).toBe(1);
	});

	it("keeps Personal and Work as distinct Identities", () => {
		expect(PERSONAL_IDENTITY.identityId).not.toBe(WORK_IDENTITY.identityId);
		expectTypeOf(PERSONAL_IDENTITY).toMatchTypeOf<RecipientPolicyIdentityV1>();
		expectTypeOf(WORK_IDENTITY).toMatchTypeOf<RecipientPolicyIdentityV1>();
	});

	it("maps each device edge to exactly one Identity", () => {
		const identitiesByDevice = new Map(
			IDENTITY_DEVICES.map((item) => [item.deviceId, item.identityId]),
		);
		expect(identitiesByDevice).toEqual(
			new Map([
				["device-home", "identity-personal"],
				["device-work", "identity-work"],
			]),
		);
	});

	it("uses canonical Project identity instead of display name", () => {
		expect(new Set(SAME_NAME_PROJECTS.map((project) => project.canonicalIdentity)).size).toBe(2);
		expect(new Set(SAME_NAME_PROJECTS.map((project) => project.displayName)).size).toBe(1);
	});

	it("keeps Team membership Identity-based", () => {
		expect(TEAM_MEMBERSHIP).toMatchObject({
			teamId: TEAM.teamId,
			identityId: PERSONAL_IDENTITY.identityId,
		});
		expect(TEAM_MEMBERSHIP).not.toHaveProperty("deviceId");
	});

	it("distinguishes direct Identity and Team recipients", () => {
		expect(PROJECT_RECIPIENTS.map((item) => item.recipientKind)).toEqual(["identity", "team"]);
	});

	it("keeps authorization shortcuts out of recipient intent", () => {
		type ForbiddenIntentKey = Extract<
			keyof RecipientPolicyProjectRecipientV1,
			"scopeId" | "deviceId" | "trusted" | "projectFilters"
		>;
		expectTypeOf<ForbiddenIntentKey>().toEqualTypeOf<never>();
		type ForbiddenGraphKey = Extract<
			keyof RecipientPolicyIntentGraphV1,
			| "scopes"
			| "groupIds"
			| "addresses"
			| "keys"
			| "fingerprints"
			| "epochs"
			| "cursors"
			| "filters"
			| "payloads"
		>;
		expectTypeOf<ForbiddenGraphKey>().toEqualTypeOf<never>();
	});

	it("makes keeping current setup an actionable outcome", () => {
		expect(KEEP_CURRENT_REVIEW.recommendedDecision).toBe("keep_current_setup");
		expect(KEEP_CURRENT_REVIEW.options).toContainEqual(
			expect.objectContaining({ decision: "keep_current_setup", effect: "none" }),
		);
	});

	it("keeps rejection and access-preserving migration as explicit decisions", () => {
		type ExplicitDecision = Extract<
			RecipientPolicyReviewDecisionV1,
			"reject_suggestion" | "preserve_current_access"
		>;
		expectTypeOf<ExplicitDecision>().toEqualTypeOf<
			"reject_suggestion" | "preserve_current_access"
		>();
	});

	it("separates intent, effective devices, and enforcement in projections", () => {
		const projection = {
			version: RECIPIENT_POLICY_CONTRACT_VERSION,
			project: {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				canonicalIdentity: PROJECT_RECIPIENTS[0].canonicalProjectIdentity,
				displayName: "example-oss",
			},
			intent: [...PROJECT_RECIPIENTS],
			effectiveDevices: [
				{
					version: RECIPIENT_POLICY_CONTRACT_VERSION,
					canonicalProjectIdentity: PROJECT_RECIPIENTS[0].canonicalProjectIdentity,
					identityId: WORK_IDENTITY.identityId,
					deviceId: "device-work",
					via: "direct_identity",
				},
			],
			enforcement: {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				canonicalProjectIdentity: PROJECT_RECIPIENTS[0].canonicalProjectIdentity,
				authority: "legacy_scope",
				parity: "unknown",
				cutoverState: "legacy",
				managedScopeId: null,
				desiredDeviceIds: ["device-work"],
				currentDeviceIds: [],
				safeErrorCode: null,
			},
			reviewItems: [KEEP_CURRENT_REVIEW],
			blockedItems: [],
		} satisfies RecipientPolicyProjectionV1;

		expect(projection.intent).toHaveLength(2);
		expect(projection.effectiveDevices).toHaveLength(1);
		expect(projection.enforcement.authority).toBe("legacy_scope");
	});
});
