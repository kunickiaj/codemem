/**
 * Test-only. This file exists only to pin equivalence with the pre-port SQL.
 *
 * Between the markers are, copied verbatim from main at 075d46647 before the owner
 * resolution commit moved to read-set guards: the snapshot, owner and resolution stages
 * of coordinator-auth-controller.ts with the statements built on them, and the commit
 * half of coordinator-legacy-owner-resolution-commit.ts. Only the commit's entry point
 * was renamed, and its evidence collector type now names the verbatim pre-port collector.
 * The review capture it reads is imported: it is unchanged since that commit. Its unused
 * `digest` helper was dropped. Do not edit
 * the copy to follow later changes; delete this file with
 * coordinator-legacy-owner-resolution-commit-equivalence.test.ts.
 */

import type {
	CoordinatorAuthControllerAttestation,
	CoordinatorAuthControllerReviewInput,
} from "./coordinator-auth-controller.js";
import { CONTROLLER_HISTORY_CTE } from "./coordinator-auth-controller-history.js";
import {
	AUTH_CONTROLLER_OWNER_CTE,
	AUTH_CONTROLLER_OWNER_GUARD,
	CONTROLLER_HISTORY_GUARD,
} from "./coordinator-auth-controller-stages-original-sql-test-fixtures.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { OriginalDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence-original-sql-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	captureInternalOwnerResolutionReview,
	type InternalOwnerResolutionReview,
} from "./coordinator-legacy-owner-resolution-commit.js";
import {
	canonicalReviewedWeakLabels,
	captureLegacyOwnerResolutionRecord,
	type LegacyOwnerResolutionRecord,
} from "./coordinator-legacy-owner-resolution-metadata.js";

// ---- verbatim copy starts ----
// One JSON bind keeps the exact set comparison below D1's parameter limit.
// Parse each tuple once; EXCEPT uses temporary B-trees rather than an inner
// JSON scan per live invite. Unique captured/live IDs plus equal counts prove
// equality; EXCEPT also compares nullable identity fields without losing NULLs.
const AUTH_CONTROLLER_SNAPSHOT_CTE = `
	WITH snapshot(value) AS (SELECT ?), snapshot_invites AS MATERIALIZED (
		SELECT json_extract(j.value, '$.inviteId') AS invite_id,
			json_extract(j.value, '$.kind') AS invite_kind,
			json_extract(j.value, '$.actorId') AS recipient_actor_id,
			json_extract(j.value, '$.assignedIdentityId') AS assigned_identity_id,
			json_extract(j.value, '$.targetIdentityId') AS target_identity_id,
			json_extract(j.value, '$.digest') AS reviewed_preview_digest
		FROM json_each((SELECT value FROM snapshot), '$.invites') j
	), live_invites AS MATERIALIZED (
		SELECT i.invite_id, i.invite_kind, i.recipient_actor_id, i.assigned_identity_id,
			i.target_identity_id, i.reviewed_preview_digest FROM coordinator_invites i
		WHERE i.group_id = ? AND i.bound_device_id = ? AND i.bound_public_key = ?
			AND i.bound_fingerprint = ? AND i.revoked_at IS NULL
			AND i.consumed_at IS NOT NULL AND i.consumed_at != ''
			AND i.invite_kind IN ('team_member', 'add_device')
	), ${CONTROLLER_HISTORY_CTE}`;
const AUTH_CONTROLLER_SNAPSHOT_GUARD = `
	AND ((SELECT value FROM snapshot) IS NULL OR (
		e.identity_id IS json_extract((SELECT value FROM snapshot), '$.enrollmentIdentityId')
		AND (SELECT count(*) FROM live_invites) =
			(SELECT count(*) FROM snapshot_invites)
		AND NOT EXISTS (
			SELECT * FROM live_invites
			EXCEPT
			SELECT * FROM snapshot_invites
		)
	)) ${CONTROLLER_HISTORY_GUARD}`;

