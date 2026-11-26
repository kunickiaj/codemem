import type { CoordinatorTeamMemberRemoval } from "./coordinator-team-member-removals.js";
import type { Database } from "./db.js";
import { wakeRecipientPoliciesForIdentities } from "./device-identity-binding.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";
import { teamCoordinatorLinks, teamMemberRemovalLinkKey } from "./team-member-removal-lookup.js";

export {
	isTeamMemberRemoved,
	removedTeamMemberIdentityIds,
} from "./team-member-removal-lookup.js";

/*
 * Local enforcement of per-Team member removals. The coordinator keeps the
 * removals; this machine keeps a copy so its policy code can honor them inside
 * its own transactions. A removal is permanent for that identity: the copy only
 * grows, a removed membership is revoked when the removal arrives, sync
 * admission refuses the person's devices for the Team's scopes, and Team
 * setups and invitations never make it active again. A person comes back only through a new Team invitation,
 * under a new identity. Each copy is keyed by the coordinator group that
 * recorded it, and applies only to a Team that group set up.
 */

/** A removal as the coordinator lists it. */
export type TeamMemberRemovalRecord = CoordinatorTeamMemberRemoval;

export interface ApplyTeamMemberRemovalsResult {
	/** Removals this machine did not have before. */
	recorded: number;
	/** Team and identity pairs whose membership this call revoked. */
	revoked: Array<{ teamId: string; identityId: string }>;
	/** Records for a Team that this coordinator group did not set up. They have no effect. */
	ignored: Array<{ teamId: string; identityId: string }>;
}

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

function recordRemovals(
	db: Database,
	coordinatorId: string,
	removals: readonly TeamMemberRemovalRecord[],
	now: string,
): TeamMemberRemovalRecord[] {
	const insert = db.prepare(`INSERT INTO policy_team_member_removals(
		coordinator_id, group_id, team_id, identity_id, removal_seq, removed_at,
		removed_by_device_id, recorded_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(coordinator_id, group_id, team_id, identity_id) DO NOTHING`);
	return removals.filter(
		(record) =>
			insert.run(
				coordinatorId,
				record.group_id,
				record.team_id,
				record.identity_id,
				record.removal_seq,
				record.removed_at,
				record.removed_by_device_id,
				now,
			).changes === 1,
	);
}

/**
 * Revokes the membership if it is still active. Recipient policies are woken
 * before the revocation, while the membership still selects their Projects.
 * Delivery ends without waiting for them: sync admission refuses the person's
 * devices for the Team's scopes as soon as the removal is recorded.
 */
function revokeRemovedMembership(
	db: Database,
	record: TeamMemberRemovalRecord,
	now: string,
): boolean {
	const active = hasActiveMembership(db, {
		teamId: record.team_id,
		identityId: record.identity_id,
	});
	if (active) {
		wakeRecipientPoliciesForIdentities(db, [record.identity_id], now);
		db.prepare(
			`UPDATE policy_team_memberships SET status = 'revoked', updated_at = ?
			 WHERE team_id = ? AND identity_id = ?`,
		).run(now, record.team_id, record.identity_id);
	}
	return active;
}

/**
 * Records removals from one coordinator group and revokes each removed
 * membership that is still active, in one transaction. From the moment a
 * removal is recorded, sync admission refuses the person's devices for the
 * Team's scopes. A record for a Team this group did not set up is kept without
 * effect and reported as ignored. A record that is malformed or names another
 * group is refused as a whole, so a broken list changes nothing.
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
	const link = teamMemberRemovalLinkKey(input.coordinatorId, input.groupId);
	return db
		.transaction((): ApplyTeamMemberRemovalsResult => {
			const recorded = recordRemovals(db, input.coordinatorId, input.removals, input.now);
			const result: ApplyTeamMemberRemovalsResult = {
				recorded: recorded.length,
				revoked: [],
				ignored: [],
			};
			for (const record of input.removals) {
				const pair = { teamId: record.team_id, identityId: record.identity_id };
				if (link === null || !teamCoordinatorLinks(db, record.team_id).has(link)) {
					result.ignored.push(pair);
					continue;
				}
				if (revokeRemovedMembership(db, record, input.now)) result.revoked.push(pair);
			}
			return result;
		})
		.immediate();
}

function hasActiveMembership(db: Database, pair: { teamId: string; identityId: string }): boolean {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM policy_team_memberships
				 WHERE team_id = ? AND identity_id = ? AND status IN ('active', 'reviewed_active')`,
			)
			.get(pair.teamId, pair.identityId),
	);
}
