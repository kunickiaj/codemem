import type { Database } from "./db.js";
import { assignIdentityDeviceInTransaction } from "./identity-device-assignment.js";
import {
	type LegacyRecipientPolicyProjectionV1,
	listLegacyRecipientPolicyProjections,
} from "./legacy-recipient-policy-projection.js";
import {
	isRecipientPolicyNoOpDecision,
	RECIPIENT_POLICY_CONTRACT_VERSION,
} from "./recipient-policy-contract.js";
import {
	canonicalRecipientPolicyJson,
	compareCodepoints,
	deterministicPolicyTeamId,
	legacyRecipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import type {
	RecipientPolicyActionableReviewItemV1,
	RecipientPolicyReviewContext,
} from "./recipient-policy-review.js";
import {
	deriveRecipientPolicyReviewState,
	deriveSelectableRecipientIds,
} from "./recipient-policy-review.js";
import { shareProjectSetDigest } from "./share-operation.js";

export interface RecipientPolicyMigrationOptions {
	dryRun?: boolean;
}

export type RecipientPolicyMigrationProjectStatus =
	| "migrated"
	| "would_migrate"
	| "unchanged"
	| "skipped"
	| "blocked";

export interface RecipientPolicyMigrationProjectResultV1 {
	canonicalProjectIdentity: string;
	status: RecipientPolicyMigrationProjectStatus;
	writeCount: number;
	idempotent: boolean;
	errorCode: string | null;
}

export interface RecipientPolicyMigrationResultV1 {
	version: typeof RECIPIENT_POLICY_CONTRACT_VERSION;
	dryRun: boolean;
	results: RecipientPolicyMigrationProjectResultV1[];
}

interface StoredResolution {
	review_item_id: string;
	source_fingerprint: string;
	decision: string;
	decision_input_json: string;
	preview_json: string;
}

interface IntentRow {
	table: "identity_devices" | "project_recipients";
	key: Record<string, string>;
	values: Record<string, string | null>;
	compatibleEvidence?: IntentRow[];
	releasedV1Metadata?: {
		revision: string;
		idempotencyKey: string;
	};
}

interface ActorRow {
	actorId: string;
	displayName: string;
}

interface ProjectPlan {
	rows: IntentRow[];
	actors: ActorRow[];
	hadApplicableEvidence: boolean;
}

const VALID_LINKED_OPERATION_STATES = new Set([
	"accepted",
	"provisioning",
	"initial_sync",
	"active",
	"needs_attention",
]);

const INTENT_ROW_SCHEMAS: Record<
	IntentRow["table"],
	{
		keyColumns: readonly string[];
		valueColumns: ReadonlySet<string>;
		semanticColumns: readonly string[];
	}
> = {
	identity_devices: {
		keyColumns: ["device_id"],
		valueColumns: new Set([
			"identity_id",
			"display_name",
			"status",
			"provenance",
			"revision",
			"migration_state",
			"source_fingerprint",
			"idempotency_key",
			"created_at",
			"updated_at",
		]),
		semanticColumns: ["identity_id", "display_name", "status"],
	},
	project_recipients: {
		keyColumns: ["canonical_project_identity", "recipient_kind", "recipient_id"],
		valueColumns: new Set([
			"status",
			"provenance",
			"policy_revision",
			"migration_state",
			"source_fingerprint",
			"idempotency_key",
			"created_at",
			"updated_at",
		]),
		semanticColumns: ["status"],
	},
};

const MIGRATION_EVIDENCE_PROVENANCE_RANK = new Map([
	["exact_project_invite", 0],
	["managed_exact_project", 0],
	["review_resolution", 1],
]);

function digest(prefix: string, value: unknown): string {
	return legacyRecipientPolicyDigest(prefix, value);
}

export { deterministicPolicyTeamId } from "./recipient-policy-identifiers.js";

function relationshipMetadata(
	kind: string,
	identity: unknown,
	provenance: string,
	sourceFingerprint: string | null,
): {
	revision: string;
	idempotencyKey: string;
	releasedV1Metadata: { revision: string; idempotencyKey: string };
} {
	const evidenceBoundIdentity = {
		identity,
		provenance,
		sourceFingerprint,
	};
	return {
		revision: digest(`recipient-policy-${kind}-revision-v2`, evidenceBoundIdentity),
		idempotencyKey: digest(`recipient-policy-${kind}-idempotency-v2`, evidenceBoundIdentity),
		releasedV1Metadata: {
			revision: digest(`recipient-policy-${kind}-revision-v1`, identity),
			idempotencyKey: digest(`recipient-policy-${kind}-idempotency-v1`, identity),
		},
	};
}

function baseValues(input: {
	provenance: string;
	revision: string;
	idempotencyKey: string;
	sourceFingerprint?: string | null;
	now: string;
}): Record<string, string | null> & { revision: string } {
	return {
		status: "active",
		provenance: input.provenance,
		migration_state: "projected",
		source_fingerprint: input.sourceFingerprint ?? null,
		idempotency_key: input.idempotencyKey,
		created_at: input.now,
		updated_at: input.now,
		revision: input.revision,
	};
}

function projectRecipientRow(input: {
	projectId: string;
	recipientKind: "identity" | "team";
	recipientId: string;
	provenance: string;
	sourceFingerprint?: string | null;
	now: string;
}): IntentRow {
	const identity = [input.projectId, input.recipientKind, input.recipientId];
	const sourceFingerprint = input.sourceFingerprint ?? null;
	const metadata = relationshipMetadata(
		"project-recipient",
		identity,
		input.provenance,
		sourceFingerprint,
	);
	const values = baseValues({
		provenance: input.provenance,
		revision: metadata.revision,
		idempotencyKey: metadata.idempotencyKey,
		sourceFingerprint,
		now: input.now,
	});
	const { revision, ...withoutRevision } = values;
	return {
		table: "project_recipients",
		key: {
			canonical_project_identity: input.projectId,
			recipient_kind: input.recipientKind,
			recipient_id: input.recipientId,
		},
		values: { ...withoutRevision, policy_revision: revision },
		releasedV1Metadata: metadata.releasedV1Metadata,
	};
}

function identityDeviceRow(input: {
	deviceId: string;
	identityId: string;
	displayName: string;
	provenance: string;
	sourceFingerprint?: string | null;
	now: string;
}): IntentRow {
	const sourceFingerprint = input.sourceFingerprint ?? null;
	const metadata = relationshipMetadata(
		"identity-device",
		[input.deviceId, input.identityId],
		input.provenance,
		// Device assignment is global and may be authorized by more than one
		// Project resolution. Project-specific source evidence remains stored for
		// audit, but cannot define the global relationship's stable metadata.
		null,
	);
	return {
		table: "identity_devices",
		key: { device_id: input.deviceId },
		values: {
			identity_id: input.identityId,
			display_name: input.displayName,
			...baseValues({
				provenance: input.provenance,
				revision: metadata.revision,
				idempotencyKey: metadata.idempotencyKey,
				sourceFingerprint,
				now: input.now,
			}),
		},
		releasedV1Metadata: metadata.releasedV1Metadata,
	};
}

function projectIdForReviewItem(item: {
	options: Array<{ preview: { projects: Array<{ canonicalIdentity: string }> } }>;
}): string | null {
	return item.options[0]?.preview.projects[0]?.canonicalIdentity ?? null;
}

function parseDecisionInput(json: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(json) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function addProjectedDevices(
	plan: ProjectPlan,
	projection: LegacyRecipientPolicyProjectionV1,
	provenance: string,
	sourceFingerprint: string | null,
	now: string,
): void {
	for (const device of projection.effectiveDevices) {
		if (device.assignment !== "assigned" || !device.identityId) continue;
		plan.rows.push(
			identityDeviceRow({
				deviceId: device.deviceId,
				identityId: device.identityId,
				displayName: device.displayName,
				provenance,
				sourceFingerprint,
				now,
			}),
		);
	}
}

function addAutomaticOperationEvidence(
	db: Database,
	plan: ProjectPlan,
	projection: LegacyRecipientPolicyProjectionV1,
	localActorId: string,
	now: string,
): string | null {
	if (projection.enforcement.state !== "managed_exact_project") return null;
	const operations = db
		.prepare(
			`SELECT o.operation_id, o.state, o.recipient_actor_id, o.recipient_device_id,
				o.reviewed_project_set_digest
			 FROM share_operations o
			 JOIN share_operation_projects p ON p.operation_id = o.operation_id
			 WHERE p.canonical_project_identity = ?
			   AND o.inviter_actor_id = ?
			   AND o.recipient_actor_id IS NOT NULL
			   AND o.acceptance_consumed_at IS NOT NULL
			   AND TRIM(o.acceptance_consumed_at) <> ''
			 ORDER BY o.created_at, o.operation_id`,
		)
		.all(projection.project.canonicalIdentity, localActorId) as Array<{
		operation_id: string;
		state: string;
		recipient_actor_id: string;
		recipient_device_id: string | null;
		reviewed_project_set_digest: string;
	}>;
	for (const operation of operations) {
		if (!VALID_LINKED_OPERATION_STATES.has(operation.state)) continue;
		const projects = db
			.prepare(
				`SELECT canonical_project_identity, display_name, identity_source, existing_memory_count
				 FROM share_operation_projects WHERE operation_id = ?
				 ORDER BY canonical_project_identity`,
			)
			.all(operation.operation_id)
			.map((row) => {
				const value = row as Record<string, unknown>;
				return {
					canonicalIdentity: String(value.canonical_project_identity ?? ""),
					displayName: String(value.display_name ?? ""),
					identitySource: String(value.identity_source ?? ""),
					existingMemoryCount: Number(value.existing_memory_count ?? -1),
				};
			});
		if (
			projects.length === 0 ||
			shareProjectSetDigest(projects) !== operation.reviewed_project_set_digest
		) {
			return "reviewed_project_set_digest_mismatch";
		}
		const validCandidate = projection.identityCandidates.some(
			(candidate) =>
				candidate.identityId === operation.recipient_actor_id &&
				candidate.provenance.includes("exact_project_invite"),
		);
		const actorExists = Boolean(
			db
				.prepare("SELECT 1 FROM actors WHERE actor_id = ? AND status IN ('active', 'pending')")
				.get(operation.recipient_actor_id),
		);
		const linkedDevice = operation.recipient_device_id
			? projection.effectiveDevices.find(
					(device) =>
						device.deviceId === operation.recipient_device_id &&
						device.assignment === "assigned" &&
						device.identityId === operation.recipient_actor_id,
				)
			: null;
		if (!validCandidate || !actorExists || !linkedDevice) return "linked_identity_invalid";
		plan.hadApplicableEvidence = true;
		plan.rows.push(
			projectRecipientRow({
				projectId: projection.project.canonicalIdentity,
				recipientKind: "identity",
				recipientId: operation.recipient_actor_id,
				provenance: "exact_project_invite",
				now,
			}),
		);
		addProjectedDevices(plan, projection, "managed_exact_project", null, now);
	}
	return null;
}

function addReviewDecision(
	db: Database,
	plan: ProjectPlan,
	projection: LegacyRecipientPolicyProjectionV1,
	currentItem: RecipientPolicyActionableReviewItemV1,
	resolution: StoredResolution,
	context: RecipientPolicyReviewContext,
	now: string,
): string | null {
	plan.hadApplicableEvidence = true;
	const currentOption = currentItem.options.find(
		(option) => option.decision === resolution.decision,
	);
	const reviewedPreview = parseDecisionInput(resolution.preview_json);
	if (
		!currentOption ||
		!reviewedPreview ||
		canonicalRecipientPolicyJson(reviewedPreview) !==
			canonicalRecipientPolicyJson(currentOption.preview)
	) {
		return "review_preview_stale";
	}
	if (resolution.decision === "preserve_current_access") {
		return "review_preserves_legacy_access";
	}
	if (isRecipientPolicyNoOpDecision(resolution.decision)) return null;
	const input = parseDecisionInput(resolution.decision_input_json);
	if (!input) return "review_decision_input_invalid";
	if (resolution.decision === "apply_recommendation") {
		const localCandidates = projection.identityCandidates.filter((candidate) => candidate.isLocal);
		if (localCandidates.length !== 1) return "review_recommendation_invalid";
		plan.rows.push(
			projectRecipientRow({
				projectId: projection.project.canonicalIdentity,
				recipientKind: "identity",
				recipientId: localCandidates[0]?.identityId ?? "",
				provenance: "review_resolution",
				sourceFingerprint: resolution.source_fingerprint,
				now,
			}),
		);
		addProjectedDevices(plan, projection, "review_resolution", resolution.source_fingerprint, now);
		return null;
	}
	if (resolution.decision === "choose_recipients") {
		const recipientIds = Array.isArray(input.recipientIds) ? input.recipientIds : [];
		if (
			recipientIds.length === 0 ||
			recipientIds.some((id) => typeof id !== "string") ||
			new Set(recipientIds).size !== recipientIds.length
		) {
			return "review_decision_input_invalid";
		}
		const selectableRecipients = deriveSelectableRecipientIds(db, projection, {
			localIdentity: {
				localActorId: context.localActorId,
				localDeviceId: context.localDeviceId,
			},
		});
		for (const recipientId of recipientIds as string[]) {
			if (selectableRecipients.identities.has(recipientId)) {
				plan.rows.push(
					projectRecipientRow({
						projectId: projection.project.canonicalIdentity,
						recipientKind: "identity",
						recipientId,
						provenance: "review_resolution",
						sourceFingerprint: resolution.source_fingerprint,
						now,
					}),
				);
				continue;
			}
			// Resolutions saved by the previous migration path reference the legacy
			// `teamCandidateId`; once guided setup materializes that candidate's
			// deterministic Team, the saved selection must translate to it instead
			// of remaining permanently stale.
			const translatedTeamId = selectableRecipients.teams.has(recipientId)
				? recipientId
				: selectableRecipients.teams.has(deterministicPolicyTeamId(recipientId))
					? deterministicPolicyTeamId(recipientId)
					: null;
			if (!translatedTeamId) return "review_recipient_stale";
			plan.rows.push(
				projectRecipientRow({
					projectId: projection.project.canonicalIdentity,
					recipientKind: "team",
					recipientId: translatedTeamId,
					provenance: "review_resolution",
					sourceFingerprint: resolution.source_fingerprint,
					now,
				}),
			);
		}
		addProjectedDevices(plan, projection, "review_resolution", resolution.source_fingerprint, now);
		return null;
	}
	if (resolution.decision === "attach_device_to_identity") {
		const deviceId = typeof input.deviceId === "string" ? input.deviceId : "";
		const identityId = typeof input.identityId === "string" ? input.identityId : "";
		const device = projection.effectiveDevices.find(
			(candidate) => candidate.deviceId === deviceId && candidate.assignment === "unassigned",
		);
		if (
			!device ||
			!projection.identityCandidates.some((candidate) => candidate.identityId === identityId)
		)
			return "review_decision_input_stale";
		plan.rows.push(
			identityDeviceRow({
				deviceId,
				identityId,
				displayName: device.displayName,
				provenance: "review_resolution",
				sourceFingerprint: resolution.source_fingerprint,
				now,
			}),
			projectRecipientRow({
				projectId: projection.project.canonicalIdentity,
				recipientKind: "identity",
				recipientId: identityId,
				provenance: "review_resolution",
				sourceFingerprint: resolution.source_fingerprint,
				now,
			}),
		);
		return null;
	}
	if (resolution.decision === "create_identity") {
		const deviceId = typeof input.deviceId === "string" ? input.deviceId : "";
		const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
		const device = projection.effectiveDevices.find(
			(candidate) => candidate.deviceId === deviceId && candidate.assignment === "unassigned",
		);
		if (!device || !displayName || displayName.length > 80 || input.displayName !== displayName)
			return "review_decision_input_stale";
		const existingIdentityId = db
			.prepare("SELECT identity_id FROM identity_devices WHERE device_id = ?")
			.pluck()
			.get(deviceId) as string | undefined;
		// Device assignment is global; Project/review inputs must not mint another Identity.
		const actorId = existingIdentityId ?? digest("policy-identity-v1", { deviceId });
		if (!existingIdentityId) plan.actors.push({ actorId, displayName });
		plan.rows.push(
			identityDeviceRow({
				deviceId,
				identityId: actorId,
				displayName: device.displayName,
				provenance: "review_resolution",
				sourceFingerprint: resolution.source_fingerprint,
				now,
			}),
			projectRecipientRow({
				projectId: projection.project.canonicalIdentity,
				recipientKind: "identity",
				recipientId: actorId,
				provenance: "review_resolution",
				sourceFingerprint: resolution.source_fingerprint,
				now,
			}),
		);
		return null;
	}
	return "review_decision_unsupported";
}

function collectCompatibleDeviceEvidence(input: {
	db: Database;
	context: RecipientPolicyReviewContext;
	projections: LegacyRecipientPolicyProjectionV1[];
	currentItemsByProject: ReadonlyMap<string, RecipientPolicyActionableReviewItemV1[]>;
	resolutionBySource: ReadonlyMap<string, StoredResolution>;
	now: string;
}): Map<string, IntentRow[]> {
	const evidence = new Map<string, IntentRow[]>();
	for (const projection of input.projections) {
		const currentItems =
			input.currentItemsByProject.get(projection.project.canonicalIdentity) ?? [];
		const matchingResolutions = currentItems.map((currentItem) =>
			input.resolutionBySource.get(
				`${currentItem.reviewItemId}\u0000${currentItem.sourceFingerprint}`,
			),
		);
		if (
			matchingResolutions.some((resolution) => !resolution) ||
			matchingResolutions.some((resolution) => resolution?.decision === "preserve_current_access")
		) {
			continue;
		}
		const plan: ProjectPlan = { rows: [], actors: [], hadApplicableEvidence: false };
		try {
			if (
				addAutomaticOperationEvidence(
					input.db,
					plan,
					projection,
					input.context.localActorId,
					input.now,
				) !== null
			) {
				continue;
			}
			let reviewEvidenceValid = true;
			for (const [index, resolution] of matchingResolutions.entries()) {
				const currentItem = currentItems[index];
				if (
					!resolution ||
					!currentItem?.options.some((option) => option.decision === resolution.decision) ||
					addReviewDecision(
						input.db,
						plan,
						projection,
						currentItem,
						resolution,
						input.context,
						input.now,
					) !== null
				) {
					reviewEvidenceValid = false;
					break;
				}
			}
			if (!reviewEvidenceValid) continue;
		} catch (error) {
			// Evidence indexing is fail-closed; project migration still reports
			// the authoritative validation error from its savepoint below.
			if (projectMigrationErrorCode(error) === null) throw error;
			continue;
		}
		let viablePlan: ProjectPlan;
		try {
			viablePlan = deduplicatePlan(plan);
		} catch (error) {
			if (projectMigrationErrorCode(error) === null) throw error;
			continue;
		}
		for (const row of viablePlan.rows) {
			if (row.table !== "identity_devices") continue;
			const deviceId = row.key.device_id;
			const identityId = row.values.identity_id;
			if (typeof deviceId !== "string" || typeof identityId !== "string") continue;
			const key = deviceRelationshipKey(deviceId, identityId);
			const candidates = evidence.get(key) ?? [];
			candidates.push(...intentEvidenceCandidates(row));
			evidence.set(key, candidates);
		}
	}
	return evidence;
}

/** Internal module boundary exported for direct security regression coverage. */
export function assertAllowedRecipientPolicyIntentRow(row: IntentRow): void {
	if (!Object.hasOwn(INTENT_ROW_SCHEMAS, row.table)) throw new Error("intent_conflict");
	const schema = INTENT_ROW_SCHEMAS[row.table];
	const keyColumns = Object.keys(row.key);
	const valueColumns = Object.keys(row.values);
	if (
		keyColumns.length !== schema.keyColumns.length ||
		schema.keyColumns.some((column) => !Object.hasOwn(row.key, column)) ||
		keyColumns.some((column) => typeof row.key[column] !== "string") ||
		valueColumns.length === 0 ||
		valueColumns.some((column) => !schema.valueColumns.has(column)) ||
		keyColumns.some((column) => Object.hasOwn(row.values, column))
	) {
		throw new Error("intent_conflict");
	}
	const provenance = row.values.provenance;
	const sourceFingerprint = row.values.source_fingerprint;
	const automaticProvenance =
		row.table === "identity_devices" ? "managed_exact_project" : "exact_project_invite";
	if (
		(provenance !== automaticProvenance && provenance !== "review_resolution") ||
		(provenance === "review_resolution"
			? typeof sourceFingerprint !== "string"
			: sourceFingerprint !== null)
	) {
		throw new Error(
			row.table === "identity_devices" ? "device_identity_conflict" : "intent_conflict",
		);
	}
}

function rowWhere(row: IntentRow): { clause: string; parameters: string[] } {
	assertAllowedRecipientPolicyIntentRow(row);
	const entries = INTENT_ROW_SCHEMAS[row.table].keyColumns.map(
		(column) => [column, row.key[column]] as const,
	);
	return {
		clause: entries.map(([column]) => `${column} = ?`).join(" AND "),
		parameters: entries.map(([, value]) => {
			if (typeof value !== "string") throw new Error("intent_conflict");
			return value;
		}),
	};
}

function validateOrWriteActor(db: Database, actor: ActorRow, now: string, write: boolean): boolean {
	const existing = db
		.prepare(
			"SELECT display_name, is_local, status, merged_into_actor_id FROM actors WHERE actor_id = ?",
		)
		.get(actor.actorId) as
		| {
				display_name: string;
				is_local: number;
				status: string;
				merged_into_actor_id: string | null;
		  }
		| undefined;
	if (existing) {
		if (
			existing.display_name !== actor.displayName ||
			existing.is_local !== 0 ||
			existing.status !== "active" ||
			existing.merged_into_actor_id !== null
		) {
			throw new Error("identity_conflict");
		}
		return false;
	}
	if (write) {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at)
			 VALUES (?, ?, 0, 'active', NULL, ?, ?)`,
		).run(actor.actorId, actor.displayName, now, now);
	}
	return true;
}

function requiredIntentValue(row: IntentRow, column: string): string {
	const value = row.values[column];
	if (typeof value !== "string") throw new Error("intent_conflict");
	return value;
}

function intentEvidenceCandidates(row: IntentRow): IntentRow[] {
	const { compatibleEvidence, ...primary } = row;
	return [primary, ...(compatibleEvidence ?? [])];
}

function deviceRelationshipKey(deviceId: string, identityId: string): string {
	return canonicalRecipientPolicyJson({ deviceId, identityId });
}

function relationshipMetadataMatches(
	existing: Record<string, unknown>,
	row: IntentRow,
	revisionColumn: "revision" | "policy_revision",
): boolean {
	const evidenceMatches =
		existing.provenance === row.values.provenance &&
		(existing.source_fingerprint ?? null) === (row.values.source_fingerprint ?? null);
	if (!evidenceMatches) return false;
	const currentMetadataMatches =
		existing[revisionColumn] === row.values[revisionColumn] &&
		existing.idempotency_key === row.values.idempotency_key;
	const releasedV1MetadataMatches =
		row.releasedV1Metadata !== undefined &&
		existing[revisionColumn] === row.releasedV1Metadata.revision &&
		existing.idempotency_key === row.releasedV1Metadata.idempotencyKey;
	return currentMetadataMatches || releasedV1MetadataMatches;
}

function relationshipMetadataMatchesAny(
	existing: Record<string, unknown>,
	row: IntentRow,
	revisionColumn: "revision" | "policy_revision",
): boolean {
	return intentEvidenceCandidates(row).some((candidate) =>
		relationshipMetadataMatches(existing, candidate, revisionColumn),
	);
}

/**
 * Guided setup can reassign a pre-existing device row, which preserves that
 * row's original provenance and revision (`assignIdentityDeviceInTransaction`
 * changes only the assignment). Completion-bound draft evidence — an
 * `included` decision targeting this identity on a completed attempt — is the
 * authoritative signal that setup reviewed the assignment, so it satisfies
 * the migration intent exactly like a setup-created row does.
 */
function hasCompletedSetupAssignmentEvidence(
	db: Database,
	deviceId: string,
	identityId: string,
): boolean {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM legacy_team_setup_draft_devices dd
				 JOIN legacy_team_setup_drafts d ON d.attempt_id = dd.attempt_id
				 WHERE dd.device_id = ? AND dd.decision = 'included'
				   AND dd.target_identity_id = ?
				   AND d.state = 'completed' AND d.completed_team_id IS NOT NULL
				 LIMIT 1`,
			)
			.get(deviceId, identityId),
	);
}