function authControllerSnapshotValues(
	input: CoordinatorAuthControllerReviewInput,
): (string | null)[] {
	return [
		input.verifiedSnapshot ? JSON.stringify(input.verifiedSnapshot) : null,
		input.groupId,
		input.deviceId,
		input.publicKey,
		input.fingerprint,
	];
}

/** Pin the actual enrollment used to derive the revocation key across async reads. */
export function authControllerAuthorityValues(
	source: {
		group_id: string;
		device_id: string;
		public_key: string;
		fingerprint: string;
		identity_id: string | null;
	},
	keyId: string | null,
): (string | null)[] {
	return [
		source.group_id,
		source.device_id,
		source.public_key,
		source.fingerprint,
		source.identity_id,
		source.device_id,
		keyId,
	];
}

const AUTH_CONTROLLER_AUTHORITY_GUARD = `
	AND e.group_id = ? AND e.device_id = ? AND e.public_key = ?
	AND e.fingerprint = ? AND e.identity_id IS ?
	AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations WHERE
		(subject_kind = 'device_id' AND subject_value = ?) OR
		(subject_kind = 'ed25519_key' AND subject_value = ?))`;

export const AUTH_CONTROLLER_ENROLLMENT_SQL = `
	SELECT e.* FROM enrolled_devices e WHERE e.group_id = ? AND e.device_id = ?`;

export const AUTH_CONTROLLER_INSERT_SQL = `
	${AUTH_CONTROLLER_SNAPSHOT_CTE}
	INSERT INTO coordinator_auth_controller_attestations (
		attestation_id, coordinator_id, identity_id, group_id, device_id, public_key,
		fingerprint, review_receipt_id, evidence_digest, enrollment_identity_id, revision, created_at, revoked_at
	)
	SELECT ?, ?, ?, e.group_id, e.device_id, e.public_key, e.fingerprint, ?, ?, e.identity_id, 1, ?, NULL
	FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
	WHERE e.group_id = ? AND e.device_id = ? AND e.enabled = 1 AND g.archived_at IS NULL
		AND e.public_key = ? AND e.fingerprint = ? AND (e.identity_id IS NULL OR e.identity_id = ?)
		${AUTH_CONTROLLER_SNAPSHOT_GUARD}
		${AUTH_CONTROLLER_AUTHORITY_GUARD}`;

/** Retry eligibility is read atomically with all the same live evidence guards. */
export const AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL = `
	${AUTH_CONTROLLER_SNAPSHOT_CTE}
	SELECT 1 AS eligible FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
	WHERE e.group_id = ? AND e.device_id = ? AND e.enabled = 1 AND g.archived_at IS NULL
		AND e.public_key = ? AND e.fingerprint = ? AND (e.identity_id IS NULL OR e.identity_id = ?)
		${AUTH_CONTROLLER_SNAPSHOT_GUARD}
		${AUTH_CONTROLLER_AUTHORITY_GUARD}`;

/** Named builder keeps ordinary exported SQL unchanged and usable without connection tables. */
export function authControllerReviewSql(
	base: string,
	input: CoordinatorAuthControllerReviewInput,
): string {
	if (!input.verifiedSnapshot?.accountOwnerTarget) return base;
	const { subject, statement } = ownerReviewStages(base);
	return `${AUTH_CONTROLLER_SNAPSHOT_CTE}, ${AUTH_CONTROLLER_OWNER_CTE},
		controller_review_subject AS MATERIALIZED (${subject})
		${statement} ${AUTH_CONTROLLER_OWNER_GUARD}`;
}

/** Internal explicit-resolution path only. The collector must first prove the
 * current label weak; snapshot and authority guards still pin that exact label.
 * Ordinary creation, retries and mutation readers retain their original SQL.
 */
export function authControllerOwnerResolutionSql(
	mode: "create" | "eligible",
	input: CoordinatorAuthControllerReviewInput,
): string {
	const stages = authControllerOwnerResolutionStages(mode, input);
	return `${stages.ctes} ${stages.statement}`;
}

