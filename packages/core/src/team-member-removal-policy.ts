import type { CoordinatorTeamMemberRemoval } from "./coordinator-team-member-removals.js";
import type { Database } from "./db.js";
import { wakeRecipientPoliciesForIdentities } from "./device-identity-binding.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";

/*
 * Local enforcement of per-Team member removals. The coordinator keeps the
 * removals; this machine keeps a copy so its policy code can honor them inside
 * its own transactions. A removal is permanent for that identity: the copy only
 * grows, a removed membership is revoked when the removal arrives, and Team
 * setups and invitations never make it active again. A person comes back only
 * through a new Team invitation, under a new identity.
 */

/** A removal as the coordinator lists it. */
export type TeamMemberRemovalRecord = CoordinatorTeamMemberRemoval;

export interface ApplyTeamMemberRemovalsResult {
	/** Removals this machine did not have before. */
	recorded: number;
	/** Team and identity pairs whose membership this call revoked. */
	revoked: Array<{ teamId: string; identityId: string }>;
}

const ACTIVE_MEMBERSHIP_STATUSES = ["active", "reviewed_active"];

function validRecord(record: TeamMemberRemovalRecord): boolean {
	return (
		isStrictRecipientPolicyId(record.group_id) &&
		isStrictRecipientPolicyId(record.team_id) &&
		isStrictRecipientPolicyId(record.identity_id) &&
		Number.isSafeInteger(record.removal_seq) &&
		record.removal_seq > 0 &&
		typeof record.removed_at === "string" &&
		record.removed_at.length > 0 &&
		(record.removed_by_device_id === null || isStrictRecipientPolicyId(record.removed_by_device_id))
	);
}

/** Identities removed from the Team. */
export function removedTeamMemberIdentityIds(db: Database, teamId: string): Set<string> {
	return new Set(
		db
			.prepare("SELECT identity_id FROM policy_team_member_removals WHERE team_id = ?")
			.pluck()
			.all(teamId) as string[],
	);
}

/** Whether the identity was removed from the Team. */
export function isTeamMemberRemoved(db: Database, teamId: string, identityId: string): boolean {
	return Boolean(
		db
			.prepare(
				"SELECT 1 FROM policy_team_member_removals WHERE team_id = ? AND identity_id = ? LIMIT 1",
			)
			.pluck()
			.get(teamId, identityId),
	);
}

/**
 * Records removals from one coordinator and revokes each removed membership
 * that is still active, in one transaction. Affected recipient policies are
 * woken before the revocation, while the membership still selects their
 * Projects. A record that is malformed or belongs to another group is refused
 * as a whole, so a broken list changes nothing.
 */
export function applyTeamMemberRemovals(
	db: Database,
	input: {
		coordinatorId: string;
		groupId: string;
		removals: readonly TeamMemberRemovalRecord[];
		now: string;
	},
): ApplyTeamMemberRemovalsResult {
	if (
		!isStrictRecipientPolicyId(input.coordinatorId) ||
		input.removals.some((record) => !validRecord(record) || record.group_id !== input.groupId)
	)
		throw new Error("team_member_removal_invalid");
	return db
		.transaction((): ApplyTeamMemberRemovalsResult => {
			const insert = db.prepare(`INSERT INTO policy_team_member_removals(
				team_id, identity_id, coordinator_id, group_id, removal_seq, removed_at,
				removed_by_device_id, recorded_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(team_id, identity_id) DO NOTHING`);
			let recorded = 0;
			for (const record of input.removals) {
				recorded += insert.run(
					record.team_id,
					record.identity_id,
					input.coordinatorId,
					record.group_id,
					record.removal_seq,
					record.removed_at,
					record.removed_by_device_id,
					input.now,
				).changes;
			}
			const active = db.prepare(
				`SELECT 1 FROM policy_team_memberships
				 WHERE team_id = ? AND identity_id = ? AND status IN (${ACTIVE_MEMBERSHIP_STATUSES.map(() => "?").join(", ")})`,
			);
			const revoked = input.removals
				.filter((record) =>
					active.get(record.team_id, record.identity_id, ...ACTIVE_MEMBERSHIP_STATUSES),
				)
				.map((record) => ({ teamId: record.team_id, identityId: record.identity_id }));
			if (revoked.length === 0) return { recorded, revoked };
			wakeRecipientPoliciesForIdentities(
				db,
				revoked.map((pair) => pair.identityId),
				input.now,
			);
			const revoke = db.prepare(
				`UPDATE policy_team_memberships SET status = 'revoked', updated_at = ?
				 WHERE team_id = ? AND identity_id = ?`,
			);
			for (const pair of revoked) revoke.run(input.now, pair.teamId, pair.identityId);
			return { recorded, revoked };
		})
		.immediate();
}
