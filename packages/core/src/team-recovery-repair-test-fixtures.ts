import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import type { Database } from "./db.js";
import { discoverLegacyTeamCandidates } from "./legacy-team-candidate.js";
import { deriveLegacyTeamSetupCompletionManifest } from "./legacy-team-setup-completion-manifest.js";
import {
	getLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "./legacy-team-setup-draft.js";
import { getEffectiveCachedScopeAuthorization } from "./scope-membership-cache-read.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	CANDIDATE,
	DESKTOP,
	GROUP_ID,
	insertActor,
	insertScope,
	LAPTOP,
	NOW,
	PROJECT,
	TABLET,
	TARGET,
} from "./team-recovery-test-fixtures.js";
import { initTestSchema } from "./test-utils.js";

/*
 * A Team setup as discovery builds it, for tests of the repair discovery makes
 * to a completed setup's Project recipients. The repair compares the completed
 * setup with the Projects discovery finds on this machine, so the setup here
 * comes from discovery over real rows and not from a hand-written draft.
 */

export type RepairRoster = Array<typeof LAPTOP>;
export const SETUP_ROSTER: RepairRoster = [LAPTOP, DESKTOP, TABLET];
export const SETUP_SCOPE = "scope-engineering";

/** Two people, the group's scope, and one Project routed to it with a shared memory in it. */
export function seedDiscoverableSetup(db: Database): void {
	initTestSchema(db);
	for (const identityId of ["identity-a", "identity-b"]) insertActor(db, identityId);
	insertScope(db, SETUP_SCOPE, GROUP_ID);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run("device-local", CANONICAL_PUBLIC_KEY, fingerprintPublicKey(CANONICAL_PUBLIC_KEY), NOW);
	db.prepare(
		`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, priority,
		 source, created_at, updated_at) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
	).run(PROJECT, PROJECT, SETUP_SCOPE, NOW, NOW);
	const session = db
		.prepare(
			"INSERT INTO sessions(started_at, project, git_remote, git_branch) VALUES (?, 'api', ?, 'main')",
		)
		.run(NOW, PROJECT);
	db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, active, created_at, updated_at,
		 visibility, project, scope_id) VALUES (?, 'discovery', 'api', 'body', 1, ?, ?, 'shared', 'api', ?)`,
	).run(Number(session.lastInsertRowid), NOW, NOW, SETUP_SCOPE);
}

/** The status discovery gives the setup for this roster. Discovery also runs the repair. */
export function discoverSetup(db: Database, devices: RepairRoster): string[] {
	return discoverLegacyTeamCandidates(db, {
		projection: { localActorId: "actor-local", localDeviceId: "device-local" },
		groups: [{ ...TARGET, displayName: "Engineering", devices }],
		now: NOW,
	}).map((candidate) => candidate.status);
}

/** Reviews the discovered setup: the Laptop for Person A, the Desktop for Person B, the Tablet excluded. */
export function reviewDiscoveredSetup(db: Database): CoordinatorLegacyTeamCompletionManifestV1 {
	discoverSetup(db, SETUP_ROSTER);
	let draft = getLegacyTeamSetupDraft(db, CANDIDATE);
	if (!draft) throw new Error("setup not discovered");
	const owners: Record<string, string> = { Laptop: "identity-a", Desktop: "identity-b" };
	for (const reviewed of draft.devices) {
		const { attemptId } = draft;
		const targetIdentityId = owners[reviewed.displayName];
		const { deviceRef, expectation } = reviewed;
		if (targetIdentityId)
			setLegacyTeamSetupDeviceAssignment(db, {
				attemptId,
				deviceRef,
				targetIdentityId,
				expectation,
				now: NOW,
			});
		const decision = targetIdentityId ? "included" : "excluded";
		draft = setLegacyTeamSetupDeviceDecision(db, { attemptId, deviceRef, decision, now: NOW });
	}
	return deriveLegacyTeamSetupCompletionManifest(db, {
		candidateRef: draft.candidateRef,
		attemptId: draft.attemptId,
		completedAt: NOW,
	});
}

/** The status of the Team's recipient for the Project. */
export function setupRecipientStatus(db: Database): unknown {
	return db
		.prepare(
			`SELECT status FROM project_recipients
			 WHERE canonical_project_identity = ? AND recipient_kind = 'team'`,
		)
		.pluck()
		.get(PROJECT);
}

/** Loses the setup's Project recipient the way the repair expects to find it: revoked and still the setup's. */
export function loseSetupRecipient(db: Database): void {
	db.prepare(
		`UPDATE project_recipients SET status = 'revoked'
		 WHERE canonical_project_identity = ? AND recipient_kind = 'team'`,
	).run(PROJECT);
}

/** Gives the device a membership of the setup's scope with the coordinator's proof of it. */
export async function keepSetupScopeProof(db: Database, deviceId: string): Promise<void> {
	db.prepare(
		`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		 VALUES (?, ?, 'member', 'active', 1, ?)`,
	).run(SETUP_SCOPE, deviceId, NOW);
	await refreshTestScopeRows(db);
}

/** What a sync read of the setup's scope by the device is answered with, from the cache and a kept proof. */
export function setupScopeRead(db: Database, deviceId: string): string {
	return getEffectiveCachedScopeAuthorization(db, { deviceId, scopeId: SETUP_SCOPE }).state;
}