/** Keep eligibility proof roots flat when composing a checked batch assertion. */
export function authControllerOwnerResolutionStages(
	mode: "create" | "eligible",
	input: CoordinatorAuthControllerReviewInput,
): { ctes: string; statement: string } {
	if (!input.verifiedSnapshot?.accountOwnerTarget)
		throw new Error("account_owner_authority_unavailable");
	const base = mode === "create" ? AUTH_CONTROLLER_INSERT_SQL : AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL;
	const stages = ownerReviewStages(base);
	const subject = stages.subject.replace(
		"(e.identity_id IS NULL OR e.identity_id = ?)",
		"(e.identity_id IS NULL OR e.identity_id = ? OR e.identity_id IS json_extract((SELECT value FROM snapshot), '$.enrollmentIdentityId'))",
	);
	return {
		ctes: `${AUTH_CONTROLLER_SNAPSHOT_CTE}, ${AUTH_CONTROLLER_OWNER_CTE},
			controller_review_subject AS MATERIALIZED (${subject})`,
		statement: `${stages.statement} ${AUTH_CONTROLLER_OWNER_GUARD}`,
	};
}

/** These are three trusted templates, not arbitrary caller SQL. Keep both deep
 * evidence trees in separate root stages so D1 never combines their depth.
 */
function ownerReviewStages(base: string): { subject: string; statement: string } {
	if (base === AUTH_CONTROLLER_INSERT_SQL) {
		const insertAt = base.indexOf("INSERT INTO coordinator_auth_controller_attestations");
		const sourceAt = base.indexOf(
			"FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id",
			insertAt,
		);
		return {
			subject: `SELECT e.* ${base.slice(sourceAt)}`,
			statement: `${base.slice(insertAt, sourceAt)} FROM controller_review_subject e WHERE 1`,
		};
	}
	if (base === AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL) {
		const selectAt = base.indexOf("SELECT 1 AS eligible FROM enrolled_devices e");
		return {
			subject: base.slice(selectAt).replace("SELECT 1 AS eligible", "SELECT e.*"),
			statement: "SELECT 1 AS eligible FROM controller_review_subject e WHERE 1",
		};
	}
	if (base === AUTH_CONTROLLER_RETRY_ACTIVE_SQL) {
		const selectAt = base.indexOf("SELECT a.* FROM coordinator_auth_controller_attestations a");
		return {
			subject: base.slice(selectAt),
			statement: "SELECT e.* FROM controller_review_subject e WHERE 1",
		};
	}
	throw new Error("account_owner_statement_invalid");
}

function ownerGuardValues(
	input: CoordinatorAuthControllerReviewInput,
	authority: (string | null)[],
): (string | null)[] {
	if (!input.verifiedSnapshot?.accountOwnerTarget) return [];
	const keyId = authority[authority.length - 1];
	if (typeof keyId !== "string" || keyId.length === 0)
		throw new Error("account_owner_authority_unavailable");
	return [keyId];
}

export function authControllerRetryEligibleValues(
	input: CoordinatorAuthControllerReviewInput,
	authority: (string | null)[],
): (string | null)[] {
	return [
		...authControllerSnapshotValues(input),
		input.groupId,
		input.deviceId,
		input.publicKey,
		input.fingerprint,
		input.identityId,
		...authority,
		...ownerGuardValues(input, authority),
	];
}

export function authControllerInsertValues(
	input: CoordinatorAuthControllerReviewInput,
	createdAt: string,
	authority: (string | null)[],
): (string | null)[] {
	const snapshot = authControllerSnapshotValues(input);
	const metadata = [
		input.attestationId,
		input.coordinatorId,
		input.identityId,
		input.reviewReceiptId,
		input.evidenceDigest,
		createdAt,
	];
	const enrollmentAndAuthority = [
		input.groupId,
		input.deviceId,
		input.publicKey,
		input.fingerprint,
		input.identityId,
		...authority,
	];
	if (input.verifiedSnapshot?.accountOwnerTarget)
		return [
			...snapshot,
			...enrollmentAndAuthority,
			...metadata,
			...ownerGuardValues(input, authority),
		];
	return [...snapshot, ...metadata, ...enrollmentAndAuthority];
}

