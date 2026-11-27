import { createHash } from "node:crypto";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { coordinatorEnrollmentBindingSource } from "./coordinator-enrollment-reconciler.js";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import type { Database } from "./db.js";
import {
	applyLegacyTeamSetupCompletionManifest,
	containLegacyTeamSetupCompletionConflict,
	deriveLegacyTeamSetupCompletionManifest,
} from "./legacy-team-setup-completion-manifest.js";
import {
	refreshLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "./legacy-team-setup-draft.js";
import { legacyTeamCandidateId, legacyTeamProjectRef } from "./recipient-policy-identifiers.js";
import { getEffectiveCachedScopeAuthorization } from "./scope-membership-cache-read.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

/* A quarantined reviewed Team for Team recovery tests. */

export const NOW = "2026-09-01T12:00:00.000Z";
export const COORDINATOR_ID = "https://coordinator.example.invalid";
export const GROUP_ID = "group-engineering";
export const TARGET = { coordinatorId: COORDINATOR_ID, groupId: GROUP_ID };
export const CANDIDATE = legacyTeamCandidateId(COORDINATOR_ID, GROUP_ID);
export const PROJECT = "https://git.example.invalid/acme/api.git";
/** A well-formed Ed25519 public key in SSH form, distinct for each name. */
export function testPublicKey(name: string): string {
	const length = (value: number) => {
		const bytes = Buffer.alloc(4);
		bytes.writeUInt32BE(value);
		return bytes;
	};
	const raw = createHash("sha256").update(name, "utf8").digest();
	const wire = Buffer.concat([length(11), Buffer.from("ssh-ed25519"), length(32), raw]);
	return `ssh-ed25519 ${wire.toString("base64")}`;
}

export const OTHER_PUBLIC_KEY = testPublicKey("replacement");
export const OTHER_KEY = fingerprintPublicKey(OTHER_PUBLIC_KEY);

const device = (deviceId: string, displayName: string) => {
	const publicKey = testPublicKey(displayName);
	return {
		deviceId,
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		displayName,
		enabled: true,
	};
};
/** The device as the roster would list it after its key was replaced. */
export const rekeyed = <T extends { publicKey: string; fingerprint: string }>(listed: T): T => ({
	...listed,
	publicKey: OTHER_PUBLIC_KEY,
	fingerprint: OTHER_KEY,
});
export const LAPTOP = device("device-a", "Laptop");
export const DESKTOP = device("device-b", "Desktop");
export const TABLET = device("device-x", "Tablet");
export const PHONE = device("device-d", "Phone");
export const LAPTOP_REMOVAL = {
	group_id: GROUP_ID,
	device_id: LAPTOP.deviceId,
	fingerprint: LAPTOP.fingerprint,
};

export function insertScope(db: Database, scopeId: string, groupId: string): void {
	db.prepare(
		`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		 group_id, membership_epoch, status, created_at, updated_at)
		 VALUES (?, 'Scope', 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
	).run(scopeId, COORDINATOR_ID, groupId, NOW, NOW);
}

export function insertActor(db: Database, identityId: string): void {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, ?, 0, 'active', ?, ?)`,
	).run(identityId, `Person ${identityId}`, NOW, NOW);
}

export function bindDevice(db: Database, deviceId: string, identityId: string): void {
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, ?, ?, 'active', 'user', 'r1', 'completed', ?, ?, ?)`,
	).run(deviceId, identityId, deviceId, `bind-${deviceId}`, NOW, NOW);
}

/** Pairs this machine with the device under the key, as a first contact would. */
export function pinDevice(db: Database, deviceId: string, publicKey: string): void {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
		 VALUES (?, ?, ?, ?)`,
	).run(deviceId, publicKey, fingerprintPublicKey(publicKey), NOW);
}

/**
 * The coordinator's answers to a block check of each device, asked with the
 * device's key. None is blocked unless its ID is listed, and none is reported
 * removed. Each answer also carries a `fingerprint`, as a reader could assert
 * one beside the key. The preview must ignore it and hash the key itself.
 */
export function blockChecks(
	devices: ReadonlyArray<{ deviceId: string; publicKey: string }>,
	blockedDeviceIds: readonly string[] = [],
) {
	return devices.map(({ deviceId, publicKey }) => ({
		deviceId,
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		blocked: blockedDeviceIds.includes(deviceId),
		removed: false,
	}));
}

/** A local session in a checkout of the repository, which is how this machine knows the checkout. */
export function insertCheckout(db: Database, cwd: string, gitRemote: string): void {
	db.prepare(
		"INSERT INTO sessions(started_at, cwd, project, git_remote, tool_version) VALUES (?, ?, 'api', ?, 'test')",
	).run(NOW, cwd, gitRemote);
}

