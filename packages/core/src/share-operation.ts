import { createHash } from "node:crypto";
import type { Database } from "./db.js";

export const SHARE_HISTORY_POLICY = "existing_and_future" as const;
export const SHARE_OPERATION_STATE = "waiting_for_acceptance" as const;

export type SharePersonIntent =
	| { kind: "existing"; personId: string; displayName: string }
	| { kind: "pending"; personId?: string; displayName: string };

export interface ShareProjectIntent {
	canonicalIdentity: string;
	displayName: string;
	identitySource: string;
	existingMemoryCount: number;
}

export interface ShareOperationStep {
	stepKey: string;
	effectId: string;
	status: "pending" | "running" | "completed" | "failed";
	attemptCount: number;
	startedAt: string | null;
	completedAt: string | null;
	lastAttemptAt: string | null;
	safeErrorCode: string | null;
}

export interface ShareOperationPlan {
	operationId: string;
	state: typeof SHARE_OPERATION_STATE;
	inviterActorId: string;
	inviterDeviceIds: string[];
	personId: string;
	personKind: SharePersonIntent["kind"];
	teammateName: string;
	projects: ShareProjectIntent[];
	historyPolicy: typeof SHARE_HISTORY_POLICY;
	reviewedProjectSetDigest: string;
	coordinatorGroupId: string;
	inviteExpiresAt: string;
	createdAt: string;
	steps: ShareOperationStep[];
}

export interface PersistShareOperationInvite {
	inviteId: string | null;
	tokenDigest: string;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeTeammateName(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) throw new Error("teammate_name_required");
	if (normalized.length > 120) throw new Error("teammate_name_too_long");
	const hasControlCharacter = [...normalized].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
	if (hasControlCharacter) throw new Error("teammate_name_invalid");
	return normalized;
}

export function shareProjectSetDigest(projects: ShareProjectIntent[]): string {
	const reviewedProjects = projects
		.map((project) => ({
			canonicalIdentity: project.canonicalIdentity,
			existingMemoryCount: project.existingMemoryCount,
		}))
		.toSorted((left, right) => left.canonicalIdentity.localeCompare(right.canonicalIdentity));
	return digest({ v: 1, historyPolicy: SHARE_HISTORY_POLICY, projects: reviewedProjects });
}

function effect(operationId: string, step: string, identity?: string): string {
	return `share-effect:${digest([operationId, step, identity ?? null])}`;
}

function step(
	operationId: string,
	stepKey: string,
	createdAt: string,
	completed: boolean,
	identity?: string,
	effectId?: string,
): ShareOperationStep {
	return {
		stepKey,
		effectId: effectId ?? effect(operationId, stepKey, identity),
		status: completed ? "completed" : "pending",
		attemptCount: completed ? 1 : 0,
		startedAt: completed ? createdAt : null,
		completedAt: completed ? createdAt : null,
		lastAttemptAt: completed ? createdAt : null,
		safeErrorCode: null,
	};
}

function projectSteps(
	operationId: string,
	coordinatorGroupId: string,
	inviterDeviceIds: string[],
	projects: ShareProjectIntent[],
	createdAt: string,
): ShareOperationStep[] {
	// Executors must consume these persisted effect IDs rather than recompute them.
	// Membership epoch 1 is the initial grant identity for a new managed boundary.
	const initialMembershipEpoch = 1;
	return projects.flatMap((project) => {
		const boundaryId = `managed-project:${digest([coordinatorGroupId, project.canonicalIdentity])}`;
		const grants = inviterDeviceIds.map((deviceId) =>
			step(
				operationId,
				`space_grant:${project.canonicalIdentity}:${deviceId}`,
				createdAt,
				false,
				undefined,
				`space-grant:${digest([boundaryId, deviceId, initialMembershipEpoch])}`,
			),
		);
		return [
			step(
				operationId,
				`managed_boundary:${project.canonicalIdentity}`,
				createdAt,
				false,
				undefined,
				boundaryId,
			),
			...grants,
			step(operationId, `memory_reassignment:${project.canonicalIdentity}`, createdAt, false),
			step(
				operationId,
				`project_assignment:${project.canonicalIdentity}`,
				createdAt,
				false,
				boundaryId,
			),
		];
	});
}

