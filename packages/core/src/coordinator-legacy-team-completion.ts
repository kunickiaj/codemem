import {
	LEGACY_TEAM_SETUP_MAX_DEVICES,
	LEGACY_TEAM_SETUP_MAX_PROJECTS,
} from "./legacy-team-setup-limits.js";
import {
	compareCodepoints,
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";

export const COORDINATOR_LEGACY_TEAM_COMPLETION_VERSION = 1 as const;
export const COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_GROUPS = 50;
export const COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS = 500;
export const COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES = 1_500_000;
export const COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BATCH_BYTES =
	25 * COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES;
const COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_IDENTIFIER_CHARS = 256;
const COORDINATOR_LEGACY_TEAM_COMPLETION_RECORD_ENVELOPE_BYTES = 64;
export const COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BATCH_RESPONSE_BYTES =
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BATCH_BYTES +
	(COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_IDENTIFIER_CHARS +
		COORDINATOR_LEGACY_TEAM_COMPLETION_RECORD_ENVELOPE_BYTES) *
		COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS +
	1024;
export const COORDINATOR_LEGACY_TEAM_COMPLETION_CONFLICT = "completion_conflict" as const;

export interface CoordinatorLegacyTeamCompletionMembershipV1 {
	identity_id: string;
	role: "member";
}

export interface CoordinatorLegacyTeamCompletionDeviceDecisionV1 {
	device_id: string;
	key_fingerprint: string;
	enabled: boolean;
	identity_id: string | null;
	decision: "included" | "excluded";
}

export interface CoordinatorLegacyTeamCompletionProjectMappingV1 {
	project_ref: string;
	resolved_project_ref: string;
	scope_id: string;
}

export interface CoordinatorLegacyTeamCompletionRecipientV1 {
	resolved_project_ref: string;
	team_id: string;
}

export interface CoordinatorLegacyTeamCompletionManifestV1 {
	version: typeof COORDINATOR_LEGACY_TEAM_COMPLETION_VERSION;
	coordinator_id: string;
	candidate_ref: string;
	candidate_digest: string;
	team_id: string;
	team_digest: string;
	source_digest: string;
	finish_digest: string;
	access_delta_digest: string;
	team: {
		display_name: string;
		policy_revision: string;
		device_eligibility_mode: "reviewed_allowlist";
	};
	memberships: CoordinatorLegacyTeamCompletionMembershipV1[];
	device_decisions: CoordinatorLegacyTeamCompletionDeviceDecisionV1[];
	project_mappings: CoordinatorLegacyTeamCompletionProjectMappingV1[];
	project_recipients: CoordinatorLegacyTeamCompletionRecipientV1[];
	completed_at: string;
}

export interface CoordinatorLegacyTeamCompletionWriteResult {
	status: "created" | "existing";
	manifest: CoordinatorLegacyTeamCompletionManifestV1;
}

export interface CoordinatorLegacyTeamCompletionRecord {
	group_id: string;
	manifest: CoordinatorLegacyTeamCompletionManifestV1;
}

export interface CoordinatorLegacyTeamCompletionScopeBinding {
	scope_id: string | null;
	authority_type: string | null;
	coordinator_id: string | null;
	group_id: string | null;
	status: string | null;
}

export class CoordinatorLegacyTeamCompletionConflictError extends Error {
	readonly code = COORDINATOR_LEGACY_TEAM_COMPLETION_CONFLICT;

	constructor() {
		super(COORDINATOR_LEGACY_TEAM_COMPLETION_CONFLICT);
		this.name = "CoordinatorLegacyTeamCompletionConflictError";
	}
}

function invalid(): never {
	throw new Error("completion_manifest_invalid");
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): void {
	const allowed = new Set(fields);
	if (Object.keys(value).some((field) => !allowed.has(field))) invalid();
}

function isLocalArtifactPath(value: string): boolean {
	return /^(?:[\\/]{2}|\.{1,2}[\\/]|\/|~[\\/]|[a-z]:[\\/]|file:)/iu.test(value);
}

function identifier(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value.length > COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_IDENTIFIER_CHARS ||
		/[\p{Cc}\p{Cf}]/u.test(value) ||
		isLocalArtifactPath(value)
	) {
		invalid();
	}
	return value;
}

function digest(value: unknown): string {
	const normalized = identifier(value);
	if (!/^[a-f0-9]{64}$/u.test(normalized)) invalid();
	return normalized;
}