function validateOrAssignIdentityDevice(
	db: Database,
	row: IntentRow,
	write: boolean,
	compatibleDeviceEvidence: ReadonlyMap<string, IntentRow[]>,
): boolean {
	if (row.table !== "identity_devices") throw new Error("intent_conflict");
	assertAllowedRecipientPolicyIntentRow(row);
	const deviceId = row.key.device_id;
	if (!deviceId) throw new Error("intent_conflict");
	const identityId = requiredIntentValue(row, "identity_id");
	const existing = db
		.prepare(
			`SELECT identity_id, assignment_version, status, revision, provenance,
			        source_fingerprint, idempotency_key
			 FROM identity_devices WHERE device_id = ?`,
		)
		.get(deviceId) as
		| {
				identity_id: string;
				assignment_version: number;
				status: string;
				revision: string;
				provenance: string;
				source_fingerprint: string | null;
				idempotency_key: string;
		  }
		| undefined;
	if (existing) {
		// Guided setup owns its device rows and stamps them with the Team
		// activation revision; a matching assignment written by setup satisfies
		// the migration intent without requiring the migration revision. Setup
		// may also have reassigned a row created by another flow — that row
		// keeps its old provenance and revision, so completion-bound draft
		// evidence is what proves the assignment was reviewed.
		const setupCompatible =
			existing.provenance === "reviewed_team_setup" ||
			hasCompletedSetupAssignmentEvidence(db, deviceId, identityId);
		const currentEvidenceMatches = (
			compatibleDeviceEvidence.get(deviceRelationshipKey(deviceId, identityId)) ?? []
		).some((candidate) => relationshipMetadataMatches(existing, candidate, "revision"));
		if (
			existing.identity_id !== identityId ||
			existing.status !== requiredIntentValue(row, "status") ||
			(!setupCompatible && !currentEvidenceMatches)
		) {
			throw new Error("device_identity_conflict");
		}
		if (write) {
			assignIdentityDeviceInTransaction(db, {
				deviceId,
				targetIdentityId: identityId,
				expectation: {
					kind: "existing",
					assignmentVersion: existing.assignment_version,
					identityId: existing.identity_id,
				},
				now: requiredIntentValue(row, "updated_at"),
			});
		}
		return false;
	}
	if (write) {
		assignIdentityDeviceInTransaction(db, {
			deviceId,
			targetIdentityId: identityId,
			expectation: { kind: "absent" },
			insert: {
				displayName: requiredIntentValue(row, "display_name"),
				provenance: requiredIntentValue(row, "provenance"),
				revision: requiredIntentValue(row, "revision"),
				migrationState: requiredIntentValue(row, "migration_state"),
				sourceFingerprint: row.values.source_fingerprint,
				idempotencyKey: requiredIntentValue(row, "idempotency_key"),
			},
			now: requiredIntentValue(row, "updated_at"),
		});
	}
	return true;
}

