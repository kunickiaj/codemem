import { createHash } from "node:crypto";
import type { CoordinatorConsumedTeamInvite } from "./coordinator-actions.js";
import { persistCoordinatorEnrollmentReconciliationIssues } from "./coordinator-enrollment-reconciliation-issues.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import { assignIdentityDeviceInTransaction } from "./identity-device-assignment.js";
import { normalizeIdentityDisplayName } from "./project-invite-identity.js";

export interface CoordinatorEnrollmentReconcileIssue {
	kind: "device" | "team_membership";
	referenceId: string;
	code: string;
}

export interface CoordinatorEnrollmentReconcileResult {
	devicesAdded: number;
	membershipsAdded: number;
	identitiesAdded: number;
	unchanged: number;
	issues: CoordinatorEnrollmentReconcileIssue[];
}

function digest(kind: string, value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify([kind, value]))
		.digest("hex");
}

function strictId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		value.length <= 256 &&
		!/[\p{Cc}\p{Cf}]/u.test(value)
	);
}

function normalizedDisplayNameOrNull(
	value: string | null | undefined,
	field: string,
): string | null {
	if (value == null) return null;
	try {
		return normalizeIdentityDisplayName(value, field);
	} catch {
		return null;
	}
}

function displayNameOrFallback(
	value: string | null | undefined,
	field: string,
	fallback: string,
): string {
	return normalizedDisplayNameOrNull(value, field) ?? fallback;
}