function displayName(value: unknown): string {
	if (typeof value !== "string") invalid();
	const normalized = value.normalize("NFC").trim();
	if (
		!normalized ||
		[...normalized].length > 120 ||
		/[\p{Cc}\p{Cf}]/u.test(normalized) ||
		isLocalArtifactPath(normalized)
	) {
		invalid();
	}
	return normalized;
}

function timestamp(value: unknown): string {
	if (typeof value !== "string" || !value) invalid();
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) invalid();
	return value;
}

function array(value: unknown, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) invalid();
	return value;
}

function uniqueSorted<T>(items: T[], key: (item: T) => string): T[] {
	const sorted = items.toSorted((left, right) => compareCodepoints(key(left), key(right)));
	if (sorted.some((item, index) => index > 0 && key(sorted[index - 1] as T) === key(item)))
		invalid();
	return sorted;
}

export function normalizeCoordinatorLegacyTeamCompletionGroupIds(value: unknown): string[] {
	return uniqueSorted(
		array(value, COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_GROUPS).map(identifier),
		(item) => item,
	);
}

export function normalizeCoordinatorLegacyTeamCompletionCandidateRef(value: unknown): string {
	const normalized = identifier(value);
	if (!/^legacy-team-candidate:[a-f0-9]{32}$/u.test(normalized)) invalid();
	return normalized;
}

