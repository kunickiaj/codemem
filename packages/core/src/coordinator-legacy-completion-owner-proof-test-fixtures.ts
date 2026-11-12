// Fixtures shared by the legacy team completion owner-proof tests: a manifest for the
// future Team, an ordinary enrolled device, and a recovered owner A whose original source
// and reviewed resolution are real rows. Moved unchanged from the owner-proof test file.
import { expect, vi } from "vitest";
import type { LinkFixture } from "./coordinator-auth-link-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
	history,
	now,
	seed,
	signer,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export const futureGroup = "future-completion";
export const completions = "coordinator_legacy_team_completions";
export const resolutions = "coordinator_legacy_owner_resolutions";
export const controllers = "coordinator_auth_controller_attestations";

export function manifest(
	f: LinkFixture,
	owner = "identity-a",
	options: { deviceId?: string; publicKey?: string; groupId?: string } = {},
): CoordinatorLegacyTeamCompletionManifestV1 {
	const candidate = legacyTeamCandidateId(f.cfg.coordinatorId, options.groupId ?? futureGroup);
	return {
		version: 1,
		coordinator_id: f.cfg.coordinatorId,
		candidate_ref: candidate,
		candidate_digest: "a".repeat(64),
		team_id: deterministicPolicyTeamId(candidate),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Future Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: owner, role: "member" }],
		device_decisions: [
			{
				device_id: options.deviceId ?? signer.deviceId,
				key_fingerprint: fingerprintPublicKey(options.publicKey ?? signer.publicKey),
				enabled: true,
				identity_id: owner,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: now,
	};
}

export async function ordinary(f: LinkFixture) {
	await f.store.createGroup(futureGroup);
	await f.store.enrollDevice(futureGroup, {
		deviceId: signer.deviceId,
		publicKey: signer.publicKey,
		fingerprint: fingerprintPublicKey(signer.publicKey),
	});
	return manifest(f);
}

export async function recovery(f: LinkFixture, kind: Backend) {
	const h = backendFor(f, kind);
	await seed(f, h);
	// Fixture-only pre-upgrade state: exact device/key has historical A and B,
	// with B still the current enrollment and consumed Project actor label.
	f.db.prepare(`DELETE FROM ${completions}`).run();
	history(f, "history-a", "identity-a");
	history(f, "history-b", "identity-b");
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id='identity-b' WHERE device_id=?")
		.run(signer.deviceId);
	await f.store.createGroup(futureGroup);
	f.db
		.prepare(`INSERT INTO enrolled_devices
		(group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at)
		SELECT ?,device_id,public_key,?,'identity-b',enabled,created_at
		FROM enrolled_devices WHERE group_id=? AND device_id=?`)
		.run(futureGroup, fingerprintPublicKey(signer.publicKey), signer.groupId, signer.deviceId);
	f.db
		.prepare(`INSERT INTO coordinator_invites
		(invite_id,group_id,token,policy,created_at,expires_at,consumed_at,
		bound_device_id,bound_public_key,bound_fingerprint,invite_kind,
		assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest)
		VALUES ('completion-project',?,'synthetic-completion-token','open',?,?,?,?,?,?,'project_share',NULL,NULL,'identity-b',?)`)
		.run(
			signer.groupId,
			now,
			"2026-10-05T00:00:00.000Z",
			now,
			signer.deviceId,
			signer.publicKey,
			signer.fingerprint,
			"e".repeat(64),
		);
	const result = await commitReviewedOwnerResolution({
		backend: h.backend,
		evidence: h.evidence,
		review: await buildReview(f),
		now,
	});
	expect(result.resolutionDisposition).toBe("created");
	expect(
		await h.evidence.verifyControllerSource({
			sourceRef: result.resolution,
			expectedOwnerId: "identity-a",
			actualSigner: {
				...signer,
				groupId: futureGroup,
				fingerprint: fingerprintPublicKey(signer.publicKey),
			},
		}),
	).toEqual({ kind: "verified_controller_source" });
	expect(JSON.parse(result.resolution.reviewed_weak_labels_json)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ label: "identity-b", kind: "legacy_included_owner_label" }),
			expect.objectContaining({ label: "identity-b", kind: "consumed_project_actor_label" }),
		]),
	);
	expect(
		f.db.prepare(`SELECT * FROM ${completions} WHERE group_id=?`).get(futureGroup),
	).toBeUndefined();
	return { h, result, value: manifest(f) };
}

export const WINNING_INSERT =
	/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+coordinator_legacy_team_completions\s*\(/iu;
export const GUARD_MARKER = "auth_snapshot_changed";

/**
 * Runs `inject` once, just before the winning transaction starts. Both stores write the
 * completion in one transaction the capture's guards lead (the D1 batch is one), so this
 * is the last moment a concurrent write can land. A hook inside it would be rolled back
 * with the batch, or would model an interleaving neither store allows.
 */
export function beforeWinningBatch(f: LinkFixture, inject: () => void) {
	const transaction = f.db.transaction.bind(f.db);
	let injected = false;
	const once = () => {
		if (injected) return;
		injected = true;
		inject();
	};
	vi.spyOn(f.db, "transaction").mockImplementation((fn) => {
		const wrapped = transaction(fn);
		const before =
			<A extends unknown[], R>(run: (...args: A) => R) =>
			(...args: A) => {
				once();
				return run(...args);
			};
		return Object.assign(before(wrapped), {
			default: before(wrapped.default),
			deferred: before(wrapped.deferred),
			immediate: before(wrapped.immediate),
			exclusive: before(wrapped.exclusive),
		}) as typeof wrapped;
	});
	return { injected: () => injected };
}