function validateOrWriteRow(db: Database, row: IntentRow, write: boolean): boolean {
	if (row.table !== "project_recipients") throw new Error("intent_conflict");
	const where = rowWhere(row);
	const existing = db
		.prepare(`SELECT * FROM ${row.table} WHERE ${where.clause}`)
		.get(...where.parameters) as Record<string, unknown> | undefined;
	if (existing) {
		// Guided setup owns its recipient edges and stamps them with the Team
		// activation revision; an active setup-owned edge for the same key
		// satisfies the migration intent without requiring the migration
		// revision, matching the device-row handling above.
		if (
			existing.provenance === "reviewed_team_setup" &&
			existing.status === "active" &&
			row.values.status === "active"
		) {
			return false;
		}
		if (
			existing.status !== row.values.status ||
			!relationshipMetadataMatchesAny(existing, row, "policy_revision")
		) {
			throw new Error("intent_conflict");
		}
		return false;
	}
	const columns = [...Object.keys(row.key), ...Object.keys(row.values)];
	const values = [...Object.values(row.key), ...Object.values(row.values)];
	if (write) {
		db.prepare(
			`INSERT INTO ${row.table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		).run(...values);
	}
	return true;
}

function intentRowConflict(row: IntentRow): string {
	return row.table === "identity_devices" ? "device_identity_conflict" : "intent_conflict";
}

function intentEvidenceKey(row: IntentRow): string {
	const revisionColumn = row.table === "identity_devices" ? "revision" : "policy_revision";
	return canonicalRecipientPolicyJson({
		provenance: requiredIntentValue(row, "provenance"),
		sourceFingerprint: row.values.source_fingerprint,
		revision: requiredIntentValue(row, revisionColumn),
		idempotencyKey: requiredIntentValue(row, "idempotency_key"),
	});
}

function preferredIntentEvidence(left: IntentRow, right: IntentRow): IntentRow {
	const conflict = intentRowConflict(left);
	const leftProvenance = requiredIntentValue(left, "provenance");
	const rightProvenance = requiredIntentValue(right, "provenance");
	const leftRank = MIGRATION_EVIDENCE_PROVENANCE_RANK.get(leftProvenance);
	const rightRank = MIGRATION_EVIDENCE_PROVENANCE_RANK.get(rightProvenance);
	if (leftRank === undefined || rightRank === undefined) throw new Error(conflict);
	if (leftRank !== rightRank) return leftRank < rightRank ? left : right;

	const leftFingerprint = left.values.source_fingerprint as string | null;
	const rightFingerprint = right.values.source_fingerprint as string | null;
	if (leftFingerprint !== rightFingerprint) {
		// The row-boundary provenance check makes this unreachable; retain the
		// guard so future provenance additions cannot weaken selection silently.
		if (leftFingerprint === null || rightFingerprint === null) throw new Error(conflict);
		return compareCodepoints(leftFingerprint, rightFingerprint) < 0 ? left : right;
	}

	const idempotencyOrder = compareCodepoints(
		requiredIntentValue(left, "idempotency_key"),
		requiredIntentValue(right, "idempotency_key"),
	);
	if (idempotencyOrder !== 0) return idempotencyOrder < 0 ? left : right;
	return compareCodepoints(intentEvidenceKey(left), intentEvidenceKey(right)) <= 0 ? left : right;
}

function mergeCompatibleIntentEvidence(left: IntentRow, right: IntentRow): IntentRow {
	const candidatesByEvidence = new Map<string, IntentRow>();
	for (const candidate of [...intentEvidenceCandidates(left), ...intentEvidenceCandidates(right)]) {
		candidatesByEvidence.set(intentEvidenceKey(candidate), candidate);
	}
	const candidates = [...candidatesByEvidence.values()];
	const preferred = candidates.reduce(preferredIntentEvidence);
	return {
		...preferred,
		compatibleEvidence: candidates.filter((candidate) => candidate !== preferred),
	};
}

function deduplicatePlan(plan: ProjectPlan): ProjectPlan {
	const rows = new Map<string, IntentRow>();
	for (const row of plan.rows) {
		assertAllowedRecipientPolicyIntentRow(row);
		const key = `${row.table}:${canonicalRecipientPolicyJson(row.key)}`;
		const existing = rows.get(key);
		if (existing) {
			if (
				INTENT_ROW_SCHEMAS[row.table].semanticColumns.some(
					(column) => existing.values[column] !== row.values[column],
				)
			) {
				throw new Error(intentRowConflict(row));
			}
		}
		// Keep one complete, valid authorization record rather than synthesizing
		// metadata that no source actually authorized. Automatic operation evidence
		// is stable across review churn; matching reviews use fingerprint then
		// idempotency-key order.
		rows.set(key, existing ? mergeCompatibleIntentEvidence(existing, row) : row);
	}
	const actors = new Map<string, ActorRow>();
	for (const actor of plan.actors) {
		const existing = actors.get(actor.actorId);
		if (existing && existing.displayName !== actor.displayName)
			throw new Error("identity_conflict");
		actors.set(actor.actorId, actor);
	}
	return { ...plan, rows: [...rows.values()], actors: [...actors.values()] };
}

function projectMigrationErrorCode(error: unknown): string | null {
	const allowed = new Set([
		"reviewed_project_set_digest_mismatch",
		"linked_identity_invalid",
		"review_decision_input_invalid",
		"review_recommendation_invalid",
		"review_recipient_stale",
		"review_decision_input_stale",
		"review_decision_unsupported",
		"review_preview_stale",
		"identity_conflict",
		"device_identity_conflict",
		"intent_conflict",
	]);
	const message = error instanceof Error ? error.message : "";
	if (allowed.has(message)) return message;
	if (message === "team_setup_assignment_changed") return "device_identity_conflict";
	return null;
}

function migrateProjectInTransaction(input: {
	db: Database;
	context: RecipientPolicyReviewContext;
	projection: LegacyRecipientPolicyProjectionV1;
	currentItems: RecipientPolicyActionableReviewItemV1[];
	resolutions: StoredResolution[];
	resolutionBySource: Map<string, StoredResolution>;
	compatibleDeviceEvidence: ReadonlyMap<string, IntentRow[]>;
	now: string;
	write: boolean;
}): RecipientPolicyMigrationProjectResultV1 {
	const {
		db,
		context,
		projection,
		currentItems,
		resolutions,
		resolutionBySource,
		compatibleDeviceEvidence,
		now,
		write,
	} = input;
	const projectId = projection.project.canonicalIdentity;
	const matchingResolutions = currentItems.map((item) =>
		resolutionBySource.get(`${item.reviewItemId}\u0000${item.sourceFingerprint}`),
	);
	if (matchingResolutions.some((resolution) => !resolution)) {
		const hasStaleResolution = currentItems.some((item) =>
			resolutions.some(
				(resolution) =>
					resolution.review_item_id === item.reviewItemId &&
					resolution.source_fingerprint !== item.sourceFingerprint,
			),
		);
		return {
			canonicalProjectIdentity: projectId,
			status: "skipped",
			writeCount: 0,
			idempotent: false,
			errorCode: hasStaleResolution ? "review_resolution_stale" : "review_resolution_missing",
		};
	}
	let plan: ProjectPlan = { rows: [], actors: [], hadApplicableEvidence: false };
	const preserveResolutions = matchingResolutions
		.map((resolution, index) => ({ resolution, currentItem: currentItems[index] }))
		.filter(
			(
				entry,
			): entry is {
				resolution: StoredResolution;
				currentItem: RecipientPolicyActionableReviewItemV1;
			} => entry.resolution?.decision === "preserve_current_access" && entry.currentItem != null,
		);
	for (const { resolution, currentItem } of preserveResolutions) {
		if (!currentItem.options.some((option) => option.decision === resolution.decision)) {
			throw new Error("review_decision_unsupported");
		}
		const reviewError = addReviewDecision(
			db,
			plan,
			projection,
			currentItem,
			resolution,
			context,
			now,
		);
		if (reviewError !== "review_preserves_legacy_access") {
			throw new Error(reviewError ?? "review_decision_unsupported");
		}
	}
	if (preserveResolutions.length > 0) {
		return {
			canonicalProjectIdentity: projectId,
			status: "skipped",
			writeCount: 0,
			idempotent: true,
			errorCode: "review_preserves_legacy_access",
		};
	}
	const operationError = addAutomaticOperationEvidence(
		db,
		plan,
		projection,
		context.localActorId,
		now,
	);
	if (operationError) throw new Error(operationError);
	for (const [index, resolution] of matchingResolutions.entries()) {
		if (!resolution) continue;
		const currentItem = currentItems[index];
		if (!currentItem?.options.some((option) => option.decision === resolution.decision)) {
			throw new Error("review_decision_unsupported");
		}
		const reviewError = addReviewDecision(
			db,
			plan,
			projection,
			currentItem,
			resolution,
			context,
			now,
		);
		if (reviewError) throw new Error(reviewError);
	}
	plan = deduplicatePlan(plan);
	if (!plan.hadApplicableEvidence) {
		return {
			canonicalProjectIdentity: projectId,
			status: "skipped",
			writeCount: 0,
			idempotent: false,
			errorCode: "migration_evidence_missing",
		};
	}
	let plannedWriteCount = 0;
	for (const actor of plan.actors) {
		if (validateOrWriteActor(db, actor, now, write)) plannedWriteCount += 1;
	}
	for (const row of plan.rows) {
		const changed =
			row.table === "identity_devices"
				? validateOrAssignIdentityDevice(db, row, write, compatibleDeviceEvidence)
				: validateOrWriteRow(db, row, write);
		if (changed) plannedWriteCount += 1;
	}
	return {
		canonicalProjectIdentity: projectId,
		status: plannedWriteCount === 0 ? "unchanged" : write ? "migrated" : "would_migrate",
		writeCount: write ? plannedWriteCount : 0,
		idempotent: plannedWriteCount === 0,
		errorCode: null,
	};
}

function migrateRecipientPolicyIntentInTransaction(
	db: Database,
	context: RecipientPolicyReviewContext,
	dryRun: boolean,
	now: string,
): RecipientPolicyMigrationResultV1 {
	const projections = listLegacyRecipientPolicyProjections(db, context);
	const reviewState = deriveRecipientPolicyReviewState(db, context, projections);
	const resolutions = db
		.prepare(
			`SELECT review_item_id, source_fingerprint, decision, decision_input_json, preview_json
			 FROM recipient_policy_review_resolutions ORDER BY resolved_at, review_item_id`,
		)
		.all() as StoredResolution[];
	const resolutionBySource = new Map(
		resolutions.map((resolution) => [
			`${resolution.review_item_id}\u0000${resolution.source_fingerprint}`,
			resolution,
		]),
	);
	const currentItemsByProject = new Map<string, RecipientPolicyActionableReviewItemV1[]>();
	for (const item of reviewState.allReviewItems) {
		const projectId = projectIdForReviewItem(item);
		if (!projectId) continue;
		const items = currentItemsByProject.get(projectId) ?? [];
		items.push(item);
		currentItemsByProject.set(projectId, items);
	}
	// This index depends only on the stable review snapshot, never on writes made
	// while individual Projects migrate below.
	const compatibleDeviceEvidence = collectCompatibleDeviceEvidence({
		db,
		context,
		projections,
		currentItemsByProject,
		resolutionBySource,
		now,
	});
	const results: RecipientPolicyMigrationProjectResultV1[] = [];
	for (const projection of projections) {
		const projectId = projection.project.canonicalIdentity;
		try {
			const migrateProject = db.transaction(() =>
				migrateProjectInTransaction({
					db,
					context,
					projection,
					currentItems: currentItemsByProject.get(projectId) ?? [],
					resolutions,
					resolutionBySource,
					compatibleDeviceEvidence,
					now,
					write: !dryRun,
				}),
			);
			results.push(migrateProject());
		} catch (error) {
			// Some SQLite failures abort the outer transaction, not only the
			// savepoint. Never continue in autocommit after losing authority.
			if (!db.inTransaction) throw error;
			const errorCode = projectMigrationErrorCode(error);
			if (!errorCode) throw error;
			results.push({
				canonicalProjectIdentity: projectId,
				status: "blocked",
				writeCount: 0,
				idempotent: false,
				errorCode,
			});
		}
	}
	return { version: RECIPIENT_POLICY_CONTRACT_VERSION, dryRun, results };
}

export function migrateRecipientPolicyIntent(
	db: Database,
	context: RecipientPolicyReviewContext,
	options: RecipientPolicyMigrationOptions = {},
): RecipientPolicyMigrationResultV1 {
	const dryRun = options.dryRun === true;
	const now = (context.now ?? (() => new Date().toISOString()))();
	const migrate = db.transaction(() =>
		migrateRecipientPolicyIntentInTransaction(db, context, dryRun, now),
	);
	return dryRun ? migrate.deferred() : migrate.immediate();
}
