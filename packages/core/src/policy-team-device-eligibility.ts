import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";

export const POLICY_TEAM_DEVICE_ELIGIBILITY_MODES = [
	"person_all_devices",
	"reviewed_allowlist",
] as const;

export type PolicyTeamDeviceEligibilityMode = (typeof POLICY_TEAM_DEVICE_ELIGIBILITY_MODES)[number];

export const POLICY_TEAM_DEVICE_DECISIONS = ["included", "excluded", "unresolved"] as const;

export type PolicyTeamDeviceDecision = (typeof POLICY_TEAM_DEVICE_DECISIONS)[number];

export type PolicyTeamDeviceEligibilityBlockCode =
	| "team_device_eligibility_mode_invalid"
	| "team_device_decision_invalid"
	| "team_membership_invalid"
	| "team_membership_mode_invalid"
	| "team_member_identity_missing"
	| "team_member_identity_not_active"
	| "team_member_identity_merged"
	| "identity_device_invalid";

export interface PolicyTeamDeviceEligibilityIdentity {
	identityId: string;
	status: string;
	mergedIntoIdentityId: string | null;
}

export interface PolicyTeamDeviceEligibilityMembership {
	identityId: string;
	status: string;
}

export interface PolicyTeamDeviceEligibilityDevice {
	identityId: string;
	deviceId: string;
	status: string;
	assignmentVersion: number;
}

export interface PolicyTeamDeviceEligibilityDecision {
	deviceId: string;
	decision: string;
	assignmentVersion: number;
}

export interface DerivePolicyTeamDeviceEligibilityInput {
	teamId: string;
	mode: string;
	memberships: PolicyTeamDeviceEligibilityMembership[];
	identities: PolicyTeamDeviceEligibilityIdentity[];
	devices: PolicyTeamDeviceEligibilityDevice[];
	decisions: PolicyTeamDeviceEligibilityDecision[];
}

export interface PolicyTeamDeviceEligibilityBlock {
	code: PolicyTeamDeviceEligibilityBlockCode;
	referenceId: string;
}

export interface EligiblePolicyTeamDeviceEligibilityResult {
	status: "eligible";
	activeMemberIdentityIds: string[];
	eligibleDeviceIds: string[];
	blocked: [];
}

export interface BlockedPolicyTeamDeviceEligibilityResult {
	status: "blocked";
	blocked: [PolicyTeamDeviceEligibilityBlock, ...PolicyTeamDeviceEligibilityBlock[]];
}

export type PolicyTeamDeviceEligibilityResult =
	| EligiblePolicyTeamDeviceEligibilityResult
	| BlockedPolicyTeamDeviceEligibilityResult;

const MODES = new Set<string>(POLICY_TEAM_DEVICE_ELIGIBILITY_MODES);
const DECISIONS = new Set<string>(POLICY_TEAM_DEVICE_DECISIONS);
const DEVICE_STATUSES = new Set(["active", "revoked"]);
const INACTIVE_MEMBERSHIP_STATUSES = new Set(["pending", "revoked"]);
// Surface authority-shape and principal-integrity failures before mutable
// decision/device facts so callers expose the most security-relevant cause.
const BLOCK_PRECEDENCE: Record<PolicyTeamDeviceEligibilityBlockCode, number> = {
	team_device_eligibility_mode_invalid: 0,
	team_membership_invalid: 1,
	team_membership_mode_invalid: 2,
	team_member_identity_missing: 3,
	team_member_identity_merged: 4,
	team_member_identity_not_active: 5,
	team_device_decision_invalid: 6,
	identity_device_invalid: 7,
};

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function isPolicyTeamMembershipActiveForMode(mode: string, status: string): boolean {
	return (
		(mode === "person_all_devices" && status === "active") ||
		(mode === "reviewed_allowlist" && status === "reviewed_active")
	);
}

function sortedBlocks(
	blocked: Iterable<PolicyTeamDeviceEligibilityBlock>,
): PolicyTeamDeviceEligibilityBlock[] {
	return [...blocked].toSorted(
		(left, right) =>
			BLOCK_PRECEDENCE[left.code] - BLOCK_PRECEDENCE[right.code] ||
			compareText(left.referenceId, right.referenceId),
	);
}