/** Reviews the roster: the Laptop for Person A, the Desktop for Person B, the Tablet excluded. */
function reviewedDraft(db: Database) {
	let draft = refreshLegacyTeamSetupDraft(db, {
		candidateId: CANDIDATE,
		...TARGET,
		displayName: "Engineering",
		devices: [LAPTOP, DESKTOP, TABLET],
		projects: [
			{
				projectRef: legacyTeamProjectRef(CANDIDATE, PROJECT),
				sourceProjectIdentity: PROJECT,
				displayName: "API",
				sourceFingerprint: "source-api",
				deterministicProjectIdentity: PROJECT,
				targetScopeId: "scope-engineering",
			},
		],
		now: NOW,
	});
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
	return draft;
}

/**
 * A Team set up from one coordinator group and then quarantined. The review
 * included Person A's Laptop and Person B's Desktop, excluded a Tablet, and
 * shared one Project through the group's scope. Returns the coordinator's copy
 * of the completed setup.
 */
export async function quarantinedTeam(
	db: Database,
): Promise<CoordinatorLegacyTeamCompletionManifestV1> {
	initTestSchema(db);
	for (const identityId of ["identity-a", "identity-b"]) insertActor(db, identityId);
	insertScope(db, "scope-engineering", GROUP_ID);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run("device-local", CANONICAL_PUBLIC_KEY, fingerprintPublicKey(CANONICAL_PUBLIC_KEY), NOW);
	const draft = reviewedDraft(db);
	const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
		candidateRef: draft.candidateRef,
		attemptId: draft.attemptId,
		completedAt: NOW,
	});
	const freshRoster = [LAPTOP, DESKTOP, TABLET];
	await applyLegacyTeamSetupCompletionManifest(db, { ...TARGET, manifest, freshRoster });
	await containLegacyTeamSetupCompletionConflict(db, TARGET);
	return manifest;
}

/**
 * A person and their Phone that joined through a Team invitation after the
 * setup. By default the Phone's binding is the one the enrollment check
 * records, for the key the group enrolled it under. `enrolledKey: null` leaves
 * a binding that names no key. `enrolledGroupId` is the group whose enrollment
 * created the binding, when that was another group.
 */
export function inviteMember(
	db: Database,
	teamId: string,
	options: { enrolledKey?: string | null; enrolledGroupId?: string } = {},
): void {
	insertActor(db, "identity-d");
	db.prepare(
		`INSERT INTO policy_team_memberships(team_id, identity_id, role, status, provenance, revision,
		 migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, 'identity-d', 'member', 'reviewed_active', 'team_invite', 'r1', 'completed',
		 'invite-d', ?, ?)`,
	).run(teamId, NOW, NOW);
	const fingerprint = options.enrolledKey === undefined ? PHONE.fingerprint : options.enrolledKey;
	const binding = {
		groupId: options.enrolledGroupId ?? GROUP_ID,
		identityId: "identity-d",
		deviceId: PHONE.deviceId,
	};
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at)
		 VALUES (?, 'identity-d', 'Phone', 'active', ?, 'r1', 'user_managed', ?, 'bind-d', ?, ?)`,
	).run(
		PHONE.deviceId,
		fingerprint === null ? "user" : "coordinator_enrollment",
		fingerprint === null ? null : coordinatorEnrollmentBindingSource({ ...binding, fingerprint }),
		NOW,
		NOW,
	);
	db.prepare(
		`INSERT INTO policy_team_device_decisions(team_id, device_id, decision, assignment_version,
		 provenance, revision, created_at, updated_at)
		 VALUES (?, ?, 'included', 0, 'team_invite', 'r1', ?, ?)`,
	).run(teamId, PHONE.deviceId, NOW, NOW);
}

/** A scope membership of the device, with the coordinator's proof of it, as a past refresh left them. */
export async function keepScopeProof(
	db: Database,
	deviceId: string,
	scopeId = "scope-engineering",
): Promise<void> {
	db.prepare(
		`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		 VALUES (?, ?, 'member', 'active', 1, ?)`,
	).run(scopeId, deviceId, NOW);
	await refreshTestScopeRows(db);
}

/** What a sync read of the scope by the device is answered with, from the cache and the kept proof. */
export const scopedRead = (db: Database, deviceId: string, scopeId = "scope-engineering") =>
	getEffectiveCachedScopeAuthorization(db, { deviceId, scopeId });
