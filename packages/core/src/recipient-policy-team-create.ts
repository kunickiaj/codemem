import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { normalizeHumanPresentationName } from "./project-invite-identity.js";
import type {
	RecipientPolicyTeamCreateErrorCode,
	RecipientPolicyTeamCreateResultV1,
} from "./recipient-policy-contract.js";
import { recipientPolicyDigest } from "./recipient-policy-identifiers.js";
import { recordTeamCoordinatorLink } from "./team-member-removal-lookup.js";

export {
	RECIPIENT_POLICY_TEAM_CREATE_ERROR_CODES,
	type RecipientPolicyTeamCreateErrorCode,
	type RecipientPolicyTeamCreateResultV1,
} from "./recipient-policy-contract.js";

export class RecipientPolicyTeamCreateError extends Error {
	constructor(readonly code: RecipientPolicyTeamCreateErrorCode) {
		super(code);
		this.name = "RecipientPolicyTeamCreateError";
	}
}

export interface CreateRecipientPolicyTeamInput {
	displayName: string;
	/** The Identity creating the Team. It becomes the Team's first admin member. */
	creatorIdentityId: string;
	now: string;
	/** Tests pass a fixed ID; production generates one. */
	teamId?: string;
	/**
	 * The coordinator group the Team's invitations go through. Recorded as the
	 * Team's group, where removals of its members are recorded.
	 */
	coordinatorGroup?: { coordinatorId: string; groupId: string };
}

const PROVENANCE = "sharing_create";

function teamName(value: string): string {
	try {
		return normalizeHumanPresentationName(value, "display_name");
	} catch {
		throw new RecipientPolicyTeamCreateError("team_name_invalid");
	}
}

/** The creator must be this device's own active person. */
function assertCreatorActive(db: Database, identityId: string): void {
	const creator = db
		.prepare("SELECT status, is_local, merged_into_actor_id FROM actors WHERE actor_id = ?")
		.get(identityId) as
		| { status: string; is_local: number; merged_into_actor_id: string | null }
		| undefined;
	if (creator?.status !== "active" || creator.is_local !== 1 || creator.merged_into_actor_id) {
		throw new RecipientPolicyTeamCreateError("team_creator_unavailable");
	}
}

// SQLite lower() folds only ASCII, so names are compared here with Unicode case rules.
function nameKey(value: string): string {
	return value.normalize("NFC").toLowerCase();
}

function assertNameAvailable(db: Database, displayName: string): void {
	const activeNames = db
		.prepare("SELECT display_name FROM policy_teams WHERE status = 'active'")
		.pluck()
		.all() as string[];
	const key = nameKey(displayName);
	if (activeNames.some((name) => nameKey(name) === key)) {
		throw new RecipientPolicyTeamCreateError("team_name_taken");
	}
}

function insertTeam(
	db: Database,
	teamId: string,
	displayName: string,
	creatorIdentityId: string,
	now: string,
): void {
	const team = { teamId, displayName };
	db.prepare(
		`INSERT INTO policy_teams(
		 team_id, display_name, status, device_eligibility_mode, provenance, revision,
		 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
		 ) VALUES (?, ?, 'active', 'person_all_devices', ?, ?, 'user_managed', NULL, ?, ?, ?)`,
	).run(
		teamId,
		displayName,
		PROVENANCE,
		recipientPolicyDigest("recipient-policy-team-create-revision-v1", team),
		recipientPolicyDigest("recipient-policy-team-create-idempotency-v1", { teamId }),
		now,
		now,
	);
	const membership = { teamId, identityId: creatorIdentityId };
	db.prepare(
		`INSERT INTO policy_team_memberships(
		 team_id, identity_id, role, status, provenance, revision, migration_state,
		 source_fingerprint, idempotency_key, created_at, updated_at
		 ) VALUES (?, ?, 'admin', 'active', ?, ?, 'user_managed', NULL, ?, ?, ?)`,
	).run(
		teamId,
		creatorIdentityId,
		PROVENANCE,
		recipientPolicyDigest("recipient-policy-team-create-membership-revision-v1", membership),
		recipientPolicyDigest("recipient-policy-team-create-membership-idempotency-v1", membership),
		now,
		now,
	);
}

/**
 * Creates an active Team whose only member is its creator, as admin. Membership
 * includes all of the creator's devices. The Team shares nothing until a Project
 * is shared with it, so creating it changes no one's access.
 */
export function createRecipientPolicyTeam(
	db: Database,
	input: CreateRecipientPolicyTeamInput,
): RecipientPolicyTeamCreateResultV1 {
	const displayName = teamName(input.displayName);
	const teamId = input.teamId ?? `team-${randomUUID()}`;
	db.transaction(() => {
		assertCreatorActive(db, input.creatorIdentityId);
		assertNameAvailable(db, displayName);
		insertTeam(db, teamId, displayName, input.creatorIdentityId, input.now);
		if (input.coordinatorGroup)
			recordTeamCoordinatorLink(db, { teamId, ...input.coordinatorGroup, now: input.now });
	}).immediate();
	return { version: 1, teamId, displayName };
}
