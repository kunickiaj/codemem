import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import type {
	CoordinatorAuthControllerAttestation,
	CoordinatorAuthControllerReviewInput,
} from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import type { AtomicReader } from "./coordinator-auth-read-set.js";
import { type Backend, review, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { seedLinkedOwnerBirth } from "./coordinator-legacy-owner-resolution-birth-test-fixtures.js";
import type { LegacyOwnerResolutionRecord } from "./coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

export const now = new Date(NOW).toISOString();
export const signer = {
	groupId: "group-a",
	deviceId: "current-laptop",
	publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM",
	fingerprint: "c".repeat(64),
};
export const controllerTable = "coordinator_auth_controller_attestations";
export const resolutionTable = "coordinator_legacy_owner_resolutions";

export interface InternalReviewFixture {
	controllerReview: CoordinatorAuthControllerReviewInput;
	ownershipEvidenceDigest: string;
	existingController: CoordinatorAuthControllerAttestation | null;
	existingResolution: LegacyOwnerResolutionRecord | null;
	resolutionId: string;
	consent: {
		purpose: "existing_account_owner";
		scope: "historical_included_owner_labels_only";
		evidenceDigest: string;
		confirmedDigest: string;
	};
}

export function snapshot(f: LinkFixture, except: string[] = []) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(({ name }) => !except.includes(name))
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

function d1Changes(row: unknown): number {
	if (!row || typeof row !== "object" || !("meta" in row))
		throw new Error("fixture D1 result invalid");
	const meta = row.meta;
	if (!meta || typeof meta !== "object" || !("changes" in meta) || typeof meta.changes !== "number")
		throw new Error("fixture D1 changes unavailable");
	return meta.changes;
}

function evidenceBackendFor(f: LinkFixture, backend: AuthLinkBackend & AtomicReader) {
	return {
		first: backend.first,
		readBatch: backend.readBatch,
		async all<T>({ sql, values }: AuthLinkStatement): Promise<T[]> {
			return f.db.prepare(sql).all(...values) as T[];
		},
	};
}

/** Both stores' backends read a set of statements together, as one snapshot. */
function fixtureReadBatch(f: LinkFixture, kind: Backend, d1: ReturnType<typeof sqliteD1>) {
	return async <T>(statements: AuthLinkStatement[]): Promise<T[][]> => {
		if (kind === "D1") {
			if (!d1.batch) throw new Error("fixture D1 batch unavailable");
			const results = await d1.batch(
				statements.map(({ sql, values }) => d1.prepare(sql).bind(...values)),
			);
			return results.map((result) => ((result as { results?: T[] }).results ?? []) as T[]);
		}
		return f.db.transaction(() =>
			statements.map(({ sql, values }) => f.db.prepare(sql).all(...values) as T[]),
		)();
	};
}

export function backendFor(f: LinkFixture, kind: Backend) {
	const hooks: {
		beforeBatch?: () => void;
		mapStatement?: (statement: AuthLinkStatement) => AuthLinkStatement;
		afterBatch?: () => void;
		beforeFirst?: (statement: AuthLinkStatement) => void;
	} = {};
	const d1 = sqliteD1(f.db);
	let batches = 0;
	const backend: AuthLinkBackend & AtomicReader = {
		async first<T>(statement: AuthLinkStatement): Promise<T | null> {
			hooks.beforeFirst?.(statement);
			if (kind === "D1")
				return d1
					.prepare(statement.sql)
					.bind(...statement.values)
					.first<T>();
			return (f.db.prepare(statement.sql).get(...statement.values) as T | undefined) ?? null;
		},
		async run({ sql, values }) {
			return f.db.prepare(sql).run(...values).changes;
		},
		readBatch: fixtureReadBatch(f, kind, d1),
		async batch(statements) {
			batches++;
			hooks.beforeBatch?.();
			const mapped = statements.map((statement) => hooks.mapStatement?.(statement) ?? statement);
			let result: number[];
			if (kind === "D1") {
				if (!d1.batch) throw new Error("fixture D1 batch unavailable");
				const results = await d1.batch(
					mapped.map(({ sql, values }) => d1.prepare(sql).bind(...values)),
				);
				result = results.map(d1Changes);
			} else {
				result = f.db
					.transaction(() =>
						mapped.map(({ sql, values }) => {
							const statement = f.db.prepare(sql);
							if (statement.reader) {
								statement.all(...values);
								return 0;
							}
							return statement.run(...values).changes;
						}),
					)
					.immediate();
			}
			hooks.afterBatch?.();
			return result;
		},
	};
	return {
		backend,
		hooks,
		batchCount: () => batches,
		resetBatchCount: () => {
			batches = 0;
		},
		evidence: new CoordinatorDeviceOwnershipEvidence(evidenceBackendFor(f, backend), f.cfg),
	};
}
export type Harness = ReturnType<typeof backendFor>;

export function history(f: LinkFixture, groupId = "history-c", identityId = "identity-c") {
	const manifest = normalize({
		version: 1,
		coordinator_id: f.cfg.coordinatorId,
		candidate_ref: legacyTeamCandidateId(f.cfg.coordinatorId, groupId),
		candidate_digest: "a".repeat(64),
		team_id: `team-${groupId}`,
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic history",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: identityId, role: "member" }],
		device_decisions: [
			{
				device_id: signer.deviceId,
				key_fingerprint: signer.fingerprint,
				enabled: true,
				identity_id: identityId,
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
		.run(groupId, manifest.candidate_ref, canonical(manifest), now, now);
}

export async function seed(f: LinkFixture, h: Harness, options: { weakCurrent?: boolean } = {}) {
	// Real accepted claim birth -> link -> migration proof. No fabricated Google link or laptop ledger.
	await seedLinkedOwnerBirth(f);
	f.db.exec(`INSERT INTO coordinator_auth_account_links
		(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,
		created_at_ms,authority_kind,device_claim_id)
		SELECT coordinator_id,claim_id,issuer,'private-claim-subject',identity_id,attempt_id,
		auth_config_revision,created_at_ms,'device_claim',claim_id FROM coordinator_auth_device_claims;
		INSERT INTO coordinator_auth_link_audit_log
		(coordinator_id,link_id,attempt_id,identity_id,group_id,device_id,fingerprint,
		auth_config_revision,created_at_ms,action,authority_kind,device_claim_id)
		SELECT coordinator_id,link_id,attempt_id,identity_id,group_id,device_id,fingerprint,
		auth_config_revision,finalized_at_ms,'link_created','device_claim',link_id
		FROM coordinator_auth_link_attempts;`);
	await applyAccountConnectionSchema(h.backend);
	f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	await f.store.enrollDevice(signer.groupId, signer);
	history(f);
	if (options.weakCurrent) {
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id=? WHERE device_id=?")
			.run("identity-c", signer.deviceId);
	}
	expect(await readConnectionSchemaState(h.backend)).toBe("ready");
	// Count operations under test, not the completed schema/provenance setup batch.
	h.resetBatchCount();
}

async function linkedTarget(f: LinkFixture) {
	// The ordinary target reader intentionally rejects weak C on the requester.
	// Independently validate the real account generation using its original enrolled
	// device; the reviewed requester and collector below remain the actual laptop.
	const origin = f.db
		.prepare("SELECT * FROM enrolled_devices WHERE device_id='device-a'")
		.get() as {
		group_id: string;
		device_id: string;
		public_key: string;
		fingerprint: string;
	};
	const target = await f.store.readAccountOwnerTarget(
		{
			targetIdentityId: "identity-a",
			signer: {
				groupId: origin.group_id,
				deviceId: origin.device_id,
				publicKey: origin.public_key,
				fingerprint: origin.fingerprint,
			},
		},
		f.cfg,
	);
	if (target.kind !== "ready") throw new Error("fixture target proof unavailable");
	return target;
}

async function reviewedOwnershipEvidenceDigest(
	f: LinkFixture,
	verifiedHistory: Parameters<CoordinatorDeviceOwnershipEvidence["collect"]>[0]["verifiedHistory"],
) {
	const evidence = new CoordinatorDeviceOwnershipEvidence(
		{
			async first<T>({ sql, values }: AuthLinkStatement): Promise<T | null> {
				return (f.db.prepare(sql).get(...values) as T | undefined) ?? null;
			},
			async all<T>({ sql, values }: AuthLinkStatement): Promise<T[]> {
				return f.db.prepare(sql).all(...values) as T[];
			},
			readBatch: fixtureReadBatch(f, "SQLite", sqliteD1(f.db)),
		},
		f.cfg,
	);
	const collection = await evidence.collect({
		canonicalOwnerId: "identity-a",
		actualSigner: { ...signer },
		verifiedHistory,
	});
	if (collection.kind !== "collected") throw new Error("fixture ownership evidence unavailable");
	const digest = await evidence.reviewedEvidenceDigest(collection.recheckSnapshot);
	if (!digest || !/^[a-f0-9]{64}$/u.test(digest))
		throw new Error("fixture ownership evidence digest unavailable");
	return digest;
}

export async function buildReview(
	f: LinkFixture,
	options: {
		existingController?: CoordinatorAuthControllerAttestation | null;
		existingResolution?: LegacyOwnerResolutionRecord | null;
		resolutionId?: string;
		/** Runs after the requester's enrollment label is read, before evidence is collected. */
		afterRequester?: () => void;
	} = {},
): Promise<InternalReviewFixture> {
	const { afterRequester, ...digested } = options;
	const enrollment = f.db
		.prepare("SELECT identity_id FROM enrolled_devices WHERE group_id=? AND device_id=?")
		.get(signer.groupId, signer.deviceId) as { identity_id: string | null };
	afterRequester?.();
	const target = await linkedTarget(f);
	const legacyHistory = await f.store.captureAuthControllerLegacyHistory({
		coordinatorId: f.cfg.coordinatorId,
		...signer,
	});
	const controllerReview = review({
		...signer,
		attestationId: "resolution-controller",
		reviewReceiptId: "resolution-controller-receipt",
		verifiedSnapshot: {
			enrollmentIdentityId: enrollment.identity_id,
			invites: [],
			legacyHistory,
			accountOwnerTarget: {
				purpose: "existing_account_owner",
				coordinatorId: f.cfg.coordinatorId,
				targetIdentityId: "identity-a",
				issuer: f.cfg.issuer,
				linkId: target.linkId,
				authConfigRevision: target.currentGeneration.authConfigRevision,
				createdAtMs: target.currentGeneration.createdAtMs,
			},
		},
	});
	const ownershipEvidenceDigest = await reviewedOwnershipEvidenceDigest(f, legacyHistory);
	// Synthetic trusted operator confirmation, not a public preview-digest protocol.
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				purpose: "existing_account_owner",
				scope: "historical_included_owner_labels_only",
				controllerReview,
				ownershipEvidenceDigest,
				...digested,
			}),
		)
		.digest("hex");
	return {
		controllerReview,
		ownershipEvidenceDigest,
		existingController: options.existingController ?? null,
		existingResolution: options.existingResolution ?? null,
		resolutionId: options.resolutionId ?? "resolution-a",
		consent: {
			purpose: "existing_account_owner",
			scope: "historical_included_owner_labels_only",
			evidenceDigest: digest,
			confirmedDigest: digest,
		},
	};
}

export async function originalController(
	f: LinkFixture,
	groupId = signer.groupId,
	publicKey = signer.publicKey,
) {
	if (groupId !== signer.groupId) {
		await f.store.createGroup(groupId);
		await f.store.enrollDevice(groupId, { ...signer, publicKey });
	}
	const result = await f.store.createAuthControllerAttestation(
		review({
			...signer,
			groupId,
			publicKey,
			attestationId: "original-controller",
			reviewReceiptId: "original-receipt",
			evidenceDigest: "e".repeat(64),
		}),
	);
	if (result.kind !== "created") throw new Error("fixture ordinary controller rejected");
	return result.attestation;
}

export async function revoke(f: LinkFixture, subject: "device_id" | "ed25519_key", origin = false) {
	const row = f.db
		.prepare("SELECT * FROM enrolled_devices WHERE device_id=?")
		.get(origin ? "device-a" : signer.deviceId) as {
		device_id: string;
		public_key: string;
		fingerprint: string;
	};
	f.db
		.prepare(`INSERT INTO coordinator_device_revocations
		(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,
		evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?)`)
		.run(
			subject,
			subject === "device_id" ? row.device_id : await ed25519KeyIdForRevocation(row.public_key),
			`revoke-${subject}`,
			signer.groupId,
			row.device_id,
			row.public_key,
			row.fingerprint,
			now,
		);
}
