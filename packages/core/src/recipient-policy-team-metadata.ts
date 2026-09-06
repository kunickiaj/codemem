import type { Database } from "./db.js";
import { normalizeHumanPresentationName } from "./project-invite-identity.js";
import {
	deterministicPolicyTeamId,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";

export type RecipientPolicyTeamRenameErrorCode =
	| "team_name_invalid"
	| "team_not_found"
	| "team_rename_stale"
	| "team_link_stale"
	| "team_link_ambiguous"
	| "team_coordinator_rename_failed"
	| "team_local_rename_pending"
	| "team_rename_failed";

export class RecipientPolicyTeamRenameError extends Error {
	constructor(readonly code: RecipientPolicyTeamRenameErrorCode) {
		super(code);
		this.name = "RecipientPolicyTeamRenameError";
	}
}

export interface ConfiguredCoordinatorGroupV1 {
	coordinatorId: string;
	groupId: string;
}

export interface RecipientPolicyTeamRenameResultV1 {
	version: 1;
	teamId: string;
	displayName: string;
	revision: string;
	linkedCoordinatorGroupRenamed: boolean;
}

interface TeamRow {
	team_id: string;
	display_name: string;
	status: string;
	revision: string;
}

interface LinkRow {
	attempt_id: string;
	candidate_id: string;
	coordinator_id: string;
	group_id: string;
}

interface ActiveTeamLinkRow extends LinkRow {
	completed_team_id: string;
}

interface ProvenCoordinatorLink {
	group: ConfiguredCoordinatorGroupV1;
	attempts: Array<{
		attemptId: string;
		candidateId: string;
		coordinatorId: string;
		groupId: string;
	}>;
}

// Keep exact Team identities as the serialization boundary. Coordinator URL
// equivalence is limited to historical-link evidence and never changes queue keys.
const teamRenameQueues = new WeakMap<Database, Map<string, Promise<void>>>();
const coordinatorGroupMutationQueues = new WeakMap<Database, Map<string, Promise<void>>>();
const actorMutationQueues = new WeakMap<Database, Map<string, Promise<void>>>();
const publicationMutationQueues = new WeakMap<Database, Map<string, Promise<void>>>();
const PUBLICATION_MUTATION_KEY = "recipient-policy-publication";

function fail(code: RecipientPolicyTeamRenameErrorCode): never {
	throw new RecipientPolicyTeamRenameError(code);
}

function name(value: string): string {
	try {
		return normalizeHumanPresentationName(value, "display_name");
	} catch {
		return fail("team_name_invalid");
	}
}

function linkedGroup(
	db: Database,
	teamId: string,
	configured: readonly ConfiguredCoordinatorGroupV1[],
	coordinatorIdsEquivalent?: (left: string, right: string) => boolean,
): ProvenCoordinatorLink | null {
	const rows = db
		.prepare(
			`SELECT DISTINCT draft.attempt_id, draft.candidate_id, draft.coordinator_id, draft.group_id
			 FROM legacy_team_setup_drafts AS draft
			 JOIN legacy_team_setup_completions AS completion
			   ON completion.attempt_id = draft.attempt_id
			  AND completion.finish_digest = draft.finish_digest
			  AND completion.candidate_ref = draft.candidate_id
			  AND completion.completed_team_id = draft.completed_team_id
			 WHERE draft.state = 'completed' AND draft.completed_team_id = ?
			 ORDER BY draft.attempt_id`,
		)
		.all(teamId) as LinkRow[];
	const completedLinks = rows.filter(
		(row) => deterministicPolicyTeamId(row.candidate_id) === teamId,
	);
	const first = completedLinks[0];
	if (!first) return null;
	const equivalent = (left: string, right: string): boolean => {
		if (left === right) return true;
		try {
			return coordinatorIdsEquivalent?.(left, right) === true;
		} catch {
			return false;
		}
	};
	const equivalentOrConflict = (left: string, right: string): boolean => {
		if (left === right) return true;
		if (!coordinatorIdsEquivalent) return false;
		try {
			return coordinatorIdsEquivalent(left, right);
		} catch {
			return true;
		}
	};
	if (
		completedLinks.some(
			(row) =>
				row.group_id !== first.group_id || !equivalent(row.coordinator_id, first.coordinator_id),
		)
	) {
		fail("team_link_ambiguous");
	}
	const matchesConfiguredGroup = configured.some(
		(item) =>
			item.groupId === first.group_id && equivalent(item.coordinatorId, first.coordinator_id),
	);
	if (!matchesConfiguredGroup) fail("team_link_stale");
	const conflictingLinks = db
		.prepare(
			`SELECT DISTINCT draft.attempt_id, draft.candidate_id, draft.coordinator_id,
			        draft.group_id, draft.completed_team_id
			 FROM legacy_team_setup_drafts AS draft
			 JOIN legacy_team_setup_completions AS completion
			   ON completion.attempt_id = draft.attempt_id
			  AND completion.finish_digest = draft.finish_digest
			  AND completion.candidate_ref = draft.candidate_id
			  AND completion.completed_team_id = draft.completed_team_id
			 JOIN policy_teams AS team
			   ON team.team_id = draft.completed_team_id
			  AND team.status = 'active'
			 WHERE draft.state = 'completed'
			   AND draft.completed_team_id <> ?
			   AND draft.group_id = ?
			 ORDER BY draft.completed_team_id, draft.attempt_id`,
		)
		.all(teamId, first.group_id) as ActiveTeamLinkRow[];
	if (
		conflictingLinks.some(
			(row) =>
				deterministicPolicyTeamId(row.candidate_id) === row.completed_team_id &&
				equivalentOrConflict(row.coordinator_id, first.coordinator_id),
		)
	) {
		fail("team_link_ambiguous");
	}
	return {
		group: { coordinatorId: first.coordinator_id, groupId: first.group_id },
		attempts: completedLinks.map((row) => ({
			attemptId: row.attempt_id,
			candidateId: row.candidate_id,
			coordinatorId: row.coordinator_id,
			groupId: row.group_id,
		})),
	};
}

async function renameLinkedCoordinatorGroup(
	rename: (group: ConfiguredCoordinatorGroupV1, displayName: string) => Promise<boolean>,
	link: ConfiguredCoordinatorGroupV1,
	displayName: string,
): Promise<void> {
	let renamed = false;
	try {
		renamed = await rename(link, displayName);
	} catch {
		fail("team_coordinator_rename_failed");
	}
	if (!renamed) fail("team_coordinator_rename_failed");
}

export const RECIPIENT_POLICY_TEAM_RENAME_REVISION_DOMAIN = "policy-team-metadata-rename-v1";

/** A Team revision minted by `renameRecipientPolicyTeam` rather than by an activation. */
export function isRecipientPolicyTeamRenameRevision(revision: string): boolean {
	return revision.startsWith(`${RECIPIENT_POLICY_TEAM_RENAME_REVISION_DOMAIN}:`);
}

async function serializeMutation<T>(
	queues: WeakMap<Database, Map<string, Promise<void>>>,
	db: Database,
	key: string,
	operation: () => Promise<T>,
): Promise<T> {
	const release = await claimMutation(queues, db, key);
	try {
		return await operation();
	} finally {
		release();
	}
}

async function claimMutation(
	queues: WeakMap<Database, Map<string, Promise<void>>>,
	db: Database,
	key: string,
): Promise<() => void> {
	let queue = queues.get(db);
	if (!queue) {
		queue = new Map();
		queues.set(db, queue);
	}
	const preceding = queue.get(key) ?? Promise.resolve();
	let release: () => void = () => undefined;
	const turn = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = preceding.catch(() => undefined).then(() => turn);
	queue.set(key, queued);
	await preceding.catch(() => undefined);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		release();
		if (queue.get(key) === queued) queue.delete(key);
	};
}

