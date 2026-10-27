import { createHash } from "node:crypto";
import type { CoordinatorConsumedTeamInvite } from "./coordinator-actions.js";
import { persistCoordinatorEnrollmentReconciliationIssues } from "./coordinator-enrollment-reconciliation-issues.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import { wakeRecipientPoliciesForIdentities } from "./device-identity-binding.js";
import { assignIdentityDeviceInTransaction } from "./identity-device-assignment.js";
import { normalizeIdentityDisplayName } from "./project-invite-identity.js";
import {
	canonicalRecipientPolicyJson,
	compareCodepoints,
	isStrictRecipientPolicyId,
} from "./recipient-policy-identifiers.js";
import { serializeRecipientPolicyPublicationMutation } from "./recipient-policy-team-metadata.js";
import {
	planInviteDeviceDecisionTransition,
	planInviteMembershipTransition,
} from "./team-ownership-transitions.js";

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

export function coordinatorEnrollmentDigest(kind: string, value: unknown): string {
	if (kind.includes("\0") || !kind.isWellFormed()) {
		throw new TypeError("Coordinator enrollment digest kind must be well-formed without NUL");
	}
	return createHash("sha256")
		.update(kind, "utf8")
		.update("\0", "utf8")
		.update(canonicalRecipientPolicyJson(value), "utf8")
		.digest("hex");
}