function blockedResult(
	blocked: Iterable<PolicyTeamDeviceEligibilityBlock>,
): BlockedPolicyTeamDeviceEligibilityResult {
	const [first, ...rest] = sortedBlocks(blocked);
	if (!first) throw new Error("policy_team_device_eligibility_block_missing");
	return { status: "blocked", blocked: [first, ...rest] };
}

export function derivePolicyTeamDeviceEligibility(
	input: DerivePolicyTeamDeviceEligibilityInput,
): PolicyTeamDeviceEligibilityResult {
	const blocked = new Map<string, PolicyTeamDeviceEligibilityBlock>();
	const addBlock = (code: PolicyTeamDeviceEligibilityBlockCode, referenceId: string): void => {
		blocked.set(`${code}\u0000${referenceId}`, { code, referenceId });
	};
	if (!MODES.has(input.mode)) {
		return blockedResult([
			{ code: "team_device_eligibility_mode_invalid", referenceId: input.teamId },
		]);
	}
	const mode = input.mode as PolicyTeamDeviceEligibilityMode;
	const activeMembers = new Set<string>();
	for (const membership of input.memberships) {
		if (!isStrictRecipientPolicyId(membership.identityId)) {
			addBlock("team_membership_invalid", `${input.teamId}:${membership.identityId}`);
			continue;
		}
		if (isPolicyTeamMembershipActiveForMode(mode, membership.status)) {
			activeMembers.add(membership.identityId);
			continue;
		}
		if (!INACTIVE_MEMBERSHIP_STATUSES.has(membership.status)) {
			addBlock("team_membership_mode_invalid", `${input.teamId}:${membership.identityId}`);
		}
	}
	const identities = new Map(input.identities.map((identity) => [identity.identityId, identity]));
	for (const identityId of activeMembers) {
		const identity = identities.get(identityId);
		if (!identity) {
			addBlock("team_member_identity_missing", identityId);
			continue;
		}
		if (identity.status === "merged" || identity.mergedIntoIdentityId) {
			addBlock("team_member_identity_merged", identityId);
			continue;
		}
		if (identity.status !== "active") {
			addBlock("team_member_identity_not_active", identityId);
		}
	}
	const decisions = new Map<string, PolicyTeamDeviceEligibilityDecision>();
	for (const decision of input.decisions) {
		if (mode === "person_all_devices") {
			addBlock("team_device_decision_invalid", `${input.teamId}:${decision.deviceId}`);
			continue;
		}
		if (
			!isStrictRecipientPolicyId(decision.deviceId) ||
			!DECISIONS.has(decision.decision) ||
			!Number.isSafeInteger(decision.assignmentVersion) ||
			decision.assignmentVersion < 0 ||
			decisions.has(decision.deviceId)
		) {
			addBlock("team_device_decision_invalid", `${input.teamId}:${decision.deviceId}`);
			continue;
		}
		decisions.set(decision.deviceId, decision);
	}
	const eligibleDeviceIds = new Set<string>();
	for (const device of input.devices) {
		if (!activeMembers.has(device.identityId)) continue;
		if (!DEVICE_STATUSES.has(device.status)) {
			addBlock("identity_device_invalid", device.deviceId);
			continue;
		}
		if (device.status !== "active") continue;
		if (
			!isStrictRecipientPolicyId(device.identityId) ||
			!isStrictRecipientPolicyId(device.deviceId) ||
			!Number.isSafeInteger(device.assignmentVersion) ||
			device.assignmentVersion < 0
		) {
			addBlock("identity_device_invalid", device.deviceId);
			continue;
		}
		const decision = decisions.get(device.deviceId);
		if (
			mode === "person_all_devices" ||
			(decision?.decision === "included" && decision.assignmentVersion === device.assignmentVersion)
		) {
			eligibleDeviceIds.add(device.deviceId);
		}
	}
	if (blocked.size > 0) return blockedResult(blocked.values());
	return {
		status: "eligible",
		activeMemberIdentityIds: [...activeMembers].toSorted(compareText),
		eligibleDeviceIds: [...eligibleDeviceIds].toSorted(compareText),
		blocked: [],
	};
}