export function serializeRecipientPolicyTeamMutation<T>(
	db: Database,
	teamId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return serializeMutation(teamRenameQueues, db, teamId, operation);
}

export function serializeRecipientPolicyActorMutations<T>(
	db: Database,
	actorIds: readonly string[],
	operation: () => Promise<T>,
): Promise<T> {
	const orderedActorIds = [...new Set(actorIds)].toSorted();
	const serializeNext = (index: number): Promise<T> => {
		const actorId = orderedActorIds[index];
		if (!actorId) return operation();
		return serializeMutation(actorMutationQueues, db, actorId, () => serializeNext(index + 1));
	};
	return serializeNext(0);
}

export async function claimRecipientPolicyActorMutations(
	db: Database,
	actorIds: readonly string[],
): Promise<() => void> {
	const releases: Array<() => void> = [];
	for (const actorId of [...new Set(actorIds)].toSorted()) {
		releases.push(await claimMutation(actorMutationQueues, db, actorId));
	}
	return () => {
		for (const release of releases.toReversed()) release();
	};
}

// Lock order is candidate claim -> publication -> actor -> Team -> coordinator group.
// Callers that need lower-level locks must acquire this barrier first.
export function serializeRecipientPolicyPublicationMutation<T>(
	db: Database,
	operation: () => Promise<T>,
): Promise<T> {
	return serializeMutation(publicationMutationQueues, db, PUBLICATION_MUTATION_KEY, operation);
}

export function claimRecipientPolicyPublicationMutation(db: Database): Promise<() => void> {
	return claimMutation(publicationMutationQueues, db, PUBLICATION_MUTATION_KEY);
}

// This deliberately uses the exact group ID as a coarse serialization key.
// Coordinator URL equivalence remains matching-only, while equivalent URL
// spellings for the same group cannot activate during a linked Team rename.
export function serializeRecipientPolicyCoordinatorGroupMutation<T>(
	db: Database,
	groupId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return serializeMutation(coordinatorGroupMutationQueues, db, groupId, operation);
}