export function normalizeCoordinatorLegacyTeamCompletionManifest(
	value: unknown,
): CoordinatorLegacyTeamCompletionManifestV1 {
	const input = record(value);
	exactFields(input, [
		"version",
		"coordinator_id",
		"candidate_ref",
		"candidate_digest",
		"team_id",
		"team_digest",
		"source_digest",
		"finish_digest",
		"access_delta_digest",
		"team",
		"memberships",
		"device_decisions",
		"project_mappings",
		"project_recipients",
		"completed_at",
	]);
	if (input.version !== COORDINATOR_LEGACY_TEAM_COMPLETION_VERSION) invalid();
	const team = record(input.team);
	exactFields(team, ["display_name", "policy_revision", "device_eligibility_mode"]);
	if (team.device_eligibility_mode !== "reviewed_allowlist") invalid();
	const teamId = identifier(input.team_id);
	const memberships = uniqueSorted(
		array(input.memberships, LEGACY_TEAM_SETUP_MAX_DEVICES).map((value) => {
			const item = record(value);
			exactFields(item, ["identity_id", "role"]);
			if (item.role !== "member") invalid();
			return { identity_id: identifier(item.identity_id), role: "member" as const };
		}),
		(item) => item.identity_id,
	);
	const deviceDecisions = uniqueSorted(
		array(input.device_decisions, LEGACY_TEAM_SETUP_MAX_DEVICES).map((value) => {
			const item = record(value);
			exactFields(item, ["device_id", "key_fingerprint", "enabled", "identity_id", "decision"]);
			if (item.decision !== "included" && item.decision !== "excluded") invalid();
			if (typeof item.enabled !== "boolean") invalid();
			const identityId = item.identity_id == null ? null : identifier(item.identity_id);
			if ((item.decision === "included") !== Boolean(identityId)) invalid();
			if (item.decision === "included" && !item.enabled) invalid();
			const decision: CoordinatorLegacyTeamCompletionDeviceDecisionV1["decision"] = item.decision;
			return {
				device_id: identifier(item.device_id),
				key_fingerprint: digest(item.key_fingerprint),
				enabled: item.enabled,
				identity_id: identityId,
				decision,
			};
		}),
		(item) => item.device_id,
	);
	if (deviceDecisions.length === 0) invalid();
	const membershipIds = new Set(memberships.map((membership) => membership.identity_id));
	const includedIdentityIds = new Set(
		deviceDecisions.flatMap((decision) => (decision.identity_id ? [decision.identity_id] : [])),
	);
	if (
		membershipIds.size !== includedIdentityIds.size ||
		[...includedIdentityIds].some((identityId) => !membershipIds.has(identityId))
	) {
		invalid();
	}
	const projectMappings = uniqueSorted(
		array(input.project_mappings, LEGACY_TEAM_SETUP_MAX_PROJECTS).map((value) => {
			const item = record(value);
			exactFields(item, ["project_ref", "resolved_project_ref", "scope_id"]);
			const projectRef = identifier(item.project_ref);
			const resolvedProjectRef = identifier(item.resolved_project_ref);
			if (!/^legacy-team-project-ref-v1:[0-9a-f]{64}$/u.test(projectRef)) invalid();
			if (!/^legacy-team-resolved-project-ref-v1:[0-9a-f]{64}$/u.test(resolvedProjectRef)) {
				invalid();
			}
			return {
				project_ref: projectRef,
				resolved_project_ref: resolvedProjectRef,
				scope_id: identifier(item.scope_id),
			};
		}),
		(item) => item.project_ref,
	);
	const resolvedScopes = new Map<string, string>();
	for (const mapping of projectMappings) {
		const priorScopeId = resolvedScopes.get(mapping.resolved_project_ref);
		if (priorScopeId && priorScopeId !== mapping.scope_id) invalid();
		resolvedScopes.set(mapping.resolved_project_ref, mapping.scope_id);
	}
	const projectRecipients = uniqueSorted(
		array(input.project_recipients, LEGACY_TEAM_SETUP_MAX_PROJECTS).map((value) => {
			const item = record(value);
			exactFields(item, ["resolved_project_ref", "team_id"]);
			const recipientTeamId = identifier(item.team_id);
			if (recipientTeamId !== teamId) invalid();
			const resolvedProjectRef = identifier(item.resolved_project_ref);
			if (!/^legacy-team-resolved-project-ref-v1:[0-9a-f]{64}$/u.test(resolvedProjectRef)) {
				invalid();
			}
			return {
				resolved_project_ref: resolvedProjectRef,
				team_id: recipientTeamId,
			};
		}),
		(item) => item.resolved_project_ref,
	);
	const mappedRecipientRefs = [
		...new Set(projectMappings.map((mapping) => mapping.resolved_project_ref)),
	].toSorted(compareCodepoints);
	const recipientRefs = projectRecipients.map((recipient) => recipient.resolved_project_ref);
	if (JSON.stringify(recipientRefs) !== JSON.stringify(mappedRecipientRefs)) {
		invalid();
	}
	const manifest: CoordinatorLegacyTeamCompletionManifestV1 = {
		version: COORDINATOR_LEGACY_TEAM_COMPLETION_VERSION,
		coordinator_id: identifier(input.coordinator_id),
		candidate_ref: normalizeCoordinatorLegacyTeamCompletionCandidateRef(input.candidate_ref),
		candidate_digest: digest(input.candidate_digest),
		team_id: teamId,
		team_digest: digest(input.team_digest),
		source_digest: digest(input.source_digest),
		finish_digest: digest(input.finish_digest),
		access_delta_digest: digest(input.access_delta_digest),
		team: {
			display_name: displayName(team.display_name),
			policy_revision: digest(team.policy_revision),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships,
		device_decisions: deviceDecisions,
		project_mappings: projectMappings,
		project_recipients: projectRecipients,
		completed_at: timestamp(input.completed_at),
	};
	if (
		new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
		COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES
	) {
		invalid();
	}
	return manifest;
}

export function canonicalCoordinatorLegacyTeamCompletionManifestJson(value: unknown): string {
	return JSON.stringify(normalizeCoordinatorLegacyTeamCompletionManifest(value));
}

export function requireCoordinatorLegacyTeamCompletionTeamBinding(
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
): void {
	if (manifest.team_id !== deterministicPolicyTeamId(manifest.candidate_ref)) invalid();
}

export function requireCoordinatorLegacyTeamCompletionCandidateBinding(
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
	groupId: string,
): void {
	if (legacyTeamCandidateId(manifest.coordinator_id, groupId) !== manifest.candidate_ref) invalid();
}

export function requireCoordinatorLegacyTeamCompletionScopeBindings(
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
	groupId: string,
	bindings: CoordinatorLegacyTeamCompletionScopeBinding[],
): string | null {
	requireCoordinatorLegacyTeamCompletionCandidateBinding(manifest, groupId);
	const requestedScopeIds = new Set(manifest.project_mappings.map((mapping) => mapping.scope_id));
	if (bindings.length !== requestedScopeIds.size) invalid();
	const coordinatorId = manifest.coordinator_id;
	for (const binding of bindings) {
		if (
			!binding.scope_id ||
			!requestedScopeIds.has(binding.scope_id) ||
			binding.authority_type !== "coordinator" ||
			!binding.coordinator_id ||
			binding.group_id !== groupId ||
			binding.status !== "active" ||
			binding.coordinator_id !== coordinatorId
		) {
			invalid();
		}
	}
	return coordinatorId;
}