export function reconcileCoordinatorEnrollmentSnapshot(
	db: Database,
	input: {
		coordinatorId: string;
		groupId: string;
		enrollments: CoordinatorEnrollment[];
		consumedTeamInvites: CoordinatorConsumedTeamInvite[];
		localDeviceId?: string;
		now?: string;
	},
): CoordinatorEnrollmentReconcileResult {
	if (!strictId(input.coordinatorId)) throw new Error("coordinator_id_invalid");
	if (!strictId(input.groupId)) throw new Error("coordinator_group_id_invalid");
	const now = input.now ?? new Date().toISOString();
	if (Number.isNaN(new Date(now).getTime())) throw new Error("reconciliation_time_invalid");
	const result: CoordinatorEnrollmentReconcileResult = {
		devicesAdded: 0,
		membershipsAdded: 0,
		identitiesAdded: 0,
		unchanged: 0,
		issues: [],
	};
	const issue = (
		kind: CoordinatorEnrollmentReconcileIssue["kind"],
		referenceId: string,
		code: string,
	): void => {
		const safeReferenceId = strictId(referenceId)
			? referenceId
			: `invalid-reference:${digest("coordinator-enrollment-issue-reference-v1", {
					kind,
					referenceId,
				})}`;
		result.issues.push({ kind, referenceId: safeReferenceId, code });
	};
	const localEnrollmentIdentityIds = new Set(
		input.enrollments
			.filter(
				(enrollment) =>
					enrollment.group_id === input.groupId &&
					enrollment.enabled === 1 &&
					enrollment.device_id === input.localDeviceId &&
					strictId(enrollment.identity_id),
			)
			.map((enrollment) => enrollment.identity_id as string),
	);
	const locallyProvenIdentityId =
		localEnrollmentIdentityIds.size === 1 ? [...localEnrollmentIdentityIds][0] : undefined;

	const apply = db.transaction(() => {
		const reviewedInviteMemberships = new Map<
			string,
			{ identityId: string; inviteId: string; newlyAdded: boolean; teamId: string }
		>();
		const activeRosterDevicesByIdentity = new Map<
			string,
			Map<string, { assignmentVersion: number; deviceId: string }>
		>();
		const recordActiveRosterDevice = (
			identityId: string,
			deviceId: string,
			assignmentVersion: number,
		): void => {
			let devices = activeRosterDevicesByIdentity.get(identityId);
			if (!devices) {
				devices = new Map();
				activeRosterDevicesByIdentity.set(identityId, devices);
			}
			devices.set(deviceId, { assignmentVersion, deviceId });
		};

		for (const invite of input.consumedTeamInvites) {
			const identityId = invite.assigned_identity_id;
			const recipientDisplayName = displayNameOrFallback(
				invite.recipient_display_name,
				"recipient_display_name",
				"Team member",
			);
			if (
				invite.group_id !== input.groupId ||
				!strictId(identityId) ||
				identityId !== invite.recipient_actor_id ||
				!strictId(invite.policy_team_id)
			) {
				issue("team_membership", invite.invite_id, "team_invite_invalid");
				continue;
			}
			const team = db
				.prepare("SELECT status, device_eligibility_mode FROM policy_teams WHERE team_id = ?")
				.get(invite.policy_team_id) as
				| { device_eligibility_mode: string; status: string }
				| undefined;
			if (team?.status !== "active") {
				issue("team_membership", invite.invite_id, "policy_team_not_active");
				continue;
			}
			const actor = db
				.prepare("SELECT is_local, status, merged_into_actor_id FROM actors WHERE actor_id = ?")
				.get(identityId) as
				| { is_local: number; status: string; merged_into_actor_id: string | null }
				| undefined;
			if (!actor) {
				db.prepare(`INSERT INTO actors(
					actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
				) VALUES (?, ?, 0, 'active', NULL, ?, ?)`).run(identityId, recipientDisplayName, now, now);
				result.identitiesAdded += 1;
			} else if (
				actor.is_local !== 0 ||
				actor.status !== "active" ||
				actor.merged_into_actor_id != null
			) {
				issue("team_membership", invite.invite_id, "identity_not_active");
				continue;
			}
			const membership = db
				.prepare(
					`SELECT status, provenance FROM policy_team_memberships
					 WHERE team_id = ? AND identity_id = ?`,
				)
				.get(invite.policy_team_id, identityId) as
				| { status: string; provenance: string }
				| undefined;
			const reviewedTeam = team.device_eligibility_mode === "reviewed_allowlist";
			const activeMembershipStatus = reviewedTeam ? "reviewed_active" : "active";
			if (membership) {
				if (membership.status === activeMembershipStatus) {
					// A consumed invite owns this membership from now on. Leaving
					// setup-owned provenance in place would let a later guided setup
					// that omits the identity revoke the invitee's access.
					if (["reviewed_active", "reviewed_team_candidate"].includes(membership.provenance)) {
						db.prepare(
							`UPDATE policy_team_memberships
							 SET provenance = 'coordinator_invite', updated_at = ?
							 WHERE team_id = ? AND identity_id = ?`,
						).run(now, invite.policy_team_id, identityId);
					}
					result.unchanged += 1;
					if (reviewedTeam) {
						const key = `${invite.policy_team_id}\u0000${identityId}`;
						if (!reviewedInviteMemberships.has(key)) {
							reviewedInviteMemberships.set(key, {
								teamId: invite.policy_team_id,
								identityId,
								inviteId: invite.invite_id,
								newlyAdded: false,
							});
						}
					}
				} else if (
					reviewedTeam &&
					membership.status === "active" &&
					["team_invite", "coordinator_invite"].includes(membership.provenance)
				) {
					// The pre-reviewed reconciler wrote invite memberships as
					// `active`; normalize to the reviewed-mode status so the row
					// stops blocking authoritative eligibility.
					db.prepare(
						`UPDATE policy_team_memberships
						 SET status = 'reviewed_active', updated_at = ?
						 WHERE team_id = ? AND identity_id = ?`,
					).run(now, invite.policy_team_id, identityId);
					result.unchanged += 1;
					const key = `${invite.policy_team_id}\u0000${identityId}`;
					if (!reviewedInviteMemberships.has(key)) {
						reviewedInviteMemberships.set(key, {
							teamId: invite.policy_team_id,
							identityId,
							inviteId: invite.invite_id,
							newlyAdded: false,
						});
					}
				} else if (
					membership.status === "revoked" &&
					["reviewed_active", "reviewed_team_candidate"].includes(membership.provenance)
				) {
					// Guided setup revoked this person; a newly consumed invite is
					// explicit re-authorization and adopts the row.
					const stableBinding = {
						groupId: input.groupId,
						inviteId: invite.invite_id,
						teamId: invite.policy_team_id,
						identityId,
					};
					db.prepare(
						`UPDATE policy_team_memberships
						 SET role = 'member', status = ?, provenance = 'coordinator_invite',
						     revision = ?, migration_state = 'user_managed',
						     source_fingerprint = ?, idempotency_key = ?, updated_at = ?
						 WHERE team_id = ? AND identity_id = ?`,
					).run(
						activeMembershipStatus,
						digest("coordinator-team-membership-revision-v1", stableBinding),
						digest("coordinator-team-membership-source-v1", stableBinding),
						digest("coordinator-team-membership-idempotency-v1", stableBinding),
						now,
						invite.policy_team_id,
						identityId,
					);
					result.membershipsAdded += 1;
					if (reviewedTeam) {
						reviewedInviteMemberships.set(`${invite.policy_team_id}\u0000${identityId}`, {
							teamId: invite.policy_team_id,
							identityId,
							inviteId: invite.invite_id,
							newlyAdded: true,
						});
						db.prepare(
							`UPDATE policy_teams SET source_fingerprint = NULL, updated_at = ?
							 WHERE team_id = ? AND device_eligibility_mode = 'reviewed_allowlist'`,
						).run(now, invite.policy_team_id);
					}
				} else issue("team_membership", invite.invite_id, "membership_not_active");
				continue;
			}
			const stableBinding = {
				groupId: input.groupId,
				inviteId: invite.invite_id,
				teamId: invite.policy_team_id,
				identityId,
			};
			db.prepare(`INSERT INTO policy_team_memberships(
				team_id, identity_id, role, status, provenance, revision, migration_state,
				source_fingerprint, idempotency_key, created_at, updated_at
			) VALUES (?, ?, 'member', ?, 'coordinator_invite', ?, 'user_managed', ?, ?, ?, ?)`).run(
				invite.policy_team_id,
				identityId,
				activeMembershipStatus,
				digest("coordinator-team-membership-revision-v1", stableBinding),
				digest("coordinator-team-membership-source-v1", stableBinding),
				digest("coordinator-team-membership-idempotency-v1", stableBinding),
				now,
				now,
			);
			result.membershipsAdded += 1;
			if (reviewedTeam) {
				reviewedInviteMemberships.set(`${invite.policy_team_id}\u0000${identityId}`, {
					teamId: invite.policy_team_id,
					identityId,
					inviteId: invite.invite_id,
					newlyAdded: true,
				});
				db.prepare(
					`UPDATE policy_teams SET source_fingerprint = NULL, updated_at = ?
					 WHERE team_id = ? AND device_eligibility_mode = 'reviewed_allowlist'`,
				).run(now, invite.policy_team_id);
			}
		}

		for (const enrollment of input.enrollments) {
			const identityId = enrollment.identity_id;
			if (identityId == null || identityId === "") continue;
			if (
				enrollment.group_id !== input.groupId ||
				enrollment.enabled !== 1 ||
				!strictId(enrollment.device_id) ||
				!strictId(identityId)
			) {
				issue("device", enrollment.device_id, "enrollment_invalid");
				continue;
			}
			const actor = db
				.prepare("SELECT is_local, status, merged_into_actor_id FROM actors WHERE actor_id = ?")
				.get(identityId) as
				| { is_local: number; status: string; merged_into_actor_id: string | null }
				| undefined;
			if (
				actor?.status !== "active" ||
				actor.merged_into_actor_id != null ||
				(actor.is_local !== 0 && identityId !== locallyProvenIdentityId)
			) {
				issue("device", enrollment.device_id, "identity_not_active");
				continue;
			}
			const normalizedDisplayName = normalizedDisplayNameOrNull(
				enrollment.display_name,
				"device_display_name",
			);
			const displayName = normalizedDisplayName ?? "Enrolled device";
			const existing = db
				.prepare(
					`SELECT identity_id, display_name, status, provenance, assignment_version
					 FROM identity_devices WHERE device_id = ?`,
				)
				.get(enrollment.device_id) as
				| {
						assignment_version: number;
						display_name: string;
						identity_id: string;
						provenance: string;
						status: string;
				  }
				| undefined;
			if (existing) {
				if (existing.identity_id === identityId && existing.status === "active") {
					const assignment = assignIdentityDeviceInTransaction(db, {
						deviceId: enrollment.device_id,
						targetIdentityId: identityId,
						expectation: {
							kind: "existing",
							identityId,
							assignmentVersion: existing.assignment_version,
						},
						now,
					});
					if (
						existing.provenance === "coordinator_enrollment" &&
						normalizedDisplayName != null &&
						existing.display_name !== displayName
					) {
						db.prepare(
							`UPDATE identity_devices SET display_name = ?, updated_at = ?
							 WHERE device_id = ? AND provenance = 'coordinator_enrollment'`,
						).run(displayName, now, enrollment.device_id);
					}
					recordActiveRosterDevice(identityId, enrollment.device_id, assignment.assignmentVersion);
					result.unchanged += 1;
				} else {
					issue("device", enrollment.device_id, "device_identity_conflict");
				}
				continue;
			}
			const existingPeer = db
				.prepare(
					`SELECT public_key, pinned_fingerprint, claimed_local_actor
					 FROM sync_peers WHERE peer_device_id = ?`,
				)
				.get(enrollment.device_id) as
				| {
						public_key: string | null;
						pinned_fingerprint: string | null;
						claimed_local_actor: number;
				  }
				| undefined;
			if (
				existingPeer &&
				(existingPeer.claimed_local_actor === 1 ||
					(existingPeer.public_key != null && existingPeer.public_key !== enrollment.public_key) ||
					(existingPeer.pinned_fingerprint != null &&
						existingPeer.pinned_fingerprint !== enrollment.fingerprint))
			) {
				issue("device", enrollment.device_id, "device_trust_conflict");
				continue;
			}
			const stableBinding = {
				groupId: input.groupId,
				identityId,
				deviceId: enrollment.device_id,
				fingerprint: enrollment.fingerprint,
			};
			const assignment = assignIdentityDeviceInTransaction(db, {
				deviceId: enrollment.device_id,
				targetIdentityId: identityId,
				expectation: { kind: "absent" },
				insert: {
					displayName,
					provenance: "coordinator_enrollment",
					revision: digest("coordinator-identity-device-revision-v1", stableBinding),
					migrationState: "user_managed",
					sourceFingerprint: digest("coordinator-identity-device-source-v1", stableBinding),
					idempotencyKey: digest("coordinator-identity-device-idempotency-v1", stableBinding),
				},
				now,
			});
			recordActiveRosterDevice(identityId, enrollment.device_id, assignment.assignmentVersion);
			result.devicesAdded += 1;
		}

		for (const membership of reviewedInviteMemberships.values()) {
			const devices = activeRosterDevicesByIdentity.get(membership.identityId);
			if (!devices) continue;
			for (const device of devices.values()) {
				const stableDecision = {
					teamId: membership.teamId,
					identityId: membership.identityId,
					inviteId: membership.inviteId,
					deviceId: device.deviceId,
					assignmentVersion: device.assignmentVersion,
				};
				// Existing setup-owned decisions transition to invite ownership
				// while keeping their reviewed decision, so a later refreshed
				// setup roster omitting the device cannot silently revoke
				// invite-managed access.
				const inserted = membership.newlyAdded
					? db
							.prepare(`INSERT INTO policy_team_device_decisions(
								team_id, device_id, decision, assignment_version, provenance, revision,
								created_at, updated_at
							) VALUES (?, ?, 'unresolved', ?, 'coordinator_invite', ?, ?, ?)
							ON CONFLICT(team_id, device_id) DO UPDATE SET
								decision = CASE
									WHEN policy_team_device_decisions.provenance = 'reviewed_team_setup'
									THEN policy_team_device_decisions.decision
									ELSE 'unresolved'
								END,
								assignment_version = CASE
									WHEN policy_team_device_decisions.provenance = 'reviewed_team_setup'
									THEN policy_team_device_decisions.assignment_version
									ELSE excluded.assignment_version
								END,
								provenance = excluded.provenance,
								revision = excluded.revision,
								updated_at = excluded.updated_at`)
							.run(
								membership.teamId,
								device.deviceId,
								device.assignmentVersion,
								digest("coordinator-team-device-decision-revision-v1", stableDecision),
								now,
								now,
							)
					: db
							.prepare(`INSERT INTO policy_team_device_decisions(
								team_id, device_id, decision, assignment_version, provenance, revision,
								created_at, updated_at
							) VALUES (?, ?, 'unresolved', ?, 'coordinator_invite', ?, ?, ?)
							ON CONFLICT(team_id, device_id) DO UPDATE SET
								provenance = excluded.provenance,
								revision = excluded.revision,
								updated_at = excluded.updated_at
							WHERE policy_team_device_decisions.provenance = 'reviewed_team_setup'`)
							.run(
								membership.teamId,
								device.deviceId,
								device.assignmentVersion,
								digest("coordinator-team-device-decision-revision-v1", stableDecision),
								now,
								now,
							);
				if (inserted.changes > 0) {
					db.prepare(
						`UPDATE policy_teams SET source_fingerprint = NULL, updated_at = ?
						 WHERE team_id = ? AND device_eligibility_mode = 'reviewed_allowlist'
						   AND EXISTS (
							   SELECT 1 FROM policy_team_device_decisions
							   WHERE team_id = ? AND device_id = ? AND decision = 'unresolved'
						   )`,
					).run(now, membership.teamId, membership.teamId, device.deviceId);
				}
			}
		}

		const issueSet = new Map(
			result.issues.map((item) => [
				`${item.kind}\u0000${item.referenceId}\u0000${item.code}`,
				item,
			]),
		);
		result.issues = [...issueSet.values()].sort(
			(left, right) =>
				left.kind.localeCompare(right.kind) ||
				left.referenceId.localeCompare(right.referenceId) ||
				left.code.localeCompare(right.code),
		);
		persistCoordinatorEnrollmentReconciliationIssues(db, {
			coordinatorId: input.coordinatorId,
			groupId: input.groupId,
			issues: result.issues,
			now,
		});
	});
	apply();
	return result;
}