async function renameRecipientPolicyTeamOnce(
	db: Database,
	input: {
		teamId: string;
		displayName: string;
		expectedDisplayName: string;
		configuredCoordinatorGroups: readonly ConfiguredCoordinatorGroupV1[];
		coordinatorIdsEquivalent?: (left: string, right: string) => boolean;
		renameCoordinatorGroup: (
			group: ConfiguredCoordinatorGroupV1,
			displayName: string,
		) => Promise<boolean>;
		now?: string;
	},
	coordinatorGroupSerialized = false,
): Promise<RecipientPolicyTeamRenameResultV1> {
	const displayName = name(input.displayName);
	const team = db
		.prepare("SELECT team_id, display_name, status, revision FROM policy_teams WHERE team_id = ?")
		.get(input.teamId) as TeamRow | undefined;
	if (team?.status !== "active") fail("team_not_found");
	const link = linkedGroup(
		db,
		team.team_id,
		input.configuredCoordinatorGroups,
		input.coordinatorIdsEquivalent,
	);
	if (link && !coordinatorGroupSerialized) {
		return serializeRecipientPolicyCoordinatorGroupMutation(db, link.group.groupId, () =>
			renameRecipientPolicyTeamOnce(db, input, true),
		);
	}
	if (team.display_name === displayName) {
		if (link) {
			await renameLinkedCoordinatorGroup(input.renameCoordinatorGroup, link.group, displayName);
			if (
				!linkedGroup(
					db,
					team.team_id,
					input.configuredCoordinatorGroups,
					input.coordinatorIdsEquivalent,
				)
			) {
				fail("team_link_stale");
			}
		}
		return {
			version: 1,
			teamId: team.team_id,
			displayName,
			revision: team.revision,
			linkedCoordinatorGroupRenamed: link !== null,
		};
	}
	if (team.display_name !== input.expectedDisplayName) fail("team_rename_stale");

	let currentLink = link;
	if (currentLink) {
		await renameLinkedCoordinatorGroup(
			input.renameCoordinatorGroup,
			currentLink.group,
			displayName,
		);
		currentLink = linkedGroup(
			db,
			team.team_id,
			input.configuredCoordinatorGroups,
			input.coordinatorIdsEquivalent,
		);
		if (!currentLink) fail("team_link_stale");
	}

	const now = input.now ?? new Date().toISOString();
	const revision = recipientPolicyDigest(RECIPIENT_POLICY_TEAM_RENAME_REVISION_DOMAIN, [
		team.team_id,
		team.revision,
		displayName,
	]);
	const update = db.transaction(() => {
		const changed = db
			.prepare(
				`UPDATE policy_teams SET display_name = ?, revision = ?, updated_at = ?
				 WHERE team_id = ? AND status = 'active' AND revision = ? AND display_name = ?`,
			)
			.run(displayName, revision, now, team.team_id, team.revision, team.display_name);
		if (changed.changes !== 1) fail("team_rename_stale");
		if (currentLink) {
			// Every completed attempt for this proven Team/coordinator/group represents
			// the same historical setup label. Preserve its exact stored coordinator ID.
			const updateDraft = db.prepare(
				`UPDATE legacy_team_setup_drafts SET display_name = ?, updated_at = ?
				 WHERE attempt_id = ? AND state = 'completed' AND completed_team_id = ?
				   AND coordinator_id = ? AND group_id = ?`,
			);
			for (const attempt of currentLink.attempts) {
				const changedDraft = updateDraft.run(
					displayName,
					now,
					attempt.attemptId,
					team.team_id,
					attempt.coordinatorId,
					attempt.groupId,
				);
				if (changedDraft.changes !== 1) fail("team_rename_stale");
			}
			const updateUnfinishedDrafts = db.prepare(
				`UPDATE legacy_team_setup_drafts SET display_name = ?, updated_at = ?
				 WHERE candidate_id = ? AND state IN ('needs_setup', 'in_progress')`,
			);
			for (const candidateId of new Set(
				currentLink.attempts.map((attempt) => attempt.candidateId),
			)) {
				updateUnfinishedDrafts.run(displayName, now, candidateId);
			}
		}
	});
	try {
		update();
	} catch (error) {
		if (error instanceof RecipientPolicyTeamRenameError) throw error;
		fail(currentLink ? "team_local_rename_pending" : "team_rename_failed");
	}
	return {
		version: 1,
		teamId: team.team_id,
		displayName,
		revision,
		linkedCoordinatorGroupRenamed: link !== null,
	};
}

export function renameRecipientPolicyTeam(
	db: Database,
	input: Parameters<typeof renameRecipientPolicyTeamOnce>[1],
): Promise<RecipientPolicyTeamRenameResultV1> {
	return serializeRecipientPolicyTeamMutation(db, input.teamId, () =>
		renameRecipientPolicyTeamOnce(db, input),
	);
}