export function planShareOperation(input: {
	inviterActorId: string;
	inviterDeviceIds: string[];
	person: SharePersonIntent;
	projects: ShareProjectIntent[];
	coordinatorGroupId: string;
	inviteExpiresAt: string;
	createdAt: string;
}): ShareOperationPlan {
	const teammateName = normalizeTeammateName(input.person.displayName);
	const inviterActorId = input.inviterActorId.trim();
	const coordinatorGroupId = input.coordinatorGroupId.trim();
	const inviterDeviceIds = [
		...new Set(input.inviterDeviceIds.map((id) => id.trim()).filter(Boolean)),
	].toSorted();
	if (!inviterActorId || inviterDeviceIds.length === 0 || !coordinatorGroupId) {
		throw new Error("share_operation_identity_required");
	}
	if (Number.isNaN(new Date(input.inviteExpiresAt).getTime()))
		throw new Error("invite_expiry_invalid");
	if (Number.isNaN(new Date(input.createdAt).getTime())) throw new Error("created_at_invalid");
	if (input.projects.length === 0) throw new Error("project_selection_empty");
	const projects = input.projects
		.map((project) => ({
			...project,
			canonicalIdentity: project.canonicalIdentity.trim(),
			displayName: project.displayName.trim(),
			identitySource: project.identitySource.trim(),
		}))
		.toSorted((left, right) => left.canonicalIdentity.localeCompare(right.canonicalIdentity));
	if (
		projects.some(
			(project) =>
				!project.canonicalIdentity ||
				!project.displayName ||
				!project.identitySource ||
				!Number.isSafeInteger(project.existingMemoryCount) ||
				project.existingMemoryCount < 0,
		)
	) {
		throw new Error("project_selection_invalid");
	}
	if (new Set(projects.map((project) => project.canonicalIdentity)).size !== projects.length) {
		throw new Error("project_selection_duplicate");
	}
	const reviewedProjectSetDigest = shareProjectSetDigest(projects);
	const personKey =
		input.person.kind === "existing"
			? input.person.personId.trim()
			: teammateName.toLocaleLowerCase("en-US");
	if (!personKey) throw new Error("person_id_required");
	const operationId = `share_${digest({
		v: 1,
		coordinatorGroupId,
		inviterActorId,
		inviterDeviceIds,
		personKey,
		reviewedProjectSetDigest,
	}).slice(0, 40)}`;
	const personId =
		input.person.kind === "existing"
			? personKey
			: input.person.personId?.trim() ||
				`pending_${digest([operationId, teammateName]).slice(0, 40)}`;
	const steps = [
		step(operationId, "pending_person", input.createdAt, true),
		step(operationId, "invite_creation", input.createdAt, true),
		step(operationId, "invite_consumption", input.createdAt, false),
		step(operationId, "person_device_link", input.createdAt, false),
		...projectSteps(operationId, coordinatorGroupId, inviterDeviceIds, projects, input.createdAt),
		step(operationId, "initial_sync", input.createdAt, false),
	];
	return {
		operationId,
		state: SHARE_OPERATION_STATE,
		inviterActorId,
		inviterDeviceIds,
		personId,
		personKind: input.person.kind,
		teammateName,
		projects,
		historyPolicy: SHARE_HISTORY_POLICY,
		reviewedProjectSetDigest,
		coordinatorGroupId,
		inviteExpiresAt: new Date(input.inviteExpiresAt).toISOString(),
		createdAt: new Date(input.createdAt).toISOString(),
		steps,
	};
}

export function inviteTokenDigest(token: string): string {
	const normalized = token.trim();
	if (!normalized) throw new Error("invite_token_required");
	return digest(normalized);
}