const AUTH_CONTROLLER_CURRENT_SQL = `
	SELECT a.* FROM coordinator_auth_controller_attestations a
	JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
	JOIN groups g ON g.group_id = a.group_id
	WHERE a.coordinator_id = ? AND a.attestation_id = ? AND a.revoked_at IS NULL
		AND e.enabled = 1 AND g.archived_at IS NULL AND e.public_key = a.public_key
		AND e.fingerprint = a.fingerprint
		AND (e.identity_id IS NULL OR e.identity_id = a.identity_id)`;

export const AUTH_CONTROLLER_CURRENT_ENROLLMENT_SQL = AUTH_CONTROLLER_CURRENT_SQL.replace(
	"SELECT a.*",
	"SELECT e.*",
);

export const AUTH_CONTROLLER_ACTIVE_SQL = `
	${AUTH_CONTROLLER_CURRENT_SQL} ${AUTH_CONTROLLER_AUTHORITY_GUARD}`;

/** D1 retries must return the row checked against live authority in this statement. */
export const AUTH_CONTROLLER_RETRY_ACTIVE_SQL = `
	${AUTH_CONTROLLER_SNAPSHOT_CTE}
	${AUTH_CONTROLLER_ACTIVE_SQL}
	${AUTH_CONTROLLER_SNAPSHOT_GUARD}`;

export function authControllerRetryActiveValues(
	input: CoordinatorAuthControllerReviewInput,
	authority: (string | null)[],
): (string | null)[] {
	return [
		...authControllerSnapshotValues(input),
		input.coordinatorId,
		input.attestationId,
		...authority,
		...ownerGuardValues(input, authority),
	];
}

const CONTROLLER_FIELDS = [
	"attestation_id",
	"coordinator_id",
	"identity_id",
	"group_id",
	"device_id",
	"public_key",
	"fingerprint",
	"review_receipt_id",
	"evidence_digest",
	"enrollment_identity_id",
	"revision",
	"created_at",
	"revoked_at",
] as const;
const RESOLUTION_FIELDS = [
	"coordinator_id",
	"resolution_id",
	"resolution_version",
	"device_id",
	"key_id",
	"owner_identity_id",
	"purpose",
	"scope",
	"source_attestation_id",
	"source_group_id",
	"source_controller_revision",
	"source_public_key",
	"source_fingerprint",
	"source_enrollment_identity_id",
	"source_created_at",
	"source_review_receipt_id",
	"source_evidence_digest",
	"resolution_evidence_digest",
	"reviewed_weak_labels_json",
	"created_at",
] as const;
const CONTROLLER_TABLE = "coordinator_auth_controller_attestations";
const RESOLUTION_TABLE = "coordinator_legacy_owner_resolutions";
function timestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}
function resolutionRecord(
	review: InternalOwnerResolutionReview,
	source: CoordinatorAuthControllerAttestation,
	keyId: string,
	labels: string,
	now: string,
): LegacyOwnerResolutionRecord {
	return {
		coordinator_id: source.coordinator_id,
		resolution_id: review.resolutionId,
		resolution_version: 1,
		device_id: source.device_id,
		key_id: keyId,
		owner_identity_id: source.identity_id,
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: source.attestation_id,
		source_group_id: source.group_id,
		source_controller_revision: source.revision,
		source_public_key: source.public_key,
		source_fingerprint: source.fingerprint,
		source_enrollment_identity_id: source.enrollment_identity_id,
		source_created_at: source.created_at,
		source_review_receipt_id: source.review_receipt_id,
		source_evidence_digest: source.evidence_digest,
		resolution_evidence_digest: review.consent.evidenceDigest,
		reviewed_weak_labels_json: labels,
		created_at: now,
	};
}

