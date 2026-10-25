import { expect } from "vitest";
import type { fixture } from "../../core/src/coordinator-account-change-http-test-fixtures.js";
import { review } from "../../core/src/coordinator-auth-store-test-fixtures.js";
import { CoordinatorDeviceOwnershipEvidence } from "../../core/src/coordinator-device-ownership-evidence.js";
import { commitReviewedOwnerResolution } from "../../core/src/coordinator-legacy-owner-resolution-commit.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "../../core/src/coordinator-legacy-owner-resolution-schema.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Signer = { groupId: string; deviceId: string; publicKey: string; fingerprint: string };

function seedHistory(f: Fixture, signer: Signer, now: string) {
	const groupId = "retained-history-c";
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
		version: 1,
		coordinator_id: f.config.coordinatorId,
		candidate_ref: legacyTeamCandidateId(f.config.coordinatorId, groupId),
		candidate_digest: "a".repeat(64),
		team_id: "retained-team-c",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Retained C history",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: "identity-b", role: "member" }],
		device_decisions: [
			{
				device_id: signer.deviceId,
				key_fingerprint: signer.fingerprint,
				enabled: true,
				identity_id: "identity-b",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: now,
	});
	f.db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
		VALUES (?,?,1,?,?,?)`)
		.run(
			groupId,
			manifest.candidate_ref,
			canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
			now,
			now,
		);
}

/** Real A birth comes from accountFixture; retain weak C and checked resolution evidence. */
export async function seedResolvedOwner(
	f: Fixture,
	signer: Signer,
	options: { fact?: boolean } = {},
) {
	const now = new Date(f.clock.now).toISOString();
	f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	await f.store.enrollDevice(signer.groupId, signer);
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id='identity-b' WHERE device_id=?")
		.run(signer.deviceId);
	seedHistory(f, signer, now);
	// A historical retained source is not an ordinary A controller grant on C's current group.
	await f.store.createGroup("retained-source");
	const sourceKey = `${signer.publicKey} retained-source`;
	await f.store.enrollDevice("retained-source", { ...signer, publicKey: sourceKey });
	const source = await f.store.createAuthControllerAttestation(
		review({
			...signer,
			groupId: "retained-source",
			publicKey: sourceKey,
			identityId: "identity-a",
			coordinatorId: f.config.coordinatorId,
			attestationId: `controller-v1:${"a".repeat(64)}`,
			reviewReceiptId: "retained-receipt",
		}),
	);
	if (source.kind !== "created") throw new Error("Retained source fixture failed");
	if (options.fact === false) return { controller: source.attestation, resolution: null };
	const legacyHistory = await f.store.captureAuthControllerLegacyHistory({
		coordinatorId: f.config.coordinatorId,
		...signer,
	});
	const target = await f.store.readAccountOwnerTarget(
		{
			targetIdentityId: "identity-a",
			signer: {
				groupId: "group-a",
				deviceId: f.key.deviceId,
				publicKey: f.key.publicKey,
				fingerprint: f.key.fingerprint,
			},
		},
		f.config,
	);
	if (target.kind !== "ready")
		throw new Error(`Real birth fixture failed: ${JSON.stringify(target)}`);
	const backend = {
		...f.backend,
		async all<T>({ sql, values }: Parameters<Fixture["backend"]["first"]>[0]): Promise<T[]> {
			return f.db.prepare(sql).all(...values) as T[];
		},
	};
	const evidence = new CoordinatorDeviceOwnershipEvidence(backend, f.config);
	const collection = await evidence.collect({
		canonicalOwnerId: "identity-a",
		actualSigner: signer,
		verifiedHistory: legacyHistory,
	});
	if (collection.kind !== "collected")
		throw new Error(`Evidence fixture failed: ${JSON.stringify(collection)}`);
	const ownershipEvidenceDigest = await evidence.reviewedEvidenceDigest(collection.recheckSnapshot);
	if (!ownershipEvidenceDigest) throw new Error("Missing reviewed evidence digest");
	const digest = "d".repeat(64);
	const result = await commitReviewedOwnerResolution({
		backend,
		evidence,
		now,
		review: {
			controllerReview: review({
				...signer,
				identityId: "identity-a",
				coordinatorId: f.config.coordinatorId,
				attestationId: "resolution-controller",
				reviewReceiptId: "resolution-receipt",
				verifiedSnapshot: {
					enrollmentIdentityId: "identity-b",
					invites: [],
					legacyHistory,
					accountOwnerTarget: {
						purpose: "existing_account_owner",
						coordinatorId: f.config.coordinatorId,
						targetIdentityId: "identity-a",
						issuer: f.config.issuer,
						linkId: target.linkId,
						authConfigRevision: target.currentGeneration.authConfigRevision,
						createdAtMs: target.currentGeneration.createdAtMs,
					},
				},
			}),
			existingController: source.attestation,
			existingResolution: null,
			resolutionId: "viewer-resolution",
			ownershipEvidenceDigest,
			consent: {
				purpose: "existing_account_owner",
				scope: "historical_included_owner_labels_only",
				evidenceDigest: digest,
				confirmedDigest: digest,
			},
		},
	});
	// A setup failure must never be confused with the intended Viewer-contract red tests.
	expect(result).toMatchObject({ resolution: { owner_identity_id: "identity-a" } });
	return result;
}
