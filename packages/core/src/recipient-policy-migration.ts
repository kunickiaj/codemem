import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import {
	type LegacyRecipientPolicyProjectionV1,
	listLegacyRecipientPolicyProjections,
} from "./legacy-recipient-policy-projection.js";
import { RECIPIENT_POLICY_CONTRACT_VERSION } from "./recipient-policy-contract.js";
import type {
	RecipientPolicyActionableReviewItemV1,
	RecipientPolicyReviewContext,
} from "./recipient-policy-review.js";
import { deriveRecipientPolicyReviewState } from "./recipient-policy-review.js";
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
	table: "policy_teams" | "policy_team_memberships" | "identity_devices" | "project_recipients";
	key: Record<string, string>;
	values: Record<string, string | null>;
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

const NO_OP_DECISIONS = new Set([
	"keep_current_setup",
	"reject_suggestion",
	"keep_project_local",
	"keep_identities_separate",
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

export function deterministicPolicyTeamId(teamCandidateId: string): string {
	return digest("policy-team-v1", teamCandidateId);
}

function relationshipMetadata(
	kind: string,
	identity: unknown,
): {
	revision: string;
	idempotencyKey: string;
} {
	return {
		revision: digest(`recipient-policy-${kind}-revision-v1`, identity),
		idempotencyKey: digest(`recipient-policy-${kind}-idempotency-v1`, identity),
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
	const metadata = relationshipMetadata("project-recipient", identity);
	const values = baseValues({
		provenance: input.provenance,
		revision: metadata.revision,
		idempotencyKey: metadata.idempotencyKey,
		sourceFingerprint: input.sourceFingerprint,
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
	const metadata = relationshipMetadata("identity-device", [input.deviceId, input.identityId]);
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
				sourceFingerprint: input.sourceFingerprint,
				now: input.now,
			}),
		},
	};
}

function teamRows(input: {
	projectId: string;
	teamCandidateId: string;
	displayName: string;
	members: string[];
	sourceFingerprint: string;
	now: string;
}): IntentRow[] {
	const teamId = deterministicPolicyTeamId(input.teamCandidateId);
	const teamMetadata = relationshipMetadata("team", teamId);
	const rows: IntentRow[] = [
		{
			table: "policy_teams",
			key: { team_id: teamId },
			values: {
				display_name: input.displayName,
				...baseValues({
					provenance: "reviewed_team_candidate",
					revision: teamMetadata.revision,
					idempotencyKey: teamMetadata.idempotencyKey,
					sourceFingerprint: input.sourceFingerprint,
					now: input.now,
				}),
			},
		},
	];
	for (const identityId of input.members.toSorted()) {
		const metadata = relationshipMetadata("team-membership", [teamId, identityId]);
		rows.push({
			table: "policy_team_memberships",
			key: { team_id: teamId, identity_id: identityId },
			values: {
				role: "member",
				...baseValues({
					provenance: "reviewed_team_candidate",
					revision: metadata.revision,
					idempotencyKey: metadata.idempotencyKey,
					sourceFingerprint: input.sourceFingerprint,
					now: input.now,
				}),
			},
		});
	}
	rows.push(
		projectRecipientRow({
			projectId: input.projectId,
			recipientKind: "team",
			recipientId: teamId,
			provenance: "reviewed_team_candidate",
			sourceFingerprint: input.sourceFingerprint,
			now: input.now,
		}),
	);
	return rows;
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

function assignedIdentityIdsFromPreview(value: unknown): string[] | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const preview = value as Record<string, unknown>;
	if (!Array.isArray(preview.effectiveDevices)) return null;
	const identityIds = new Set<string>();
	for (const value of preview.effectiveDevices) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const device = value as Record<string, unknown>;
		if (device.assignment === "assigned" && typeof device.identityId === "string") {
			identityIds.add(device.identityId);
		}
	}
	return [...identityIds].toSorted();
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
		canonicalJson(reviewedPreview) !== canonicalJson(currentOption.preview)
	) {
		return "review_preview_stale";
	}
	if (resolution.decision === "preserve_current_access") {
		return "review_preserves_legacy_access";
	}
	if (NO_OP_DECISIONS.has(resolution.decision)) return null;
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
		const identities = new Map(
			projection.identityCandidates.map((candidate) => [candidate.identityId, candidate]),
		);
		const teams = new Map(
			projection.teamCandidates.map((candidate) => [candidate.teamCandidateId, candidate]),
		);
		const reviewedAssignedMembers = assignedIdentityIdsFromPreview(currentOption.preview);
		if (!reviewedAssignedMembers) return "review_preview_stale";
		for (const recipientId of recipientIds as string[]) {
			if (identities.has(recipientId)) {
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
			const team = teams.get(recipientId);
			if (!team) return "review_recipient_stale";
			plan.rows.push(
				...teamRows({
					projectId: projection.project.canonicalIdentity,
					teamCandidateId: team.teamCandidateId,
					displayName: team.displayName,
					members: reviewedAssignedMembers,
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

function rowWhere(key: Record<string, string>): { clause: string; parameters: string[] } {
	const entries = Object.entries(key);
	return {
		clause: entries.map(([column]) => `${column} = ?`).join(" AND "),
		parameters: entries.map(([, value]) => value),
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

function validateOrWriteRow(db: Database, row: IntentRow, write: boolean): boolean {
	const where = rowWhere(row.key);
	const existing = db
		.prepare(`SELECT * FROM ${row.table} WHERE ${where.clause}`)
		.get(...where.parameters) as Record<string, unknown> | undefined;
	if (existing) {
		const relationshipColumns =
			row.table === "identity_devices"
				? ["identity_id", "status", "revision"]
				: row.table === "project_recipients"
					? ["status", "policy_revision"]
					: row.table === "policy_team_memberships"
						? ["role", "status", "revision"]
						: ["status", "revision"];
		if (relationshipColumns.some((column) => existing[column] !== row.values[column])) {
			throw new Error(
				row.table === "identity_devices" ? "device_identity_conflict" : "intent_conflict",
			);
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

function deduplicatePlan(plan: ProjectPlan): ProjectPlan {
	const rows = new Map<string, IntentRow>();
	for (const row of plan.rows) {
		const key = `${row.table}:${canonicalJson(row.key)}`;
		const existing = rows.get(key);
		if (existing) {
			const relationshipColumns =
				row.table === "identity_devices"
					? ["identity_id", "status", "revision"]
					: row.table === "project_recipients"
						? ["status", "policy_revision"]
						: row.table === "policy_team_memberships"
							? ["role", "status", "revision"]
							: ["status", "revision"];
			if (relationshipColumns.some((column) => existing.values[column] !== row.values[column])) {
				throw new Error(
					row.table === "identity_devices" ? "device_identity_conflict" : "intent_conflict",
				);
			}
		}
		rows.set(key, existing ?? row);
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

function safeMigrationErrorCode(error: unknown): string {
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
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: "";
	if (code === "SQLITE_BUSY") return "migration_busy";
	if (code.startsWith("SQLITE_CONSTRAINT")) return "intent_conflict";
	return "migration_failed";
}

export function migrateRecipientPolicyIntent(
	db: Database,
	context: RecipientPolicyReviewContext,
	options: RecipientPolicyMigrationOptions = {},
): RecipientPolicyMigrationResultV1 {
	const dryRun = options.dryRun === true;
	const now = (context.now ?? (() => new Date().toISOString()))();
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
	const currentItemsByProject = new Map<string, typeof reviewState.allReviewItems>();
	for (const item of reviewState.allReviewItems) {
		const projectId = projectIdForReviewItem(item);
		if (!projectId) continue;
		const items = currentItemsByProject.get(projectId) ?? [];
		items.push(item);
		currentItemsByProject.set(projectId, items);
	}
	const results: RecipientPolicyMigrationProjectResultV1[] = [];
	for (const projection of projections) {
		const projectId = projection.project.canonicalIdentity;
		const currentItems = currentItemsByProject.get(projectId) ?? [];
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
			results.push({
				canonicalProjectIdentity: projectId,
				status: "skipped",
				writeCount: 0,
				idempotent: false,
				errorCode: hasStaleResolution ? "review_resolution_stale" : "review_resolution_missing",
			});
			continue;
		}
		try {
			let plan: ProjectPlan = { rows: [], actors: [], hadApplicableEvidence: false };
			const preserveResolutions = matchingResolutions
				.map((resolution, index) => ({ resolution, currentItem: currentItems[index] }))
				.filter(
					(
						entry,
					): entry is {
						resolution: StoredResolution;
						currentItem: RecipientPolicyActionableReviewItemV1;
					} =>
						entry.resolution?.decision === "preserve_current_access" && entry.currentItem != null,
				);
			for (const { resolution, currentItem } of preserveResolutions) {
				if (!currentItem.options.some((option) => option.decision === resolution.decision)) {
					throw new Error("review_decision_unsupported");
				}
				const reviewError = addReviewDecision(db, plan, projection, currentItem, resolution, now);
				if (reviewError !== "review_preserves_legacy_access") {
					throw new Error(reviewError ?? "review_decision_unsupported");
				}
			}
			if (preserveResolutions.length > 0) {
				results.push({
					canonicalProjectIdentity: projectId,
					status: "skipped",
					writeCount: 0,
					idempotent: true,
					errorCode: "review_preserves_legacy_access",
				});
				continue;
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
				const reviewError = addReviewDecision(db, plan, projection, currentItem, resolution, now);
				if (reviewError) throw new Error(reviewError);
			}
			plan = deduplicatePlan(plan);
			if (!plan.hadApplicableEvidence) {
				results.push({
					canonicalProjectIdentity: projectId,
					status: "skipped",
					writeCount: 0,
					idempotent: false,
					errorCode: "migration_evidence_missing",
				});
				continue;
			}
			let plannedWriteCount = 0;
			const apply = (write: boolean) => {
				for (const actor of plan.actors) {
					if (validateOrWriteActor(db, actor, now, write)) plannedWriteCount += 1;
				}
				for (const row of plan.rows) {
					if (validateOrWriteRow(db, row, write)) plannedWriteCount += 1;
				}
			};
			if (dryRun) apply(false);
			else db.transaction(() => apply(true)).immediate();
			results.push({
				canonicalProjectIdentity: projectId,
				status: plannedWriteCount === 0 ? "unchanged" : dryRun ? "would_migrate" : "migrated",
				writeCount: dryRun ? 0 : plannedWriteCount,
				idempotent: plannedWriteCount === 0,
				errorCode: null,
			});
		} catch (error) {
			results.push({
				canonicalProjectIdentity: projectId,
				status: "blocked",
				writeCount: 0,
				idempotent: false,
				errorCode: safeMigrationErrorCode(error),
			});
		}
	}
	return { version: RECIPIENT_POLICY_CONTRACT_VERSION, dryRun, results };
}