const CONTROLLER_ASSERT = `INSERT INTO coordinator_auth_controller_attestations
	(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,
	review_receipt_id,evidence_digest,revision,created_at)
	SELECT '', '', '', '', '', '', '', '', '', 0, ''`;
const RESOLUTION_ASSERT = `INSERT INTO coordinator_legacy_owner_resolutions
	(${RESOLUTION_FIELDS.join(",")}) SELECT '', '', 0, '', '', '', '', '', '', '', 0, '', '', NULL, '', '', '', '', '[]', ''`;

/** A failing predicate performs an invalid INSERT, forcing rollback. Success
 * writes nothing. No reliance on discarded SELECT expressions or JS counts.
 */
function assertRead(
	statement: AuthLinkStatement,
	column: "matches" | "eligible",
): AuthLinkStatement[] {
	const predicate = `NOT COALESCE((SELECT ${column} FROM (${statement.sql})),0)`;
	return [CONTROLLER_ASSERT, RESOLUTION_ASSERT].map((prefix) => ({
		sql: `${prefix} WHERE ${predicate}`,
		values: statement.values,
	}));
}

function assertEligibility(
	input: CoordinatorAuthControllerReviewInput,
	authority: (string | null)[],
): AuthLinkStatement[] {
	const stages = authControllerOwnerResolutionStages("eligible", input);
	return [CONTROLLER_ASSERT, RESOLUTION_ASSERT].map((prefix) => ({
		sql: `${stages.ctes}, owner_resolution_eligibility AS MATERIALIZED (${stages.statement})
			${prefix} FROM (SELECT 1) pending
			LEFT JOIN owner_resolution_eligibility eligible_result ON 1
			WHERE eligible_result.eligible IS NULL`,
		values: authControllerRetryEligibleValues(input, authority),
	}));
}

function rowPin(
	table: typeof CONTROLLER_TABLE | typeof RESOLUTION_TABLE,
	row: CoordinatorAuthControllerAttestation | LegacyOwnerResolutionRecord,
	present: boolean,
): AuthLinkStatement {
	const fields = table === CONTROLLER_TABLE ? CONTROLLER_FIELDS : RESOLUTION_FIELDS;
	const id = table === CONTROLLER_TABLE ? "attestation_id" : "resolution_id";
	let receiptId: string;
	if (table === CONTROLLER_TABLE) {
		if (!("attestation_id" in row)) throw new Error("invalid_controller_pin");
		receiptId = row.attestation_id;
	} else {
		if (!("resolution_id" in row)) throw new Error("invalid_resolution_pin");
		receiptId = row.resolution_id;
	}
	if (!present)
		return {
			sql: `SELECT NOT EXISTS (SELECT 1 FROM ${table} WHERE coordinator_id=? AND ${id}=?) AS matches`,
			values: [row.coordinator_id, receiptId],
		};
	return {
		sql: `WITH pin(value) AS (SELECT ?) SELECT EXISTS (SELECT 1 FROM ${table} r CROSS JOIN pin p WHERE ${fields.map((field) => `r.${field} IS json_extract(p.value,'$.${field}')`).join(" AND ")}) AS matches`,
		values: [JSON.stringify(row)],
	};
}

async function requireReviewedEvidence(
	evidence: OriginalDeviceOwnershipEvidence,
	snapshot: Parameters<OriginalDeviceOwnershipEvidence["prepareAtomicRecheck"]>[0],
	review: InternalOwnerResolutionReview,
): Promise<void> {
	const freshDigest = await evidence.reviewedEvidenceDigest(snapshot);
	if (freshDigest === null || freshDigest !== review.ownershipEvidenceDigest)
		throw new Error("ownership_evidence_changed");
}

