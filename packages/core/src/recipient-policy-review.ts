import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import {
	type LegacyRecipientPolicyConditionCodeV1,
	type LegacyRecipientPolicyConditionV1,
	type LegacyRecipientPolicyProjectionV1,
	listLegacyRecipientPolicyProjections,
	resolveLegacyRecipientPolicyLocalIdentity,
} from "./legacy-recipient-policy-projection.js";
import {
	RECIPIENT_POLICY_CONTRACT_VERSION,
	type RecipientPolicyBlockedItemV1,
	type RecipientPolicyContractVersion,
	type RecipientPolicyReviewDecisionV1,
	type RecipientPolicyReviewItemV1,
	type RecipientPolicyReviewOptionV1,
	type RecipientPolicyReviewPreviewV1,
} from "./recipient-policy-contract.js";
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

export interface RecipientPolicyReviewListV1 {
	version: RecipientPolicyContractVersion;
	reviewItems: RecipientPolicyActionableReviewItemV1[];
	blockedItems: RecipientPolicyBlockedItemV1[];
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

interface DerivedReviewState {
	allReviewItems: RecipientPolicyActionableReviewItemV1[];
	blockedItems: RecipientPolicyBlockedItemV1[];
}

interface StoredResolution {
	decision: string;
	decision_input_json: string;
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

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function digest(prefix: string, value: unknown): string {
	return `${prefix}:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

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
			.toSorted((left, right) => left.identityId.localeCompare(right.identityId)),
		teamCandidates: projection.teamCandidates
			.map((candidate) => ({
				teamCandidateId: candidate.teamCandidateId,
				confidence: candidate.confidence,
				provenance: candidate.provenance.toSorted(),
			}))
			.toSorted((left, right) => left.teamCandidateId.localeCompare(right.teamCandidateId)),
		effectiveDevices: projection.effectiveDevices
			.map((device) => ({
				deviceId: device.deviceId,
				identityId: device.identityId,
				assignment: device.assignment,
				access: device.access,
				provenance: device.provenance,
			}))
			.toSorted((left, right) => left.deviceId.localeCompare(right.deviceId)),
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
	const effect = ["keep_current_setup", "reject_suggestion"].includes(decision)
		? "none"
		: "metadata_only";
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
	if (code === "noncanonical_project_identity") {
		return {
			ownerLabel: "Project owner",
			repairAction: "Assign a stable canonical Project identity.",
		};
	}
	if (code === "inactive_scope_boundary") {
		return {
			ownerLabel: "Scope owner",
			repairAction: "Restore or replace the inactive enforcement boundary.",
		};
	}
	return {
		ownerLabel: "Local administrator",
		repairAction: "Repair the ambiguous legacy Project-to-scope mapping in Advanced settings.",
	};
}

function deriveReviewState(
	db: Database,
	context: RecipientPolicyReviewContext,
	projections = listLegacyRecipientPolicyProjections(db, context),
): DerivedReviewState {
	const memoryCounts = memoryCountsByProject(db);
	const allReviewItems: RecipientPolicyActionableReviewItemV1[] = [];
	const blockedItems: RecipientPolicyBlockedItemV1[] = [];
	for (const projection of projections) {
		const memoryCount = memoryCounts.get(projection.project.canonicalIdentity) ?? 0;
		const hasDiagnostic = projection.conditions.some(
			(condition) => condition.kind === "diagnostic",
		);
		for (const condition of projection.conditions) {
			if (condition.kind === "diagnostic") {
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
	return { allReviewItems, blockedItems };
}

function hasResolution(db: Database, item: RecipientPolicyActionableReviewItemV1): boolean {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM recipient_policy_review_resolutions
				 WHERE review_item_id = ? AND source_fingerprint = ? LIMIT 1`,
			)
			.get(item.reviewItemId, item.sourceFingerprint),
	);
}

export function listRecipientPolicyReview(
	db: Database,
	context: RecipientPolicyReviewContext,
): RecipientPolicyReviewListV1 {
	const state = deriveReviewState(db, context);
	return {
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		reviewItems: state.allReviewItems.filter((item) => !hasResolution(db, item)),
		blockedItems: state.blockedItems,
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
	projection: LegacyRecipientPolicyProjectionV1,
	request: RecipientPolicyReviewResolveRequestV1,
	decisionDeviceIds: ReadonlySet<string>,
): { ok: true; json: string } | { ok: false; errorCode: string } {
	const candidates = deriveCandidateIds(projection);
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

function deriveCandidateIds(projection: LegacyRecipientPolicyProjectionV1): {
	all: Set<string>;
	identities: Set<string>;
} {
	const identities = new Set(
		projection.identityCandidates.map((candidate) => candidate.identityId),
	);
	return {
		identities,
		all: new Set([
			...identities,
			...projection.teamCandidates.map((candidate) => candidate.teamCandidateId),
		]),
	};
}

function resolveInTransaction(
	db: Database,
	context: RecipientPolicyReviewContext,
	request: RecipientPolicyReviewResolveRequestV1,
): RecipientPolicyReviewResolveResultV1 {
	if (
		!request.reviewItemId?.trim() ||
		!request.sourceFingerprint?.trim() ||
		!DECISIONS.has(request.decision)
	) {
		return invalid(request, "request_invalid");
	}
	const projections = listLegacyRecipientPolicyProjections(db, context);
	const state = deriveReviewState(db, context, projections);
	const item = state.allReviewItems.find(
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
	const projection = projections.find(
		(candidate) => candidate.project.canonicalIdentity === projectId,
	);
	if (!projection) return { ...invalid(request, "review_item_not_found"), status: "not_found" };
	const normalizedInput = normalizeDecisionInput(
		projection,
		request,
		new Set(selectedOption.preview.effectiveDevices.map((device) => device.deviceId)),
	);
	if (!normalizedInput.ok) return invalid(request, normalizedInput.errorCode);
	const existing = db
		.prepare(
			`SELECT decision, decision_input_json FROM recipient_policy_review_resolutions
			 WHERE review_item_id = ? AND source_fingerprint = ?`,
		)
		.get(item.reviewItemId, item.sourceFingerprint) as StoredResolution | undefined;
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
	const decidingIdentityExists = Boolean(
		db
			.prepare(
				`SELECT 1 FROM actors
				 WHERE actor_id = ? AND is_local = 1 AND status = 'active'
				 LIMIT 1`,
			)
			.get(attribution.localActorId),
	);
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
	return {
		reviewItemId: item.reviewItemId,
		sourceFingerprint: item.sourceFingerprint,
		status: "applied",
		errorCode: null,
		idempotent: false,
	};
}

export function resolveRecipientPolicyReview(
	db: Database,
	context: RecipientPolicyReviewContext,
	request: RecipientPolicyReviewResolveRequestV1,
): RecipientPolicyReviewResolveResultV1 {
	try {
		return db.transaction(() => resolveInTransaction(db, context, request)).immediate();
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String((error as { code?: unknown }).code ?? "")
				: "";
		if (code === "SQLITE_BUSY" || code.startsWith("SQLITE_CONSTRAINT")) {
			return {
				reviewItemId: request.reviewItemId,
				sourceFingerprint: request.sourceFingerprint,
				status: "conflict",
				errorCode: "review_resolution_conflict",
				idempotent: false,
			};
		}
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
	return {
		version: RECIPIENT_POLICY_CONTRACT_VERSION,
		results: requests.map((request) =>
			(counts.get(request.reviewItemId) ?? 0) > 1
				? invalid(request, "duplicate_review_item_id")
				: resolveRecipientPolicyReview(db, context, request),
		),
	};
}
