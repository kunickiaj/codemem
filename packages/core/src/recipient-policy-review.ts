import type { Database } from "./db.js";
import {
	isLegacyUmbrellaScopeKind,
	type LegacyRecipientPolicyConditionCodeV1,
	type LegacyRecipientPolicyConditionV1,
	type LegacyRecipientPolicyProjectionV1,
	listLegacyRecipientPolicyProjections,
	resolveLegacyRecipientPolicyLocalIdentity,
} from "./legacy-recipient-policy-projection.js";
import {
	isLegacyTeamCandidateSelectable,
	legacyTeamCandidateProjectInventory,
} from "./legacy-team-candidate.js";
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
} from "./recipient-policy-identifiers.js";
import { canonicalWorkspaceIdentity } from "./scope-resolution.js";

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

export interface RecipientPolicyDerivedReviewState {
	allReviewItems: RecipientPolicyActionableReviewItemV1[];
	blockedItems: RecipientPolicyBlockedItemV1[];
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
		const projectId = canonicalWorkspaceIdentity({
			cwd: row.cwd,
			project: row.project,
			gitRemote: row.git_remote,
			gitBranch: row.git_branch,
			workspaceId: row.workspace_id,
		}).value;
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

export function deriveRecipientPolicyReviewState(
	db: Database,
	context: RecipientPolicyReviewContext,
	projections = listLegacyRecipientPolicyProjections(db, context),
): RecipientPolicyDerivedReviewState {
	const memoryCounts = memoryCountsByProject(db);
	const allReviewItems: RecipientPolicyActionableReviewItemV1[] = [];
	const blockedItems: RecipientPolicyBlockedItemV1[] = [];
	const preservedDiagnosticFindings: RecipientPolicyDerivedReviewState["preservedDiagnosticFindings"] =
		[];
	for (const projection of projections) {
		const memoryCount = memoryCounts.get(projection.project.canonicalIdentity) ?? 0;
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
				blockedItems.push({
					version: RECIPIENT_POLICY_CONTRACT_VERSION,
					blockedItemId: digest("recipient-policy-blocked-v1", [
						projection.project.canonicalIdentity,
						condition.code,
					]),
					finding: condition.message,
					reason: `Project ${projection.project.displayName} requires source-state repair.`,
					...blockedOwner(condition.code),
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
	return { allReviewItems, blockedItems, preservedDiagnosticFindings };
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
	return {
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		reviewItems,
		blockedItems: state.blockedItems,
		continuity:
			findingCount > 0
				? {
						state: "legacy_access_preserved",
						findingCount,
					}
				: null,
	};
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