async function prepareCommit(
	backend: AuthLinkBackend,
	evidence: OriginalDeviceOwnershipEvidence,
	review: InternalOwnerResolutionReview,
	now: string,
) {
	const input = review.controllerReview;
	const snapshot = input.verifiedSnapshot;
	if (!timestamp(now) || !snapshot?.legacyHistory) throw new Error("invalid_review");
	const signer = {
		groupId: input.groupId,
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
	};
	const keyId = await ed25519KeyIdForRevocation(input.publicKey);
	if (!keyId) throw new Error("invalid_key");
	const collected = await evidence.collect({
		canonicalOwnerId: input.identityId,
		actualSigner: signer,
		verifiedHistory: snapshot.legacyHistory,
	});
	if (
		collected.kind !== "collected" ||
		!["compatible", "weak_label_review_required"].includes(collected.decision)
	)
		throw new Error("ownership_unavailable");
	await requireReviewedEvidence(evidence, collected.recheckSnapshot, review);
	const labels = canonicalReviewedWeakLabels(collected.weakLabels);
	if (labels === null) throw new Error("invalid_labels");
	const controller = reviewedController(review, snapshot.enrollmentIdentityId, now);
	const proposed = resolutionRecord(review, controller, keyId, labels, now);
	if (review.existingController) {
		const verified = await evidence.verifyControllerSource({
			sourceRef: proposed,
			expectedOwnerId: input.identityId,
			actualSigner: signer,
		});
		if (verified.kind !== "verified_controller_source") throw new Error("source_mismatch");
	}
	const resolution = await reviewedResolution(review, proposed);
	const authority = authControllerAuthorityValues(
		{
			group_id: input.groupId,
			device_id: input.deviceId,
			public_key: input.publicKey,
			fingerprint: input.fingerprint,
			identity_id: snapshot.enrollmentIdentityId,
		},
		keyId,
	);
	const statements = await prepareAssertions(
		backend,
		review,
		controller,
		resolution,
		evidence.prepareAtomicRecheck(collected.recheckSnapshot),
		authority,
	);
	appendReceiptWrites(statements, review, resolution, now, authority);
	return { controller, resolution, statements };
}

function reviewedController(
	review: InternalOwnerResolutionReview,
	enrollmentIdentityId: string | null,
	now: string,
): CoordinatorAuthControllerAttestation {
	const input = review.controllerReview;
	return (
		review.existingController ?? {
			attestation_id: input.attestationId,
			coordinator_id: input.coordinatorId,
			identity_id: input.identityId,
			group_id: input.groupId,
			device_id: input.deviceId,
			public_key: input.publicKey,
			fingerprint: input.fingerprint,
			review_receipt_id: input.reviewReceiptId,
			evidence_digest: input.evidenceDigest,
			enrollment_identity_id: enrollmentIdentityId,
			revision: 1 as const,
			created_at: now,
			revoked_at: null,
		}
	);
}

async function reviewedResolution(
	review: InternalOwnerResolutionReview,
	proposed: LegacyOwnerResolutionRecord,
): Promise<LegacyOwnerResolutionRecord> {
	if (!review.existingResolution) return proposed;
	const old = await captureLegacyOwnerResolutionRecord(review.existingResolution);
	if (
		!review.existingController ||
		!old ||
		old.resolution_id !== review.resolutionId ||
		!RESOLUTION_FIELDS.filter(
			(field) =>
				!["resolution_evidence_digest", "reviewed_weak_labels_json", "created_at"].includes(field),
		).every((field) => old[field] === proposed[field])
	)
		throw new Error("resolution_mismatch");
	return old;
}