function invalidIssueReferenceEvidence(
	kind: CoordinatorEnrollmentReconcileIssue["kind"],
	referenceId: unknown,
): Record<string, string | null> {
	if (typeof referenceId === "string") return { kind, referenceId };
	const referenceType = referenceId === null ? "null" : typeof referenceId;
	const referenceValue =
		typeof referenceId === "number" ||
		typeof referenceId === "boolean" ||
		typeof referenceId === "bigint" ||
		typeof referenceId === "symbol"
			? String(referenceId)
			: null;
	return { kind, referenceType, referenceValue };
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

function finalizeReconciliation(
	db: Database,
	input: { coordinatorId: string; groupId: string },
	result: CoordinatorEnrollmentReconcileResult,
	changedIdentityIds: Set<string>,
	now: string,
): void {
	const issueSet = new Map(
		result.issues.map((item) => [`${item.kind}\u0000${item.referenceId}\u0000${item.code}`, item]),
	);
	result.issues = [...issueSet.values()].sort(
		(left, right) =>
			compareCodepoints(left.kind, right.kind) ||
			compareCodepoints(left.referenceId, right.referenceId) ||
			compareCodepoints(left.code, right.code),
	);
	persistCoordinatorEnrollmentReconciliationIssues(db, {
		coordinatorId: input.coordinatorId,
		groupId: input.groupId,
		issues: result.issues,
		now,
	});
	wakeRecipientPoliciesForIdentities(db, changedIdentityIds, now);
}

function adoptMembership(
	db: Database,
	teamId: string,
	identityId: string,
	status: "active" | "reviewed_active",
	now: string,
): void {
	db.prepare(
		`UPDATE policy_team_memberships
		 SET status = ?, provenance = 'coordinator_invite', updated_at = ?
		 WHERE team_id = ? AND identity_id = ?`,
	).run(status, now, teamId, identityId);
}

type RosterDevices = Map<string, Map<string, { assignmentVersion: number; deviceId: string }>>;

function addRosterDevice(
	roster: RosterDevices,
	identityId: string,
	deviceId: string,
	assignmentVersion: number,
): void {
	let devices = roster.get(identityId);
	if (!devices) {
		devices = new Map();
		roster.set(identityId, devices);
	}
	devices.set(deviceId, { assignmentVersion, deviceId });
}

/** Keeps a coordinator-provided device name current; local names are left alone. */
function refreshEnrollmentDisplayName(
	db: Database,
	existing: { provenance: string; display_name: string },
	deviceId: string,
	displayName: string | null,
	now: string,
): void {
	if (
		existing.provenance !== "coordinator_enrollment" ||
		displayName == null ||
		existing.display_name === displayName
	)
		return;
	db.prepare(
		`UPDATE identity_devices SET display_name = ?, updated_at = ?
		 WHERE device_id = ? AND provenance = 'coordinator_enrollment'`,
	).run(displayName, now, deviceId);
}

type LocalDeviceAssignment = {
	assignment_version: number;
	identity_id: string;
	status: string;
};

/** This device's locally pinned key, or a local-actor claim, disagrees with the enrollment. */
function hasPeerTrustConflict(db: Database, enrollment: CoordinatorEnrollment): boolean {
	const peer = db
		.prepare(
			`SELECT public_key, pinned_fingerprint, claimed_local_actor
			 FROM sync_peers WHERE peer_device_id = ?`,
		)
		.get(enrollment.device_id) as
		| { public_key: string | null; pinned_fingerprint: string | null; claimed_local_actor: number }
		| undefined;
	if (!peer) return false;
	return (
		peer.claimed_local_actor === 1 ||
		(peer.public_key != null && peer.public_key !== enrollment.public_key) ||
		(peer.pinned_fingerprint != null && peer.pinned_fingerprint !== enrollment.fingerprint)
	);
}

/**
 * The coordinator moved this active device to another Identity: its ownership
 * binding for this exact key (from a rebind or an owner enrollment, ADR 0005
 * Section 8) names the enrollment's new Identity, and the key this device
 * pinned locally still matches. Any other difference stays a conflict.
 */
function isRebound(
	db: Database,
	existing: LocalDeviceAssignment,
	enrollment: CoordinatorEnrollment,
): boolean {
	return (
		existing.status === "active" &&
		existing.identity_id !== enrollment.identity_id &&
		enrollment.ownership_identity_id === enrollment.identity_id &&
		!hasPeerTrustConflict(db, enrollment)
	);
}

/**
 * Moves the device to its new Identity; it then gets only that Identity's
 * access. Its provenance becomes a plain coordinator enrollment, so coordinator
 * evidence alone never makes it one of this person's own devices.
 */
function adoptReboundDevice(
	db: Database,
	existing: LocalDeviceAssignment,
	enrollment: CoordinatorEnrollment,
	now: string,
) {
	const moved = assignIdentityDeviceInTransaction(db, {
		deviceId: enrollment.device_id,
		targetIdentityId: enrollment.identity_id as string,
		expectation: {
			kind: "existing",
			identityId: existing.identity_id,
			assignmentVersion: existing.assignment_version,
		},
		now,
	});
	db.prepare(
		`UPDATE identity_devices SET provenance = 'coordinator_enrollment', updated_at = ?
		 WHERE device_id = ? AND identity_id = ?`,
	).run(now, enrollment.device_id, enrollment.identity_id);
	return moved;
}

export async function reconcileCoordinatorEnrollmentSnapshot(
	db: Database,
	input: {
		coordinatorId: string;
		groupId: string;
		enrollments: CoordinatorEnrollment[];
		consumedTeamInvites: CoordinatorConsumedTeamInvite[];
		localDeviceId?: string;
		now?: string;
	},
): Promise<CoordinatorEnrollmentReconcileResult> {
	if (!isStrictRecipientPolicyId(input.coordinatorId)) throw new Error("coordinator_id_invalid");
	if (!isStrictRecipientPolicyId(input.groupId)) throw new Error("coordinator_group_id_invalid");
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
		referenceId: unknown,
		code: string,
	): void => {
		const safeReferenceId = isStrictRecipientPolicyId(referenceId)
			? referenceId
			: `invalid-reference:${coordinatorEnrollmentDigest(
					"coordinator-enrollment-issue-reference-v1",
					invalidIssueReferenceEvidence(kind, referenceId),
				)}`;
		result.issues.push({ kind, referenceId: safeReferenceId, code });
	};
	const localEnrollmentIdentityIds = new Set(
		input.enrollments
			.filter(
				(enrollment) =>
					enrollment.group_id === input.groupId &&
					enrollment.enabled === 1 &&
					enrollment.device_id === input.localDeviceId &&
					isStrictRecipientPolicyId(enrollment.device_id) &&
					isStrictRecipientPolicyId(enrollment.identity_id) &&
					isStrictRecipientPolicyId(enrollment.fingerprint),
			)
			.map((enrollment) => enrollment.identity_id as string),
	);
	const locallyProvenIdentityId =
		localEnrollmentIdentityIds.size === 1 ? [...localEnrollmentIdentityIds][0] : undefined;

	const apply = db.transaction(() => {
		const changedIdentityIds = new Set<string>();
		const reviewedInviteMemberships = new Map<
			string,
			{ identityId: string; inviteId: string; newlyAdded: boolean; teamId: string }
		>();
		const activeRosterDevicesByIdentity = new Map<
			string,
			Map<string, { assignmentVersion: number; deviceId: string }>
		>();
		const recordActiveRosterDevice = (identityId: string, deviceId: string, version: number) =>
			addRosterDevice(activeRosterDevicesByIdentity, identityId, deviceId, version);

		for (const invite of input.consumedTeamInvites) {
			const identityId = invite.assigned_identity_id;
			const recipientDisplayName = displayNameOrFallback(
				invite.recipient_display_name,
				"recipient_display_name",
				"Team member",
			);
			if (
				invite.group_id !== input.groupId ||
				!isStrictRecipientPolicyId(invite.invite_id) ||
				!isStrictRecipientPolicyId(identityId) ||
				identityId !== invite.recipient_actor_id ||
				!isStrictRecipientPolicyId(invite.policy_team_id)
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
				changedIdentityIds.add(identityId);
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
			const membershipTransition = planInviteMembershipTransition(
				membership,
				activeMembershipStatus,
			);
			if (membership) {
				if (membershipTransition === "preserve" || membershipTransition === "adopt_setup") {
					if (membershipTransition === "adopt_setup") {
						adoptMembership(db, invite.policy_team_id, identityId, activeMembershipStatus, now);
						changedIdentityIds.add(identityId);
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
				} else if (membershipTransition === "normalize_invite") {
					db.prepare(
						`UPDATE policy_team_memberships
						 SET status = ?, updated_at = ?
						 WHERE team_id = ? AND identity_id = ?`,
					).run(activeMembershipStatus, now, invite.policy_team_id, identityId);
					result.unchanged += 1;
					changedIdentityIds.add(identityId);
					const key = `${invite.policy_team_id}\u0000${identityId}`;
					if (!reviewedInviteMemberships.has(key)) {
						reviewedInviteMemberships.set(key, {
							teamId: invite.policy_team_id,
							identityId,
							inviteId: invite.invite_id,
							newlyAdded: false,
						});
					}
				} else if (membershipTransition === "reauthorize_setup") {
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
						coordinatorEnrollmentDigest("coordinator-team-membership-revision-v1", stableBinding),
						coordinatorEnrollmentDigest("coordinator-team-membership-source-v1", stableBinding),
						coordinatorEnrollmentDigest(
							"coordinator-team-membership-idempotency-v1",
							stableBinding,
						),
						now,
						invite.policy_team_id,
						identityId,
					);
					result.membershipsAdded += 1;
					changedIdentityIds.add(identityId);
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
				coordinatorEnrollmentDigest("coordinator-team-membership-revision-v1", stableBinding),
				coordinatorEnrollmentDigest("coordinator-team-membership-source-v1", stableBinding),
				coordinatorEnrollmentDigest("coordinator-team-membership-idempotency-v1", stableBinding),
				now,
				now,
			);
			result.membershipsAdded += 1;
			changedIdentityIds.add(identityId);
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
				!isStrictRecipientPolicyId(enrollment.device_id) ||
				!isStrictRecipientPolicyId(identityId) ||
				!isStrictRecipientPolicyId(enrollment.fingerprint)
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
			const displayName = normalizedDisplayName ?? "Unnamed device";
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
					refreshEnrollmentDisplayName(
						db,
						existing,
						enrollment.device_id,
						normalizedDisplayName,
						now,
					);
					recordActiveRosterDevice(identityId, enrollment.device_id, assignment.assignmentVersion);
					result.unchanged += 1;
				} else if (isRebound(db, existing, enrollment)) {
					// Counted as added: this publisher now assigns the device to a new Identity.
					const moved = adoptReboundDevice(db, existing, enrollment, now);
					recordActiveRosterDevice(identityId, enrollment.device_id, moved.assignmentVersion);
					changedIdentityIds.add(existing.identity_id).add(identityId);
					result.devicesAdded += 1;
				} else {
					issue("device", enrollment.device_id, "device_identity_conflict");
				}
				continue;
			}
			if (hasPeerTrustConflict(db, enrollment)) {
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
					revision: coordinatorEnrollmentDigest(
						"coordinator-identity-device-revision-v1",
						stableBinding,
					),
					migrationState: "user_managed",
					sourceFingerprint: coordinatorEnrollmentDigest(
						"coordinator-identity-device-source-v1",
						stableBinding,
					),
					idempotencyKey: coordinatorEnrollmentDigest(
						"coordinator-identity-device-idempotency-v1",
						stableBinding,
					),
				},
				now,
			});
			recordActiveRosterDevice(identityId, enrollment.device_id, assignment.assignmentVersion);
			result.devicesAdded += 1;
			changedIdentityIds.add(identityId);
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
				const existingDecision = db
					.prepare(
						`SELECT decision, provenance FROM policy_team_device_decisions
						 WHERE team_id = ? AND device_id = ?`,
					)
					.get(membership.teamId, device.deviceId) as
					| { decision: string; provenance: string }
					| undefined;
				const transition = planInviteDeviceDecisionTransition(
					existingDecision,
					membership.newlyAdded,
				);
				if (transition === "preserve") continue;
				const revision = coordinatorEnrollmentDigest(
					"coordinator-team-device-decision-revision-v1",
					stableDecision,
				);
				const changed =
					transition === "insert_unresolved"
						? db
								.prepare(`INSERT INTO policy_team_device_decisions(
									team_id, device_id, decision, assignment_version, provenance, revision,
									created_at, updated_at
								) VALUES (?, ?, 'unresolved', ?, 'coordinator_invite', ?, ?, ?)`)
								.run(
									membership.teamId,
									device.deviceId,
									device.assignmentVersion,
									revision,
									now,
									now,
								)
						: transition === "adopt_setup"
							? db
									.prepare(
										`UPDATE policy_team_device_decisions
										 SET provenance = 'coordinator_invite', revision = ?, updated_at = ?
										 WHERE team_id = ? AND device_id = ?`,
									)
									.run(revision, now, membership.teamId, device.deviceId)
							: db
									.prepare(
										`UPDATE policy_team_device_decisions
										 SET decision = 'unresolved', assignment_version = ?,
										     provenance = 'coordinator_invite', revision = ?, updated_at = ?
										 WHERE team_id = ? AND device_id = ?`,
									)
									.run(device.assignmentVersion, revision, now, membership.teamId, device.deviceId);
				if (changed.changes > 0) {
					changedIdentityIds.add(membership.identityId);
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

		finalizeReconciliation(db, input, result, changedIdentityIds, now);
	});
	await serializeRecipientPolicyPublicationMutation(db, async () => apply());
	return result;
}
