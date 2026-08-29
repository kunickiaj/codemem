import type { Database } from "./db.js";
import {
	isLegacyUmbrellaScopeKind,
	type LegacyRecipientPolicyConditionCodeV1,
	type LegacyRecipientPolicyConditionV1,
	type LegacyRecipientPolicyProjectionV1,
	listLegacyRecipientPolicyProjections,
	resolveLegacyRecipientPolicyLocalIdentity,
	selectedExplicitProjectResolution,
} from "./legacy-recipient-policy-projection.js";
import {
	isLegacyTeamCandidateSelectable,
	legacyTeamCandidateProjectInventory,
} from "./legacy-team-candidate.js";
import { isLegacyTeamSetupProjectMappingIdentity } from "./legacy-team-setup-draft.js";
import { listProjectScopeCandidates } from "./project-scope-settings.js";
import { isActiveUnmergedLocalActor } from "./recipient-policy-actor-eligibility.js";
import {
	isRecipientPolicyNoOpDecision,
	RECIPIENT_POLICY_CONTRACT_VERSION,
	type RecipientPolicyBlockedItemV1,
	type RecipientPolicyContractVersion,
	type RecipientPolicyReviewDecisionV1,
	type RecipientPolicyReviewItemV1,
	type RecipientPolicyReviewOptionV1,
	type RecipientPolicyReviewPreviewV1,
} from "./recipient-policy-contract.js";
import {
	canonicalRecipientPolicyJson,
	compareCodepoints,
	deterministicPolicyTeamId,
	legacyRecipientPolicyDigest,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import { canonicalWorkspaceIdentity, LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";

export interface RecipientPolicyReviewContext {
	localActorId: string;
	localDeviceId: string;
	now?: () => string;
}

export type RecipientPolicyReviewActionOptionV1 = RecipientPolicyReviewOptionV1 & {
	preview: RecipientPolicyReviewPreviewV1;
};

export type RecipientPolicyActionableReviewItemV1 = Omit<RecipientPolicyReviewItemV1, "options"> & {
	options: RecipientPolicyReviewActionOptionV1[];
};

export interface RecipientPolicyReviewContinuityV1 {
	state: "legacy_access_preserved";
	findingCount: number;
}

// Patch-level additive wire hint: existing v1 clients ignore the new field,
// while current clients require it so absence cannot silently change UX mode.
export interface RecipientPolicyReviewListV1 {
	version: RecipientPolicyContractVersion;
	reviewItems: RecipientPolicyActionableReviewItemV1[];
	blockedItems: RecipientPolicyBlockedItemV1[];
	staleNoContent: {
		reason: "stale_no_content";
		count: number;
		/**
		 * How many of `count` own stored legacy sharing rows that cleanup can
		 * actually delete. `unmapped:` identities are derived from sessions and
		 * usually own none, so an action labelled from `count` would promise a
		 * removal it cannot perform.
		 */
		removableCount: number;
		labels: string[];
		sourceFingerprint: string;
	} | null;
	continuity: RecipientPolicyReviewContinuityV1 | null;
}

export interface RecipientPolicyReviewResolveRequestV1 {
	reviewItemId: string;
	sourceFingerprint: string;
	decision: RecipientPolicyReviewDecisionV1;
	decisionInput?: unknown;
}

export type RecipientPolicyReviewResolveStatusV1 =
	| "applied"
	| "stale"
	| "not_found"
	| "invalid"
	| "conflict";

export interface RecipientPolicyReviewResolveResultV1 {
	reviewItemId: string;
	sourceFingerprint: string;
	status: RecipientPolicyReviewResolveStatusV1;
	errorCode: string | null;
	idempotent: boolean;
}

export interface RecipientPolicyReviewBulkResultV1 {
	version: RecipientPolicyContractVersion;
	results: RecipientPolicyReviewResolveResultV1[];
}

export interface RecipientPolicyProjectIdentityRepairRequestV1 {
	blockedItemId: string;
	sourceIdentityRef: string;
	sourceFingerprint: string;
	projectRef: string;
	spaceRef?: string;
}

export type RecipientPolicyProjectIdentityRepairStatusV1 =
	| "applied"
	| "stale"
	| "not_found"
	| "invalid"
	| "conflict";

export interface RecipientPolicyProjectIdentityRepairResultV1 {
	blockedItemId: string;
	sourceFingerprint: string;
	status: RecipientPolicyProjectIdentityRepairStatusV1;
	errorCode: string | null;
	idempotent: boolean;
}

export interface RecipientPolicyStaleSourcePruneRequestV1 {
	sourceFingerprint: string;
}

export type RecipientPolicyStaleSourcePruneStatusV1 = "applied" | "stale" | "invalid" | "conflict";

export type RecipientPolicyStaleSourcePruneSkipReasonV1 =
	| "live_memories"
	| "live_scope_evidence"
	| "project_mapping"
	| "protected_identity"
	| "no_longer_stale_no_content"
	| "legacy_rows_missing";

export interface RecipientPolicyStaleSourcePruneResultV1 {
	status: RecipientPolicyStaleSourcePruneStatusV1;
	sourceFingerprint: string;
	errorCode: string | null;
	removedCount: number;
	skippedCount: number;
	removed: Array<{ label: string }>;
	skipped: Array<{ label: string; reason: RecipientPolicyStaleSourcePruneSkipReasonV1 }>;
}

export interface RecipientPolicyDerivedReviewState {
	allReviewItems: RecipientPolicyActionableReviewItemV1[];
	blockedItems: RecipientPolicyBlockedItemV1[];
	staleNoContentItems: Array<{
		blockedItemId: string;
		canonicalProjectIdentity: string;
		displayName: string;
	}>;
	preservedDiagnosticFindings: Array<{
		canonicalProjectIdentity: string;
		conditionCode: LegacyRecipientPolicyConditionCodeV1;
	}>;
}

interface StoredResolution {
	decision: string;
	decision_input_json: string;
}

interface StoredResolutionRow extends StoredResolution {
	review_item_id: string;
	source_fingerprint: string;
}

const DECISIONS = new Set<RecipientPolicyReviewDecisionV1>([
	"apply_recommendation",
	"choose_recipients",
	"preserve_current_access",
	"reject_suggestion",
	"keep_current_setup",
	"keep_project_local",
	"keep_identities_separate",
	"attach_device_to_identity",
	"create_identity",
	"remove_stale_device",
]);

type RecipientPolicyConditionPresentation =
	| "actionable"
	| "repairable_blocked"
	| "preserved_continuity";

const CONDITION_PRESENTATION = {
	suggest_local_identity: "actionable",
	suggest_team_candidate: "actionable",
	unassigned_effective_device: "actionable",
	ambiguous_multi_project_scope: "repairable_blocked",
	wildcard_scope_mapping: "preserved_continuity",
	noncanonical_project_identity: "repairable_blocked",
	ambiguous_scope_mapping: "repairable_blocked",
	inactive_scope_boundary: "repairable_blocked",
} as const satisfies Record<
	LegacyRecipientPolicyConditionCodeV1,
	RecipientPolicyConditionPresentation
>;

function conditionPresentation(
	condition: LegacyRecipientPolicyConditionV1,
): RecipientPolicyConditionPresentation {
	if (
		condition.code === "ambiguous_multi_project_scope" &&
		condition.scopeKinds != null &&
		condition.scopeKinds.length > 0 &&
		condition.scopeKinds.every(isLegacyUmbrellaScopeKind)
	) {
		return "preserved_continuity";
	}
	return CONDITION_PRESENTATION[condition.code];
}

const canonicalJson = canonicalRecipientPolicyJson;
const digest = legacyRecipientPolicyDigest;

function semanticProjection(
	projection: LegacyRecipientPolicyProjectionV1,
	conditionCode: LegacyRecipientPolicyConditionCodeV1,
): Record<string, unknown> {
	return {
		canonicalProjectIdentity: projection.project.canonicalIdentity,
		conditionCode,
		identityCandidates: projection.identityCandidates
			.map((candidate) => ({
				identityId: candidate.identityId,
				status: candidate.status,
				mergedIntoIdentityId: candidate.mergedIntoIdentityId,
				isLocal: candidate.isLocal,
				suggestedKind: candidate.suggestedKind,
				confidence: candidate.confidence,
				provenance: candidate.provenance.toSorted(),
			}))
			.toSorted((left, right) => compareCodepoints(left.identityId, right.identityId)),
		teamCandidates: projection.teamCandidates
			.map((candidate) => ({
				teamCandidateId: candidate.teamCandidateId,
				confidence: candidate.confidence,
				provenance: candidate.provenance.toSorted(),
			}))
			.toSorted((left, right) => compareCodepoints(left.teamCandidateId, right.teamCandidateId)),
		effectiveDevices: projection.effectiveDevices
			.map((device) => ({
				deviceId: device.deviceId,
				identityId: device.identityId,
				assignment: device.assignment,
				access: device.access,
				provenance: device.provenance,
			}))
			.toSorted((left, right) => compareCodepoints(left.deviceId, right.deviceId)),
		enforcement: {
			authority: projection.enforcement.authority,
			parity: projection.enforcement.parity,
			cutoverState: projection.enforcement.cutoverState,
			state: projection.enforcement.state,
			currentDeviceIds: projection.enforcement.currentDeviceIds.toSorted(),
			safeErrorCode: projection.enforcement.safeErrorCode,
		},
	};
}

export function recipientPolicyReviewSourceFingerprint(
	projection: LegacyRecipientPolicyProjectionV1,
	conditionCode: LegacyRecipientPolicyConditionCodeV1,
): string {
	return digest("recipient-policy-source-v1", semanticProjection(projection, conditionCode));
}

function memoryCountsByProject(db: Database): Map<string, number> {
	const rows = db
		.prepare(
			`SELECT s.cwd, s.project, s.git_remote, s.git_branch, mi.workspace_id
			 FROM memory_items mi
			 JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.active = 1 AND mi.deleted_at IS NULL`,
		)
		.all() as Array<{
		cwd: string | null;
		project: string | null;
		git_remote: string | null;
		git_branch: string | null;
		workspace_id: string | null;
	}>;
	const counts = new Map<string, number>();
	for (const row of rows) {
		const projectId = canonicalLiveMemoryIdentity(db, row);
		counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
	}
	return counts;
}

function preview(
	projection: LegacyRecipientPolicyProjectionV1,
	memoryCount: number,
	effect: RecipientPolicyReviewOptionV1["effect"],
	requiresDecisionInput: boolean,
): RecipientPolicyReviewPreviewV1 {
	return {
		projects: [
			{
				canonicalIdentity: projection.project.canonicalIdentity,
				displayName: projection.project.displayName,
			},
		],
		effectiveDevices: projection.effectiveDevices.map((device) => ({
			deviceId: device.deviceId,
			displayName: device.displayName,
			identityId: device.identityId,
			assignment: device.assignment,
		})),
		affectedProjectCount: 1,
		affectedMemoryCount: memoryCount,
		affectedDeviceCount: projection.effectiveDevices.length,
		effect,
		requiresDecisionInput,
	};
}

function option(
	projection: LegacyRecipientPolicyProjectionV1,
	memoryCount: number,
	decision: RecipientPolicyReviewDecisionV1,
	label: string,
	requiresDecisionInput = false,
): RecipientPolicyReviewActionOptionV1 {
	const effect = isRecipientPolicyNoOpDecision(decision) ? "none" : "metadata_only";
	const exactPreview = preview(projection, memoryCount, effect, requiresDecisionInput);
	return {
		decision,
		label,
		effect,
		affectedProjectCount: exactPreview.affectedProjectCount,
		affectedMemoryCount: exactPreview.affectedMemoryCount,
		affectedDeviceCount: exactPreview.affectedDeviceCount,
		preview: exactPreview,
	};
}

function reviewOptions(
	projection: LegacyRecipientPolicyProjectionV1,
	condition: LegacyRecipientPolicyConditionV1,
	memoryCount: number,
): {
	recommendedDecision: RecipientPolicyReviewDecisionV1;
	options: RecipientPolicyReviewActionOptionV1[];
} {
	const keep = option(
		projection,
		memoryCount,
		"keep_current_setup",
		"Keep current setup unchanged",
	);
	if (condition.code === "suggest_local_identity") {
		return {
			recommendedDecision: "apply_recommendation",
			options: [
				option(projection, memoryCount, "apply_recommendation", "Use the local Identity"),
				option(projection, memoryCount, "choose_recipients", "Choose recipients", true),
				option(projection, memoryCount, "keep_project_local", "Keep Project local"),
				option(projection, memoryCount, "reject_suggestion", "Reject suggestion"),
				keep,
			],
		};
	}
	if (condition.code === "suggest_team_candidate") {
		return {
			recommendedDecision: "reject_suggestion",
			options: [
				option(projection, memoryCount, "choose_recipients", "Choose recipients", true),
				option(
					projection,
					memoryCount,
					"reject_suggestion",
					"Reject non-authoritative Team suggestion",
				),
				keep,
			],
		};
	}
	return {
		recommendedDecision: "preserve_current_access",
		options: [
			option(projection, memoryCount, "preserve_current_access", "Preserve current access exactly"),
			option(projection, memoryCount, "keep_identities_separate", "Keep Identities separate"),
			option(projection, memoryCount, "choose_recipients", "Choose recipients", true),
			option(
				projection,
				memoryCount,
				"attach_device_to_identity",
				"Attach device to Identity",
				true,
			),
			option(projection, memoryCount, "create_identity", "Create an Identity", true),
			option(projection, memoryCount, "remove_stale_device", "Record stale device removal", true),
			keep,
		],
	};
}

function blockedOwner(code: LegacyRecipientPolicyConditionCodeV1): {
	ownerLabel: string;
	repairAction: string;
} {
	switch (code) {
		case "noncanonical_project_identity":
			return {
				ownerLabel: "Project owner",
				repairAction: "Assign a stable canonical Project identity.",
			};
		case "inactive_scope_boundary":
			return {
				ownerLabel: "Scope owner",
				repairAction: "Restore or replace the inactive enforcement boundary.",
			};
		case "ambiguous_multi_project_scope":
			return {
				ownerLabel: "Local administrator",
				repairAction:
					"Assign each Project to its own managed scope and move its memories out of the shared boundary.",
			};
		case "ambiguous_scope_mapping":
			return {
				ownerLabel: "Local administrator",
				repairAction: "Repair the ambiguous legacy Project-to-scope mapping in Advanced settings.",
			};
		case "suggest_local_identity":
		case "suggest_team_candidate":
		case "unassigned_effective_device":
		case "wildcard_scope_mapping":
			throw new Error(`Condition ${code} is not repairable.`);
	}
}

const SAFE_PROJECT_CHOICE_LABEL_PATTERN = /^[\p{L}\p{N} '&,.()_-]*$/u;
const MAX_PROJECT_IDENTITY_REPAIR_CHOICES = 500;

function normalizedChoiceLabel(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/\p{Cf}/gu, "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function safeProjectChoiceLabel(
	value: string,
	forbiddenIdentities: readonly string[],
	projectRef: string,
): string {
	const normalized = normalizedChoiceLabel(value.slice(0, 512));
	const label = normalized.slice(0, 120).trim();
	const comparable = normalized.toLowerCase();
	const unsafe =
		!label ||
		!SAFE_PROJECT_CHOICE_LABEL_PATTERN.test(label) ||
		/[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(label) ||
		/-----|\b(?:ssh|ecdsa|sk)-[\p{L}\p{N}-]+ /iu.test(label) ||
		forbiddenIdentities.some((identity) =>
			comparable.includes(normalizedChoiceLabel(identity).toLowerCase()),
		);
	return unsafe ? `Project ${projectRef.slice(-6)}` : label;
}

function safeSpaceChoiceLabel(value: string): string {
	const normalized = normalizedChoiceLabel(value.slice(0, 512));
	const label = normalized.slice(0, 120).trim();
	return label && SAFE_PROJECT_CHOICE_LABEL_PATTERN.test(label) && !/[/\\]/u.test(label)
		? label
		: "Space (name hidden)";
}

function staleProjectDisplayName(value: string): string {
	const normalized = normalizedChoiceLabel(value.slice(0, 512));
	const label = normalized.slice(0, 120).trim();
	// `shared:default` is the synthetic compatibility bucket, not a Project and
	// not a local path. Its `:` fails the path-safe label pattern, so without
	// this case the review would tell the user their default bucket is a hidden
	// local folder.
	if (label === "shared:default") return "Shared (default)";
	if (
		label &&
		SAFE_PROJECT_CHOICE_LABEL_PATTERN.test(label) &&
		!/[\\/]/u.test(label) &&
		!/^(?:[~.$%]|[A-Za-z]:)/u.test(label)
	) {
		return label;
	}
	return "Local folder (path hidden)";
}

function disambiguateProjectChoiceLabels<T extends { displayName: string; projectRef: string }>(
	choices: readonly T[],
): T[] {
	const counts = new Map<string, number>();
	const originalLabels = new Set<string>();
	for (const choice of choices) {
		const key = normalizedChoiceLabel(choice.displayName).toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
		originalLabels.add(key);
	}
	const used = new Set<string>();
	return choices.map((choice, index) => {
		const key = normalizedChoiceLabel(choice.displayName).toLowerCase();
		if ((counts.get(key) ?? 0) === 1 && !used.has(key)) {
			used.add(key);
			return choice;
		}
		for (let suffixLength = 6; suffixLength <= choice.projectRef.length; suffixLength += 2) {
			const suffix = choice.projectRef.slice(-suffixLength);
			const base = choice.displayName.slice(0, Math.max(0, 119 - suffix.length)).trimEnd();
			const displayName = `${base} ${suffix}`.trim();
			const candidateKey = normalizedChoiceLabel(displayName).toLowerCase();
			if (!used.has(candidateKey) && !originalLabels.has(candidateKey)) {
				used.add(candidateKey);
				return { ...choice, displayName };
			}
		}
		return {
			...choice,
			displayName: `Project ${choice.projectRef.slice(-100)}-${index + 1}`,
		};
	});
}

function liveProjectScopeIdsByIdentity(db: Database): Map<string, string[]> {
	const rows = db
		.prepare(
			`SELECT s.cwd, s.project, s.git_remote, s.git_branch, mi.workspace_id, mi.scope_id
			 FROM memory_items mi
			 JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.active = 1 AND mi.deleted_at IS NULL`,
		)
		.all() as Array<{
		cwd: string | null;
		project: string | null;
		git_remote: string | null;
		git_branch: string | null;
		workspace_id: string | null;
		scope_id: string | null;
	}>;
	const scopesByIdentity = new Map<string, Set<string>>();
	for (const row of rows) {
		const identity = canonicalWorkspaceIdentity({
			cwd: row.cwd,
			project: row.project,
			gitRemote: row.git_remote,
			gitBranch: row.git_branch,
			workspaceId: row.workspace_id,
		}).value;
		const scopes = scopesByIdentity.get(identity) ?? new Set<string>();
		scopes.add(row.scope_id?.trim() || LOCAL_DEFAULT_SCOPE_ID);
		scopesByIdentity.set(identity, scopes);
	}
	const result = new Map<string, string[]>();
	for (const [identity, scopes] of scopesByIdentity) {
		result.set(identity, [...scopes].toSorted(compareCodepoints));
	}
	return result;
}

function repairTargetScopeIdsByIdentity(
	db: Database,
	liveScopeIds: ReadonlyMap<string, string[]>,
): Map<string, string[]> {
	const scopesByIdentity = new Map<string, Set<string>>();
	for (const [identity, scopeIds] of liveScopeIds) {
		scopesByIdentity.set(identity, new Set(scopeIds));
	}
	const mappings = db
		.prepare(
			`SELECT workspace_identity, scope_id FROM project_scope_mappings
			 WHERE workspace_identity IS NOT NULL ORDER BY id`,
		)
		.all() as Array<{ workspace_identity: string; scope_id: string }>;
	for (const mapping of mappings) {
		const scopes = scopesByIdentity.get(mapping.workspace_identity) ?? new Set<string>();
		scopes.add(mapping.scope_id);
		scopesByIdentity.set(mapping.workspace_identity, scopes);
	}
	const result = new Map<string, string[]>();
	for (const [identity, scopes] of scopesByIdentity) {
		result.set(identity, [...scopes].toSorted(compareCodepoints));
	}
	return result;
}

function safeProjectIdentityRepairCandidates(
	db: Database,
	sourceScopeId: string,
	sourceProjectIdentity: string,
	targetScopeIds: ReadonlyMap<string, string[]>,
) {
	// Repair redirects an old identity; it does not mutate the target Project.
	// Therefore peer-received/read-only inventory is valid evidence. Scope
	// eligibility comes from live placement or an explicit mapping rather than
	// the settings resolver's default, which can lag the canonical identity.
	const candidates = listProjectScopeCandidates(db, { limit: null }).filter(
		(candidate) =>
			candidate.workspace_identity !== sourceProjectIdentity &&
			isLegacyTeamSetupProjectMappingIdentity(candidate.workspace_identity) &&
			(targetScopeIds.get(candidate.workspace_identity) ?? []).includes(sourceScopeId),
	);
	return [
		...new Map(candidates.map((candidate) => [candidate.workspace_identity, candidate])).values(),
	].toSorted((left, right) => compareCodepoints(left.workspace_identity, right.workspace_identity));
}

function projectIdentityRepairState(
	db: Database,
	sourceProjectIdentity: string,
	blockedItemId: string,
) {
	const liveScopeIds = liveProjectScopeIdsByIdentity(db);
	const sourceScopeIds = liveScopeIds.get(sourceProjectIdentity) ?? [];
	const targetScopeIds = repairTargetScopeIdsByIdentity(db, liveScopeIds);
	const spaces = sourceScopeIds.map((scopeId) => {
		const spaceRef = digest("recipient-policy-repair-space-ref-v1", [blockedItemId, scopeId]);
		const label = db
			.prepare("SELECT label FROM replication_scopes WHERE scope_id = ?")
			.pluck()
			.get(scopeId);
		return {
			scopeId,
			spaceRef,
			displayName: safeSpaceChoiceLabel(typeof label === "string" ? label : ""),
		};
	});
	const candidateRefs = sourceScopeIds.flatMap((scopeId) =>
		safeProjectIdentityRepairCandidates(db, scopeId, sourceProjectIdentity, targetScopeIds).map(
			(candidate) => ({
				projectRef: digest("recipient-policy-target-project-ref-v1", [
					blockedItemId,
					candidate.workspace_identity,
				]),
				spaceRef: spaces.find((space) => space.scopeId === scopeId)?.spaceRef as string,
				scopeId,
				candidate,
			}),
		),
	);
	const sourceFingerprint = digest("recipient-policy-project-repair-source-v1", {
		sourceIdentity: sourceProjectIdentity,
		sourceScopeIds,
		candidateProjectRefs: candidateRefs.map(({ projectRef, spaceRef }) => [projectRef, spaceRef]),
	});
	return { sourceScopeIds, sourceFingerprint, candidateRefs, spaces };
}

function projectScopeAdministrationRepair(
	db: Database,
	projection: LegacyRecipientPolicyProjectionV1,
) {
	const projectIdentity = projection.project.canonicalIdentity;
	if (!isLegacyTeamSetupProjectMappingIdentity(projectIdentity)) return null;
	const liveScopeIds = liveProjectScopeIdsByIdentity(db).get(projectIdentity) ?? [];
	const mappedScopeIds = db
		.prepare(
			`SELECT DISTINCT scope_id FROM project_scope_mappings
			 WHERE project_pattern = ? ORDER BY scope_id`,
		)
		.pluck()
		.all(projectIdentity) as string[];
	const scopeIds = [...new Set([...liveScopeIds, ...mappedScopeIds])].toSorted(compareCodepoints);
	const conflictingSpaces = scopeIds.map((scopeId) => {
		const label = db
			.prepare("SELECT label FROM replication_scopes WHERE scope_id = ?")
			.pluck()
			.get(scopeId);
		return { displayName: safeSpaceChoiceLabel(typeof label === "string" ? label : "") };
	});
	return {
		kind: "review_project_scope_mappings" as const,
		reason: "multiple_enforcement_boundaries" as const,
		projectIdentity,
		projectDisplayName: staleProjectDisplayName(projection.project.displayName),
		conflictingSpaces,
	};
}

function projectIdentityRepair(
	db: Database,
	projection: LegacyRecipientPolicyProjectionV1,
	blockedItemId: string,
) {
	const state = projectIdentityRepairState(db, projection.project.canonicalIdentity, blockedItemId);
	const sourceIdentityRef = digest("recipient-policy-source-project-ref-v1", [
		blockedItemId,
		projection.project.canonicalIdentity,
	]);
	const forbiddenIdentities = state.candidateRefs.map(
		({ candidate }) => candidate.workspace_identity,
	);
	const choicesByRef = new Map<
		string,
		{
			candidate: ReturnType<typeof safeProjectIdentityRepairCandidates>[number];
			projectRef: string;
			spaceRefs: string[];
		}
	>();
	for (const { candidate, projectRef } of state.candidateRefs) {
		if (!choicesByRef.has(projectRef)) {
			choicesByRef.set(projectRef, { candidate, projectRef, spaceRefs: [] });
		}
	}
	const choices = [...choicesByRef.values()];
	for (const choice of choices) {
		choice.spaceRefs = [
			...new Set(
				state.candidateRefs
					.filter(({ projectRef }) => projectRef === choice.projectRef)
					.map(({ spaceRef }) => spaceRef),
			),
		].toSorted(compareCodepoints);
	}
	const presentedChoices = choices.map(({ candidate, projectRef, spaceRefs }) => {
		return {
			projectRef,
			spaceRefs,
			displayName: safeProjectChoiceLabel(
				candidate.display_project,
				forbiddenIdentities,
				projectRef,
			),
		};
	});
	const choicesExceedCap = presentedChoices.length > MAX_PROJECT_IDENTITY_REPAIR_CHOICES;
	return {
		kind: "map_legacy_project_identity" as const,
		sourceIdentityRef,
		sourceFingerprint: state.sourceFingerprint,
		reason:
			state.sourceScopeIds.length === 0
				? ("stale_no_content" as const)
				: state.sourceScopeIds.length > 1
					? ("ambiguous_scope_evidence" as const)
					: presentedChoices.length > 0 && !choicesExceedCap
						? ("ready" as const)
						: ("no_eligible_projects" as const),
		spaces: state.spaces.map(({ spaceRef, displayName }) => ({ spaceRef, displayName })),
		choices: choicesExceedCap ? [] : disambiguateProjectChoiceLabels(presentedChoices),
	};
}

export function deriveRecipientPolicyReviewState(
	db: Database,
	context: RecipientPolicyReviewContext,
	projections = listLegacyRecipientPolicyProjections(db, context),
): RecipientPolicyDerivedReviewState {
	const memoryCounts = memoryCountsByProject(db);
	const allReviewItems: RecipientPolicyActionableReviewItemV1[] = [];
	const blockedItems: RecipientPolicyBlockedItemV1[] = [];
	const staleNoContentItems: RecipientPolicyDerivedReviewState["staleNoContentItems"] = [];
	const preservedDiagnosticFindings: RecipientPolicyDerivedReviewState["preservedDiagnosticFindings"] =
		[];
	for (const projection of projections) {
		const memoryCount = memoryCounts.get(projection.project.canonicalIdentity) ?? 0;
		// Staleness is decided ONLY by the repair path below, which requires the
		// projection to already be a blocked `noncanonical_project_identity`
		// finding with no live scope evidence. A broader "zero memories plus a
		// legacy sharing row" test sweeps in real canonical Projects that simply
		// hold no memories on this device — every `greenroom` worktree mapping,
		// for instance — and would offer to delete their recipient rows.
		const hasDiagnostic = projection.conditions.some(
			(condition) => condition.kind === "diagnostic",
		);
		for (const condition of projection.conditions) {
			const presentation = conditionPresentation(condition);
			if (presentation === "preserved_continuity") {
				preservedDiagnosticFindings.push({
					canonicalProjectIdentity: projection.project.canonicalIdentity,
					conditionCode: condition.code,
				});
				continue;
			}
			if (presentation === "repairable_blocked") {
				const blockedItemId = digest("recipient-policy-blocked-v1", [
					projection.project.canonicalIdentity,
					condition.code,
				]);
				const repair =
					condition.code === "noncanonical_project_identity"
						? projectIdentityRepair(db, projection, blockedItemId)
						: condition.code === "ambiguous_scope_mapping"
							? projectScopeAdministrationRepair(db, projection)
							: null;
				if (repair?.reason === "stale_no_content") {
					staleNoContentItems.push({
						blockedItemId,
						canonicalProjectIdentity: projection.project.canonicalIdentity,
						displayName: staleProjectDisplayName(projection.project.displayName),
					});
					continue;
				}
				blockedItems.push({
					version: RECIPIENT_POLICY_CONTRACT_VERSION,
					blockedItemId,
					finding: condition.message,
					reason:
						repair?.kind === "review_project_scope_mappings"
							? `Project ${repair.projectDisplayName} has conflicting Space mappings: ${repair.conflictingSpaces.map((space) => space.displayName).join(", ")}.`
							: `Project ${projection.project.displayName} requires source-state repair.`,
					...blockedOwner(condition.code),
					repair,
				});
				continue;
			}
			if (hasDiagnostic) continue;
			const decisionScopes =
				condition.code === "unassigned_effective_device"
					? projection.effectiveDevices
							.filter((device) => device.assignment === "unassigned")
							.map((device) => ({
								key: device.deviceId,
								projection: {
									...projection,
									effectiveDevices: [device],
									enforcement: {
										...projection.enforcement,
										currentDeviceIds: [device.deviceId],
									},
								},
							}))
					: [{ key: null, projection }];
			for (const scope of decisionScopes) {
				const sourceFingerprint = recipientPolicyReviewSourceFingerprint(
					scope.projection,
					condition.code,
				);
				const choices = reviewOptions(scope.projection, condition, memoryCount);
				allReviewItems.push({
					version: RECIPIENT_POLICY_CONTRACT_VERSION,
					reviewItemId: digest("recipient-policy-review-v1", [
						projection.project.canonicalIdentity,
						condition.code,
						...(scope.key ? [scope.key] : []),
					]),
					sourceFingerprint,
					finding: condition.message,
					reason: `Review the current recipient evidence for ${projection.project.displayName}.`,
					...choices,
					state: "open",
					resolution: null,
				});
			}
		}
	}
	return { allReviewItems, blockedItems, staleNoContentItems, preservedDiagnosticFindings };
}

function resolutionKey(reviewItemId: string, sourceFingerprint: string): string {
	return `${reviewItemId}\u0000${sourceFingerprint}`;
}

// Each row binds two variables, so 250 rows use 500 variables: safely below
// SQLite's historical 999-variable default while also keeping the VALUES list
// modest on runtimes compiled with tighter parser/resource limits.
const RESOLUTION_LOOKUP_BATCH_SIZE = 250;

function storedResolutions(
	db: Database,
	items: ReadonlyArray<
		Pick<RecipientPolicyActionableReviewItemV1, "reviewItemId" | "sourceFingerprint">
	>,
): Map<string, StoredResolution> {
	const pairs = [
		...new Map(
			items.map((item) => [resolutionKey(item.reviewItemId, item.sourceFingerprint), item]),
		).values(),
	];
	if (pairs.length === 0) return new Map();
	const query = (count: number) =>
		`SELECT review_item_id, source_fingerprint, decision, decision_input_json
		 FROM recipient_policy_review_resolutions
		 WHERE (review_item_id, source_fingerprint) IN (VALUES ${Array.from(
				{ length: count },
				() => "(?, ?)",
			).join(", ")})`;
	const fullBatch =
		pairs.length > RESOLUTION_LOOKUP_BATCH_SIZE
			? db.prepare(query(RESOLUTION_LOOKUP_BATCH_SIZE))
			: null;
	const rows: StoredResolutionRow[] = [];
	for (let offset = 0; offset < pairs.length; offset += RESOLUTION_LOOKUP_BATCH_SIZE) {
		const batch = pairs.slice(offset, offset + RESOLUTION_LOOKUP_BATCH_SIZE);
		const statement =
			batch.length === RESOLUTION_LOOKUP_BATCH_SIZE && fullBatch
				? fullBatch
				: db.prepare(query(batch.length));
		rows.push(
			...(statement.all(
				...batch.flatMap((item) => [item.reviewItemId, item.sourceFingerprint]),
			) as StoredResolutionRow[]),
		);
	}
	return new Map(
		rows.map((row) => [
			resolutionKey(row.review_item_id, row.source_fingerprint),
			{ decision: row.decision, decision_input_json: row.decision_input_json },
		]),
	);
}

interface LegacySharingRowFingerprint {
	recipientKind: string;
	recipientId: string;
	status: string;
	provenance: string;
	policyRevision: string;
	migrationState: string;
	sourceFingerprint: string | null;
	idempotencyKey: string;
}

function legacySharingRowsForIdentity(
	db: Database,
	canonicalProjectIdentity: string,
): LegacySharingRowFingerprint[] {
	return (
		db
			.prepare(
				`SELECT recipient_kind, recipient_id, status, provenance, policy_revision,
				 migration_state, source_fingerprint, idempotency_key
				 FROM project_recipients
				 WHERE canonical_project_identity = ?
				 ORDER BY recipient_kind, recipient_id`,
			)
			.all(canonicalProjectIdentity) as Array<{
			recipient_kind: string;
			recipient_id: string;
			status: string;
			provenance: string;
			policy_revision: string;
			migration_state: string;
			source_fingerprint: string | null;
			idempotency_key: string;
		}>
	).map((row) => ({
		recipientKind: row.recipient_kind,
		recipientId: row.recipient_id,
		status: row.status,
		provenance: row.provenance,
		policyRevision: row.policy_revision,
		migrationState: row.migration_state,
		sourceFingerprint: row.source_fingerprint,
		idempotencyKey: row.idempotency_key,
	}));
}

function staleRecipientPolicySourceGroup(
	db: Database,
	state: RecipientPolicyDerivedReviewState,
): {
	items: RecipientPolicyDerivedReviewState["staleNoContentItems"];
	sourceFingerprint: string;
} {
	// Every stale item must stay visible. Filtering the group down to identities
	// that own removable `project_recipients` rows silently dropped findings that
	// have no stored sharing row at all — the common case, since `unmapped:`
	// identities are derived from sessions — so the user saw neither a repair nor
	// an explanation. Removability is decided per item by the prune op, which
	// skips anything with no rows.
	const items = [
		...new Map(
			state.staleNoContentItems.map((item) => [item.canonicalProjectIdentity, item] as const),
		).values(),
	];
	const fingerprintItems = items.toSorted((left, right) =>
		compareCodepoints(left.canonicalProjectIdentity, right.canonicalProjectIdentity),
	);
	return {
		items,
		sourceFingerprint: recipientPolicyDigest(
			"recipient-policy-stale-source-group-v1",
			fingerprintItems.map((item) => ({
				canonicalProjectIdentity: item.canonicalProjectIdentity,
				rows: legacySharingRowsForIdentity(db, item.canonicalProjectIdentity),
			})),
		),
	};
}

export function listRecipientPolicyReview(
	db: Database,
	context: RecipientPolicyReviewContext,
): RecipientPolicyReviewListV1 {
	const state = deriveRecipientPolicyReviewState(db, context);
	const resolutions = storedResolutions(db, state.allReviewItems);
	const reviewItems = state.allReviewItems.filter(
		(item) => !resolutions.has(resolutionKey(item.reviewItemId, item.sourceFingerprint)),
	);
	const findingCount = reviewItems.length + state.preservedDiagnosticFindings.length;
	const staleGroup = staleRecipientPolicySourceGroup(db, state);
	return {
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		reviewItems,
		blockedItems: state.blockedItems,
		staleNoContent:
			staleGroup.items.length > 0
				? {
						reason: "stale_no_content",
						count: staleGroup.items.length,
						removableCount: staleGroup.items.filter(
							(item) => legacySharingRowsForIdentity(db, item.canonicalProjectIdentity).length > 0,
						).length,
						labels: staleGroup.items.map((item) => item.displayName),
						sourceFingerprint: staleGroup.sourceFingerprint,
					}
				: null,
		continuity:
			findingCount > 0
				? {
						state: "legacy_access_preserved",
						findingCount,
					}
				: null,
	};
}

function staleSourcePruneResult(
	request: RecipientPolicyStaleSourcePruneRequestV1,
	status: RecipientPolicyStaleSourcePruneStatusV1,
	errorCode: string | null,
	input: Pick<RecipientPolicyStaleSourcePruneResultV1, "removed" | "skipped"> = {
		removed: [],
		skipped: [],
	},
): RecipientPolicyStaleSourcePruneResultV1 {
	return {
		status,
		sourceFingerprint: request.sourceFingerprint,
		errorCode,
		removedCount: input.removed.length,
		skippedCount: input.skipped.length,
		removed: input.removed,
		skipped: input.skipped,
	};
}

function isProtectedStaleSourceIdentity(identity: string): boolean {
	return (
		identity === "shared" ||
		identity === LOCAL_DEFAULT_SCOPE_ID ||
		identity.startsWith("shared:") ||
		identity.startsWith("personal:") ||
		identity.startsWith("local:") ||
		identity.startsWith("legacy:") ||
		identity.startsWith("peer-received:") ||
		identity.startsWith("project:")
	);
}

function canonicalLiveMemoryIdentity(
	db: Database,
	row: {
		cwd: string | null;
		project: string | null;
		git_remote: string | null;
		git_branch: string | null;
		workspace_id: string | null;
	},
): string {
	const identity = canonicalWorkspaceIdentity({
		cwd: row.cwd,
		project: row.project,
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		workspaceId: row.workspace_id,
	});
	if (identity.source !== "unmapped") return identity.value;
	return selectedExplicitProjectResolution(db, identity.value)?.workspaceIdentity ?? identity.value;
}

function hasLiveMemoriesForStaleSource(db: Database, identity: string): boolean {
	const rows = db
		.prepare(
			`SELECT s.cwd, s.project, s.git_remote, s.git_branch, mi.workspace_id
			 FROM memory_items mi
			 JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.active = 1 AND mi.deleted_at IS NULL`,
		)
		.all() as Array<{
		cwd: string | null;
		project: string | null;
		git_remote: string | null;
		git_branch: string | null;
		workspace_id: string | null;
	}>;
	return rows.some((row) => canonicalLiveMemoryIdentity(db, row) === identity);
}

function hasLiveScopeEvidenceForStaleSource(db: Database, identity: string): boolean {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM recipient_managed_project_projections
				 WHERE canonical_project_identity = ? AND status = 'active'
				 UNION ALL
				 SELECT 1 FROM recipient_policy_deny_overlays
				 WHERE canonical_project_identity = ?
				 UNION ALL
				 SELECT 1 FROM share_operation_projects p
				 JOIN share_operations o ON o.operation_id = p.operation_id
				 WHERE p.canonical_project_identity = ?
				   AND o.state IN ('accepted', 'provisioning', 'initial_sync', 'active', 'needs_attention')
				 LIMIT 1`,
			)
			.get(identity, identity, identity),
	);
}

function staleSourceSkipReason(
	db: Database,
	identity: string,
	currentStaleIdentities: ReadonlySet<string>,
): RecipientPolicyStaleSourcePruneSkipReasonV1 | null {
	if (isProtectedStaleSourceIdentity(identity)) return "protected_identity";
	if (hasLiveMemoriesForStaleSource(db, identity)) return "live_memories";
	if (hasLiveScopeEvidenceForStaleSource(db, identity)) return "live_scope_evidence";
	if (
		db
			.prepare(
				`SELECT 1 FROM project_scope_mappings
				 WHERE workspace_identity = ? OR project_pattern = ? LIMIT 1`,
			)
			.get(identity, identity)
	) {
		return "project_mapping";
	}
	if (!currentStaleIdentities.has(identity)) return "no_longer_stale_no_content";
	if (legacySharingRowsForIdentity(db, identity).length === 0) return "legacy_rows_missing";
	return null;
}

/**
 * Removes only inert recipient-policy rows. Candidate identities and every
 * safety predicate are recomputed under one immediate transaction; the client
 * supplies only the opaque fingerprint of the rendered stale group.
 */
export function pruneStaleRecipientPolicySources(
	db: Database,
	context: RecipientPolicyReviewContext,
	request: RecipientPolicyStaleSourcePruneRequestV1,
): RecipientPolicyStaleSourcePruneResultV1 {
	if (!request.sourceFingerprint?.trim()) {
		return staleSourcePruneResult(request, "invalid", "request_invalid");
	}
	try {
		return db
			.transaction(() => {
				const state = deriveRecipientPolicyReviewState(db, context);
				const group = staleRecipientPolicySourceGroup(db, state);
				if (group.sourceFingerprint !== request.sourceFingerprint) {
					return staleSourcePruneResult(request, "stale", "source_fingerprint_stale");
				}
				const currentStaleIdentities = new Set(
					state.staleNoContentItems.map((item) => item.canonicalProjectIdentity),
				);
				const removed: RecipientPolicyStaleSourcePruneResultV1["removed"] = [];
				const skipped: RecipientPolicyStaleSourcePruneResultV1["skipped"] = [];
				for (const item of group.items) {
					const reason = staleSourceSkipReason(
						db,
						item.canonicalProjectIdentity,
						currentStaleIdentities,
					);
					if (reason) {
						skipped.push({ label: item.displayName, reason });
						continue;
					}
					// These rows are execution state keyed directly to the legacy
					// Project policy. Keep scope-bearing deny overlays protected above.
					db.prepare(
						"DELETE FROM recipient_policy_reconciliation_steps WHERE canonical_project_identity = ?",
					).run(item.canonicalProjectIdentity);
					db.prepare(
						"DELETE FROM recipient_policy_authority_states WHERE canonical_project_identity = ?",
					).run(item.canonicalProjectIdentity);
					const deleted = db
						.prepare("DELETE FROM project_recipients WHERE canonical_project_identity = ?")
						.run(item.canonicalProjectIdentity);
					if (deleted.changes === 0) {
						skipped.push({ label: item.displayName, reason: "legacy_rows_missing" });
						continue;
					}
					removed.push({ label: item.displayName });
				}
				return staleSourcePruneResult(request, "applied", null, { removed, skipped });
			})
			.immediate();
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String((error as { code?: unknown }).code ?? "")
				: "";
		if (code === "SQLITE_BUSY" || code.startsWith("SQLITE_CONSTRAINT")) {
			return staleSourcePruneResult(request, "conflict", "stale_source_prune_conflict");
		}
		throw error;
	}
}

function projectIdentityRepairResult(
	request: Pick<
		RecipientPolicyProjectIdentityRepairRequestV1,
		"blockedItemId" | "sourceFingerprint"
	>,
	status: RecipientPolicyProjectIdentityRepairStatusV1,
	errorCode: string | null,
	idempotent = false,
): RecipientPolicyProjectIdentityRepairResultV1 {
	return {
		blockedItemId: request.blockedItemId,
		sourceFingerprint: request.sourceFingerprint,
		status,
		errorCode,
		idempotent,
	};
}

function isValidProjectIdentityRepairRequest(
	request: RecipientPolicyProjectIdentityRepairRequestV1,
): boolean {
	return Boolean(
		request.blockedItemId?.trim() &&
			request.sourceIdentityRef?.trim() &&
			request.sourceFingerprint?.trim() &&
			request.projectRef?.trim() &&
			(request.spaceRef === undefined || request.spaceRef.trim()),
	);
}

function selectedRepairSpace(
	state: ReturnType<typeof projectIdentityRepairState>,
	request: RecipientPolicyProjectIdentityRepairRequestV1,
): (typeof state.spaces)[number] | null {
	if (state.spaces.length === 1 && request.spaceRef === undefined) return state.spaces[0] ?? null;
	if (!request.spaceRef) return null;
	return state.spaces.find((space) => space.spaceRef === request.spaceRef) ?? null;
}

export function repairRecipientPolicyProjectIdentity(
	db: Database,
	context: RecipientPolicyReviewContext,
	request: RecipientPolicyProjectIdentityRepairRequestV1,
): RecipientPolicyProjectIdentityRepairResultV1 {
	if (!isValidProjectIdentityRepairRequest(request)) {
		return projectIdentityRepairResult(request, "invalid", "request_invalid");
	}
	try {
		return db
			.transaction(() => {
				const projections = listLegacyRecipientPolicyProjections(db, context);
				const projection = projections.find((candidate) =>
					candidate.conditions.some(
						(condition) =>
							condition.code === "noncanonical_project_identity" &&
							digest("recipient-policy-blocked-v1", [
								candidate.project.canonicalIdentity,
								condition.code,
							]) === request.blockedItemId,
					),
				);
				if (!projection) {
					const persisted = db
						.prepare(
							`SELECT workspace_identity, project_pattern, scope_id, source
							 FROM project_scope_mappings WHERE project_pattern LIKE 'unmapped:%' ORDER BY id`,
						)
						.all() as Array<{
						workspace_identity: string | null;
						project_pattern: string;
						scope_id: string;
						source: string;
					}>;
					const matchingSource = persisted.filter(
						(mapping) =>
							digest("recipient-policy-blocked-v1", [
								mapping.project_pattern,
								"noncanonical_project_identity",
							]) === request.blockedItemId &&
							digest("recipient-policy-source-project-ref-v1", [
								request.blockedItemId,
								mapping.project_pattern,
							]) === request.sourceIdentityRef,
					);
					if (matchingSource.length > 0) {
						if (matchingSource.length !== 1) {
							return projectIdentityRepairResult(request, "conflict", "repair_mapping_conflict");
						}
						const sourceIdentity = (matchingSource[0] as (typeof matchingSource)[number])
							.project_pattern;
						const current = projectIdentityRepairState(db, sourceIdentity, request.blockedItemId);
						if (current.sourceFingerprint !== request.sourceFingerprint) {
							return projectIdentityRepairResult(request, "stale", "source_fingerprint_stale");
						}
						const selectedSpace = selectedRepairSpace(current, request);
						if (!selectedSpace) {
							return projectIdentityRepairResult(request, "conflict", "repair_scope_ambiguous");
						}
						const exact = matchingSource.filter(
							(mapping) =>
								mapping.source === "recipient_policy_repair" &&
								mapping.workspace_identity != null &&
								mapping.scope_id === selectedSpace.scopeId &&
								current.candidateRefs.some(
									(candidate) =>
										candidate.projectRef === request.projectRef &&
										candidate.spaceRef === selectedSpace.spaceRef &&
										candidate.candidate.workspace_identity === mapping.workspace_identity,
								),
						);
						const authoritative = selectedExplicitProjectResolution(db, sourceIdentity);
						return exact.length === 1 &&
							authoritative?.projectPattern === sourceIdentity &&
							authoritative.workspaceIdentity === exact[0]?.workspace_identity &&
							authoritative.scopeId === exact[0]?.scope_id
							? projectIdentityRepairResult(request, "applied", null, true)
							: projectIdentityRepairResult(request, "conflict", "repair_mapping_conflict");
					}
					return projectIdentityRepairResult(request, "not_found", "blocked_item_not_found");
				}
				const repair = projectIdentityRepair(db, projection, request.blockedItemId);
				if (repair.sourceIdentityRef !== request.sourceIdentityRef) {
					return projectIdentityRepairResult(request, "conflict", "source_identity_conflict");
				}
				if (repair.sourceFingerprint !== request.sourceFingerprint) {
					return projectIdentityRepairResult(request, "stale", "source_fingerprint_stale");
				}
				const current = projectIdentityRepairState(
					db,
					projection.project.canonicalIdentity,
					request.blockedItemId,
				);
				if (current.sourceScopeIds.length === 0) {
					return projectIdentityRepairResult(request, "conflict", "repair_scope_missing");
				}
				const selectedSpace = selectedRepairSpace(current, request);
				if (!selectedSpace) {
					return projectIdentityRepairResult(request, "conflict", "repair_scope_ambiguous");
				}
				if (
					!repair.choices.some(
						(choice) =>
							choice.projectRef === request.projectRef &&
							(choice.spaceRefs ?? []).includes(selectedSpace.spaceRef),
					)
				) {
					return projectIdentityRepairResult(request, "invalid", "repair_target_invalid");
				}
				const sourceScopeId = selectedSpace.scopeId;
				const target = current.candidateRefs.find(
					(candidate) =>
						candidate.projectRef === request.projectRef &&
						candidate.spaceRef === selectedSpace.spaceRef,
				)?.candidate;
				if (!target) {
					return projectIdentityRepairResult(request, "invalid", "repair_target_invalid");
				}
				const activeScope = db
					.prepare("SELECT 1 FROM replication_scopes WHERE scope_id = ? AND status = 'active'")
					.get(sourceScopeId);
				if (!activeScope) {
					return projectIdentityRepairResult(request, "conflict", "repair_scope_inactive");
				}
				const sourceMappings = db
					.prepare(
						`SELECT workspace_identity, scope_id FROM project_scope_mappings
						 WHERE project_pattern = ? ORDER BY id`,
					)
					.all(projection.project.canonicalIdentity) as Array<{
					workspace_identity: string | null;
					scope_id: string;
				}>;
				const exactMapping = sourceMappings.find(
					(mapping) =>
						mapping.workspace_identity === target.workspace_identity &&
						mapping.scope_id === sourceScopeId,
				);
				if (sourceMappings.length > 0) {
					if (exactMapping && sourceMappings.length === 1) {
						const authoritative = selectedExplicitProjectResolution(
							db,
							projection.project.canonicalIdentity,
						);
						if (
							authoritative?.projectPattern === projection.project.canonicalIdentity &&
							authoritative.workspaceIdentity === exactMapping.workspace_identity &&
							authoritative.scopeId === exactMapping.scope_id
						) {
							return projectIdentityRepairResult(request, "applied", null, true);
						}
					}
					return projectIdentityRepairResult(request, "conflict", "repair_mapping_conflict");
				}
				const targetScopes = db
					.prepare(
						`SELECT DISTINCT scope_id FROM project_scope_mappings
						 WHERE workspace_identity = ? ORDER BY scope_id`,
					)
					.pluck()
					.all(target.workspace_identity) as string[];
				if (targetScopes.some((scopeId) => scopeId !== sourceScopeId)) {
					return projectIdentityRepairResult(request, "conflict", "repair_target_scope_conflict");
				}
				const now = (context.now ?? (() => new Date().toISOString()))();
				const inserted = db
					.prepare(
						`INSERT INTO project_scope_mappings(
					 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, ?, 1000, 'recipient_policy_repair', ?, ?)`,
					)
					.run(
						target.workspace_identity,
						projection.project.canonicalIdentity,
						sourceScopeId,
						now,
						now,
					);
				const authoritative = selectedExplicitProjectResolution(
					db,
					projection.project.canonicalIdentity,
				);
				if (
					authoritative?.projectPattern !== projection.project.canonicalIdentity ||
					authoritative.workspaceIdentity !== target.workspace_identity ||
					authoritative.scopeId !== sourceScopeId
				) {
					db.prepare("DELETE FROM project_scope_mappings WHERE id = ?").run(
						inserted.lastInsertRowid,
					);
					return projectIdentityRepairResult(request, "conflict", "repair_mapping_conflict");
				}
				return projectIdentityRepairResult(request, "applied", null);
			})
			.immediate();
	} catch (error) {
		const conflict = conflictResult(error, {
			reviewItemId: request.blockedItemId,
			sourceFingerprint: request.sourceFingerprint,
			decision: "keep_current_setup",
		});
		if (conflict) {
			return projectIdentityRepairResult(request, "conflict", "repair_mapping_conflict");
		}
		throw error;
	}
}

function invalid(
	request: Pick<RecipientPolicyReviewResolveRequestV1, "reviewItemId" | "sourceFingerprint">,
	errorCode: string,
): RecipientPolicyReviewResolveResultV1 {
	return {
		reviewItemId: request.reviewItemId,
		sourceFingerprint: request.sourceFingerprint,
		status: "invalid",
		errorCode,
		idempotent: false,
	};
}

function normalizeDecisionInput(
	db: Database,
	projection: LegacyRecipientPolicyProjectionV1,
	request: RecipientPolicyReviewResolveRequestV1,
	decisionDeviceIds: ReadonlySet<string>,
	context: RecipientPolicyReviewContext,
): { ok: true; json: string } | { ok: false; errorCode: string } {
	const candidates = deriveSelectableRecipientIds(db, projection, {
		localIdentity: { localActorId: context.localActorId, localDeviceId: context.localDeviceId },
	});
	const unassignedDeviceIds = new Set(
		projection.effectiveDevices
			.filter(
				(device) => device.assignment === "unassigned" && decisionDeviceIds.has(device.deviceId),
			)
			.map((device) => device.deviceId),
	);
	if (request.decision === "choose_recipients") {
		const input = request.decisionInput;
		if (!input || typeof input !== "object" || Array.isArray(input))
			return { ok: false, errorCode: "decision_input_invalid" };
		const record = input as Record<string, unknown>;
		if (Object.keys(record).length !== 1 || !Array.isArray(record.recipientIds))
			return { ok: false, errorCode: "decision_input_invalid" };
		const recipientIds = record.recipientIds;
		if (
			recipientIds.length === 0 ||
			recipientIds.some((id) => typeof id !== "string" || !candidates.all.has(id)) ||
			new Set(recipientIds).size !== recipientIds.length
		)
			return { ok: false, errorCode: "decision_input_invalid" };
		return { ok: true, json: canonicalJson({ recipientIds: recipientIds.toSorted() }) };
	}
	if (request.decision === "attach_device_to_identity") {
		const input = request.decisionInput;
		if (!input || typeof input !== "object" || Array.isArray(input))
			return { ok: false, errorCode: "decision_input_invalid" };
		const record = input as Record<string, unknown>;
		if (
			Object.keys(record).length !== 2 ||
			typeof record.deviceId !== "string" ||
			!unassignedDeviceIds.has(record.deviceId) ||
			typeof record.identityId !== "string" ||
			!candidates.identities.has(record.identityId)
		)
			return { ok: false, errorCode: "decision_input_invalid" };
		return {
			ok: true,
			json: canonicalJson({ deviceId: record.deviceId, identityId: record.identityId }),
		};
	}
	if (request.decision === "create_identity") {
		const input = request.decisionInput;
		if (!input || typeof input !== "object" || Array.isArray(input))
			return { ok: false, errorCode: "decision_input_invalid" };
		const record = input as Record<string, unknown>;
		const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
		if (
			Object.keys(record).length !== 2 ||
			typeof record.deviceId !== "string" ||
			!unassignedDeviceIds.has(record.deviceId) ||
			!displayName ||
			displayName.length > 80
		)
			return { ok: false, errorCode: "decision_input_invalid" };
		return { ok: true, json: canonicalJson({ deviceId: record.deviceId, displayName }) };
	}
	if (request.decision === "remove_stale_device") {
		const input = request.decisionInput;
		if (!input || typeof input !== "object" || Array.isArray(input))
			return { ok: false, errorCode: "decision_input_invalid" };
		const record = input as Record<string, unknown>;
		if (
			Object.keys(record).length !== 1 ||
			typeof record.deviceId !== "string" ||
			!unassignedDeviceIds.has(record.deviceId)
		)
			return { ok: false, errorCode: "decision_input_invalid" };
		return { ok: true, json: canonicalJson({ deviceId: record.deviceId }) };
	}
	return request.decisionInput === undefined
		? { ok: true, json: "{}" }
		: { ok: false, errorCode: "decision_input_unexpected" };
}

export function deriveSelectableRecipientIds(
	db: Database,
	projection: LegacyRecipientPolicyProjectionV1,
	freshness?: {
		/**
		 * Local identity used to recompute each candidate's current Project
		 * inventory; inventory drift the next discovery would reopen setup
		 * for must also block selection.
		 */
		localIdentity?: { localActorId: string; localDeviceId: string };
		/** Current coordinator roster fingerprints by candidate ID, when the caller holds a snapshot. */
		rosterFingerprints?: ReadonlyMap<string, string>;
	},
): {
	all: Set<string>;
	identities: Set<string>;
	teams: Set<string>;
} {
	const identities = new Set(
		projection.identityCandidates.map((candidate) => candidate.identityId),
	);
	// Legacy candidate materializations are excluded globally, not just for the
	// candidates visible in this projection: an unreviewed broad-access Team for
	// another candidate must never be selectable here. Ready guided-setup Teams
	// are re-admitted through their candidate's completed-draft check below.
	const teams = new Set(
		(
			db
				.prepare(
					`SELECT team_id FROM policy_teams
					 WHERE status = 'active' AND provenance <> 'reviewed_team_candidate'
					 ORDER BY team_id`,
				)
				.all() as Array<{ team_id: string }>
		).map((row) => row.team_id),
	);
	for (const candidate of projection.teamCandidates) {
		const expectedTeamId = deterministicPolicyTeamId(candidate.teamCandidateId);
		teams.delete(expectedTeamId);
		// The full completion-bound compatibility check guards against stale
		// completed Teams whose canonical decisions, memberships, mappings, or
		// recipient edges drifted without clearing the header fingerprint.
		const current = {
			rosterFingerprint: freshness?.rosterFingerprints?.get(candidate.teamCandidateId),
			projects: freshness?.localIdentity
				? legacyTeamCandidateProjectInventory(
						db,
						freshness.localIdentity,
						candidate.teamCandidateId,
					)
				: undefined,
		};
		if (isLegacyTeamCandidateSelectable(db, candidate.teamCandidateId, current)) {
			teams.add(expectedTeamId);
		}
	}
	return {
		identities,
		teams,
		all: new Set([...identities, ...teams]),
	};
}

interface RecipientPolicyResolutionOperation {
	projections: LegacyRecipientPolicyProjectionV1[];
	state: RecipientPolicyDerivedReviewState;
	resolutions: Map<string, StoredResolution>;
}

function deriveResolutionOperation(
	db: Database,
	context: RecipientPolicyReviewContext,
): RecipientPolicyResolutionOperation {
	const projections = listLegacyRecipientPolicyProjections(db, context);
	const state = deriveRecipientPolicyReviewState(db, context, projections);
	return {
		projections,
		state,
		resolutions: storedResolutions(db, state.allReviewItems),
	};
}

function isValidResolveRequest(request: RecipientPolicyReviewResolveRequestV1): boolean {
	return Boolean(
		request.reviewItemId?.trim() &&
			request.sourceFingerprint?.trim() &&
			DECISIONS.has(request.decision),
	);
}

function resolveInTransaction(
	db: Database,
	context: RecipientPolicyReviewContext,
	request: RecipientPolicyReviewResolveRequestV1,
	operation: RecipientPolicyResolutionOperation,
): RecipientPolicyReviewResolveResultV1 {
	if (!isValidResolveRequest(request)) {
		return invalid(request, "request_invalid");
	}
	const item = operation.state.allReviewItems.find(
		(candidate) => candidate.reviewItemId === request.reviewItemId,
	);
	if (!item) {
		return { ...invalid(request, "review_item_not_found"), status: "not_found" };
	}
	if (item.sourceFingerprint !== request.sourceFingerprint) {
		return { ...invalid(request, "source_fingerprint_stale"), status: "stale" };
	}
	const selectedOption = item.options.find((candidate) => candidate.decision === request.decision);
	if (!selectedOption?.preview) return invalid(request, "decision_invalid");
	const projectId = selectedOption.preview.projects[0]?.canonicalIdentity;
	const projection = operation.projections.find(
		(candidate) => candidate.project.canonicalIdentity === projectId,
	);
	if (!projection) return { ...invalid(request, "review_item_not_found"), status: "not_found" };
	const normalizedInput = normalizeDecisionInput(
		db,
		projection,
		request,
		new Set(selectedOption.preview.effectiveDevices.map((device) => device.deviceId)),
		context,
	);
	if (!normalizedInput.ok) return invalid(request, normalizedInput.errorCode);
	const key = resolutionKey(item.reviewItemId, item.sourceFingerprint);
	const existing = operation.resolutions.get(key);
	if (existing) {
		const same =
			existing.decision === request.decision &&
			existing.decision_input_json === normalizedInput.json;
		return {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			status: same ? "applied" : "conflict",
			errorCode: same ? null : "review_item_already_resolved",
			idempotent: same,
		};
	}
	const attribution = resolveLegacyRecipientPolicyLocalIdentity(db, context);
	const decidingIdentityExists = isActiveUnmergedLocalActor(db, attribution.localActorId);
	if (!decidingIdentityExists) return invalid(request, "local_identity_unavailable");
	db.prepare(
		`INSERT INTO recipient_policy_review_resolutions(
			review_item_id, source_fingerprint, decision, decision_input_json, preview_json,
			decided_by_identity_id, decided_by_device_id, resolved_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		item.reviewItemId,
		item.sourceFingerprint,
		request.decision,
		normalizedInput.json,
		canonicalJson(selectedOption.preview),
		attribution.localActorId,
		attribution.localDeviceId,
		(context.now ?? (() => new Date().toISOString()))(),
	);
	operation.resolutions.set(key, {
		decision: request.decision,
		decision_input_json: normalizedInput.json,
	});
	return {
		reviewItemId: item.reviewItemId,
		sourceFingerprint: item.sourceFingerprint,
		status: "applied",
		errorCode: null,
		idempotent: false,
	};
}

function conflictResult(
	error: unknown,
	request: RecipientPolicyReviewResolveRequestV1,
): RecipientPolicyReviewResolveResultV1 | null {
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: "";
	if (code !== "SQLITE_BUSY" && !code.startsWith("SQLITE_CONSTRAINT")) return null;
	// Lock loss and uniqueness/trigger races are deliberately indistinguishable
	// at the contract boundary. Both mean this resolution was not durably
	// applied, and the existing stable code keeps callers fail-closed without
	// exposing SQLite details or introducing a new public error vocabulary.
	return {
		reviewItemId: request.reviewItemId,
		sourceFingerprint: request.sourceFingerprint,
		status: "conflict",
		errorCode: "review_resolution_conflict",
		idempotent: false,
	};
}

export function resolveRecipientPolicyReview(
	db: Database,
	context: RecipientPolicyReviewContext,
	request: RecipientPolicyReviewResolveRequestV1,
): RecipientPolicyReviewResolveResultV1 {
	if (!isValidResolveRequest(request)) return invalid(request, "request_invalid");
	try {
		return db
			.transaction(() =>
				resolveInTransaction(db, context, request, deriveResolutionOperation(db, context)),
			)
			.immediate();
	} catch (error) {
		const conflict = conflictResult(error, request);
		if (conflict) return conflict;
		throw error;
	}
}

export function resolveRecipientPolicyReviewBulk(
	db: Database,
	context: RecipientPolicyReviewContext,
	requests: RecipientPolicyReviewResolveRequestV1[],
): RecipientPolicyReviewBulkResultV1 {
	const counts = new Map<string, number>();
	for (const request of requests) {
		counts.set(request.reviewItemId, (counts.get(request.reviewItemId) ?? 0) + 1);
	}
	const duplicateResult = (request: RecipientPolicyReviewResolveRequestV1) =>
		invalid(request, "duplicate_review_item_id");
	const preflightResults = requests.map((request) => {
		if ((counts.get(request.reviewItemId) ?? 0) > 1) return duplicateResult(request);
		return isValidResolveRequest(request) ? null : invalid(request, "request_invalid");
	});
	if (preflightResults.every((result) => result !== null)) {
		return {
			version: RECIPIENT_POLICY_CONTRACT_VERSION,
			results: preflightResults as RecipientPolicyReviewResolveResultV1[],
		};
	}
	const attemptedResults: RecipientPolicyReviewResolveResultV1[] = [];
	const resolveBulk = db.transaction(() => {
		const operation = deriveResolutionOperation(db, context);
		const resolveOne = db.transaction((request: RecipientPolicyReviewResolveRequestV1) =>
			resolveInTransaction(db, context, request, operation),
		);
		for (const [index, request] of requests.entries()) {
			const preflight = preflightResults[index];
			if (preflight) {
				attemptedResults.push(preflight);
				continue;
			}
			try {
				attemptedResults.push(resolveOne(request));
			} catch (error) {
				// Some SQLite errors abort the outer transaction, not only the
				// request savepoint. Never continue after losing the write lock.
				if (!db.inTransaction) throw error;
				const conflict = conflictResult(error, request);
				if (conflict) {
					attemptedResults.push(conflict);
					continue;
				}
				throw error;
			}
		}
		return attemptedResults;
	});
	try {
		return { version: RECIPIENT_POLICY_CONTRACT_VERSION, results: resolveBulk.immediate() };
	} catch (error) {
		const conflict = requests.find((request) => (counts.get(request.reviewItemId) ?? 0) === 1);
		if (!conflict || !conflictResult(error, conflict)) throw error;
		return {
			version: RECIPIENT_POLICY_CONTRACT_VERSION,
			results: requests.map((request, index) => {
				const preflight = preflightResults[index];
				if (preflight) return preflight;
				const attempted = attemptedResults[index];
				if (attempted && (attempted.status !== "applied" || attempted.idempotent)) {
					return attempted;
				}
				return conflictResult(error, request) as RecipientPolicyReviewResolveResultV1;
			}),
		};
	}
}