async function prepareAssertions(
	backend: AuthLinkBackend,
	review: InternalOwnerResolutionReview,
	controller: CoordinatorAuthControllerAttestation,
	resolution: LegacyOwnerResolutionRecord,
	evidenceRecheck: AuthLinkStatement,
	authority: (string | null)[],
): Promise<AuthLinkStatement[]> {
	const input = review.controllerReview;
	const catalog = await backend.first<{ objects: string }>({
		sql: "SELECT json_group_array(json_object('type',type,'name',name,'sql',sql)) AS objects FROM sqlite_master WHERE tbl_name='coordinator_legacy_owner_resolutions'",
		values: [],
	});
	if (!catalog) throw new Error("schema_unavailable");
	return [
		...assertRead(evidenceRecheck, "matches"),
		...assertEligibility(input, authority),
		...assertRead(
			{
				sql: "SELECT (SELECT json_group_array(json_object('type',type,'name',name,'sql',sql)) FROM sqlite_master WHERE tbl_name='coordinator_legacy_owner_resolutions') IS ? AS matches",
				values: [catalog.objects],
			},
			"matches",
		),
		...assertRead(
			rowPin(CONTROLLER_TABLE, controller, review.existingController !== null),
			"matches",
		),
		...assertRead(
			rowPin(RESOLUTION_TABLE, resolution, review.existingResolution !== null),
			"matches",
		),
	];
}

function appendReceiptWrites(
	statements: AuthLinkStatement[],
	review: InternalOwnerResolutionReview,
	resolution: LegacyOwnerResolutionRecord,
	now: string,
	authority: (string | null)[],
): void {
	const input = review.controllerReview;
	if (!review.existingController) {
		statements.push({
			sql: authControllerOwnerResolutionSql("create", input),
			values: authControllerInsertValues(input, now, authority),
		});
		statements.push({ sql: `${RESOLUTION_ASSERT} WHERE changes() <> 1`, values: [] });
	}
	if (!review.existingResolution) {
		statements.push({
			sql: `INSERT INTO ${RESOLUTION_TABLE} (${RESOLUTION_FIELDS.join(",")}) SELECT ${RESOLUTION_FIELDS.map((field) => `json_extract(value,'$.${field}')`).join(",")} FROM (SELECT ? AS value)`,
			values: [JSON.stringify(resolution)],
		});
		statements.push({ sql: `${CONTROLLER_ASSERT} WHERE changes() <> 1`, values: [] });
	}
}

/** Exactly one checked backend batch. A postcommit read failure is a persistence
 * error, never a claim that the successful transaction changed nothing.
 */
export async function commitOriginalReviewedOwnerResolution(options: {
	backend: AuthLinkBackend;
	evidence: OriginalDeviceOwnershipEvidence;
	review: unknown;
	now: string;
}) {
	try {
		const review = captureInternalOwnerResolutionReview(options.review);
		if (!review) throw new Error("invalid_review");
		const prepared = await prepareCommit(options.backend, options.evidence, review, options.now);
		await options.backend.batch(prepared.statements);
		const controller = await options.backend.first<CoordinatorAuthControllerAttestation>({
			sql: `SELECT * FROM ${CONTROLLER_TABLE} WHERE coordinator_id=? AND attestation_id=?`,
			values: [prepared.controller.coordinator_id, prepared.controller.attestation_id],
		});
		const resolution = await options.backend.first<LegacyOwnerResolutionRecord>({
			sql: `SELECT * FROM ${RESOLUTION_TABLE} WHERE coordinator_id=? AND resolution_id=?`,
			values: [prepared.resolution.coordinator_id, prepared.resolution.resolution_id],
		});
		if (
			!controller ||
			!resolution ||
			!CONTROLLER_FIELDS.every((field) => controller[field] === prepared.controller[field]) ||
			!RESOLUTION_FIELDS.every((field) => resolution[field] === prepared.resolution[field])
		)
			throw new Error("receipt_read_failed");
		return {
			controller,
			controllerDisposition: review.existingController ? ("reused" as const) : ("created" as const),
			resolution,
			resolutionDisposition: review.existingResolution ? ("reused" as const) : ("created" as const),
		};
	} catch {
		throw new Error("Owner resolution outcome is unavailable; check its status before retrying");
	}
}
// ---- verbatim copy ends ----