export function persistShareOperation(
	db: Database,
	plan: ShareOperationPlan,
	invite: PersistShareOperationInvite,
): void {
	const save = db.transaction(() => {
		const existing = db
			.prepare(
				`SELECT state, inviter_actor_id, inviter_device_ids_json, person_id, person_kind,
					pending_person_operation_id, teammate_name, history_policy,
					reviewed_project_set_digest, coordinator_group_id, coordinator_invite_id,
					invite_token_digest, invite_expires_at, created_at, updated_at
				 FROM share_operations WHERE operation_id = ?`,
			)
			.get(plan.operationId) as
			| {
					state: string;
					inviter_actor_id: string;
					inviter_device_ids_json: string;
					person_id: string;
					person_kind: string;
					pending_person_operation_id: string | null;
					teammate_name: string;
					history_policy: string;
					reviewed_project_set_digest: string;
					coordinator_group_id: string;
					invite_token_digest: string;
					coordinator_invite_id: string | null;
					invite_expires_at: string;
					created_at: string;
					updated_at: string;
			  }
			| undefined;
		if (existing) {
			const savedProjects = db
				.prepare(
					`SELECT canonical_project_identity, display_name, identity_source,
						existing_memory_count, ordinal
					 FROM share_operation_projects WHERE operation_id = ? ORDER BY ordinal`,
				)
				.all(plan.operationId) as Array<{
				canonical_project_identity: string;
				display_name: string;
				identity_source: string;
				existing_memory_count: number;
				ordinal: number;
			}>;
			const expectedProjects = plan.projects.map((project, ordinal) => ({
				canonical_project_identity: project.canonicalIdentity,
				display_name: project.displayName,
				identity_source: project.identitySource,
				existing_memory_count: project.existingMemoryCount,
				ordinal,
			}));
			if (
				existing.state !== plan.state ||
				existing.inviter_actor_id !== plan.inviterActorId ||
				existing.inviter_device_ids_json !== JSON.stringify(plan.inviterDeviceIds) ||
				existing.person_id !== plan.personId ||
				existing.person_kind !== plan.personKind ||
				existing.pending_person_operation_id !==
					(plan.personKind === "pending" ? plan.operationId : null) ||
				existing.teammate_name !== plan.teammateName ||
				existing.history_policy !== plan.historyPolicy ||
				existing.reviewed_project_set_digest !== plan.reviewedProjectSetDigest ||
				existing.coordinator_group_id !== plan.coordinatorGroupId ||
				JSON.stringify(savedProjects) !== JSON.stringify(expectedProjects)
			) {
				throw new Error("share_operation_intent_conflict");
			}
			const sameInvite =
				existing.coordinator_invite_id === invite.inviteId &&
				existing.invite_token_digest === invite.tokenDigest &&
				existing.invite_expires_at === plan.inviteExpiresAt;
			if (sameInvite) return;
			const canReissue =
				existing.coordinator_invite_id === invite.inviteId &&
				existing.invite_token_digest !== invite.tokenDigest &&
				existing.invite_expires_at !== plan.inviteExpiresAt;
			if (!canReissue) throw new Error("share_operation_intent_conflict");
			db.prepare(`UPDATE share_operations
				SET invite_token_digest = ?, invite_expires_at = ?, updated_at = ?
				WHERE operation_id = ? AND state = 'waiting_for_acceptance'`).run(
				invite.tokenDigest,
				plan.inviteExpiresAt,
				plan.createdAt,
				plan.operationId,
			);
			return;
		}
		if (plan.personKind === "pending") {
			db.prepare(
				`INSERT OR IGNORE INTO actors(
					actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
				 ) VALUES (?, ?, 0, 'pending', NULL, ?, ?)`,
			).run(plan.personId, plan.teammateName, plan.createdAt, plan.createdAt);
		}
		db.prepare(
			`INSERT INTO share_operations(
				operation_id, state, inviter_actor_id, inviter_device_ids_json,
				person_id, person_kind, pending_person_operation_id, teammate_name, history_policy,
				reviewed_project_set_digest, coordinator_group_id, coordinator_invite_id,
				invite_token_digest, invite_expires_at, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			plan.operationId,
			plan.state,
			plan.inviterActorId,
			JSON.stringify(plan.inviterDeviceIds),
			plan.personId,
			plan.personKind,
			plan.personKind === "pending" ? plan.operationId : null,
			plan.teammateName,
			plan.historyPolicy,
			plan.reviewedProjectSetDigest,
			plan.coordinatorGroupId,
			invite.inviteId,
			invite.tokenDigest,
			plan.inviteExpiresAt,
			plan.createdAt,
			plan.createdAt,
		);
		const projectStatement = db.prepare(
			`INSERT INTO share_operation_projects(
				operation_id, canonical_project_identity, display_name, identity_source,
				existing_memory_count, ordinal
			 ) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		plan.projects.forEach((project, index) => {
			projectStatement.run(
				plan.operationId,
				project.canonicalIdentity,
				project.displayName,
				project.identitySource,
				project.existingMemoryCount,
				index,
			);
		});
		const stepStatement = db.prepare(
			`INSERT INTO share_operation_steps(
				operation_id, step_key, effect_id, status, attempt_count, started_at,
				completed_at, last_attempt_at, safe_error_code, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		plan.steps.forEach((item) => {
			stepStatement.run(
				plan.operationId,
				item.stepKey,
				item.effectId,
				item.status,
				item.attemptCount,
				item.startedAt,
				item.completedAt,
				item.lastAttemptAt,
				item.safeErrorCode,
				plan.createdAt,
			);
		});
	});
	save();
}
