import {
	authControllerAuthorityValues,
	authControllerInsertValues,
	authControllerOwnerResolutionSql,
	authControllerOwnerResolutionStages,
	authControllerRetryEligibleValues,
	type CoordinatorAuthControllerAttestation,
	type CoordinatorAuthControllerReviewInput,
	captureAuthControllerReview,
	isAuthControllerId,
} from "./coordinator-auth-controller.js";
import {
	type ControllerHistorySnapshot,
	captureControllerHistorySnapshot,
} from "./coordinator-auth-controller-history.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	canonicalReviewedWeakLabels,
	captureLegacyOwnerResolutionRecord,
	type LegacyOwnerResolutionRecord,
} from "./coordinator-legacy-owner-resolution-metadata.js";

export interface InternalOwnerResolutionReview {
	controllerReview: CoordinatorAuthControllerReviewInput;
	existingController: CoordinatorAuthControllerAttestation | null;
	existingResolution: LegacyOwnerResolutionRecord | null;
	resolutionId: string;
	ownershipEvidenceDigest: string;
	consent: {
		purpose: "existing_account_owner";
		scope: "historical_included_owner_labels_only";
		evidenceDigest: string;
		confirmedDigest: string;
	};
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
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid_review");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid_review");
	if (Reflect.ownKeys(value).length !== fields.length) throw new Error("invalid_review");
	const copy: Record<string, unknown> = {};
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (!descriptor || !("value" in descriptor)) throw new Error("invalid_review");
		copy[field] = descriptor.value;
	}
	return copy;
}

/** Reject extensions and accessors at every level before existing shape parsers
 * run. Arrays are copied by descriptors too, never via caller iteration hooks.
 */
function captureTree(value: unknown, depth = 0): unknown {
	if (depth > 12) throw new Error("invalid_review");
	if (value === null || typeof value === "string" || typeof value === "number") return value;
	if (!value || typeof value !== "object") throw new Error("invalid_review");
	if (Array.isArray(value)) {
		const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
		if (!Number.isSafeInteger(length) || length > 8192) throw new Error("invalid_review");
		const fields = Array.from({ length }, (_, i) => String(i));
		if (Reflect.ownKeys(value).length !== length + 1) throw new Error("invalid_review");
		return fields.map((field) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, field);
			if (!descriptor || !("value" in descriptor)) throw new Error("invalid_review");
			return captureTree(descriptor.value, depth + 1);
		});
	}
	const row = exact(
		value,
		Reflect.ownKeys(value).map((key) => {
			if (typeof key !== "string") throw new Error("invalid_review");
			return key;
		}),
	);
	return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, captureTree(v, depth + 1)]));
}

function captureController(value: unknown): CoordinatorAuthControllerAttestation {
	const row = exact(value, CONTROLLER_FIELDS);
	const input = captureAuthControllerReview({
		attestationId: row.attestation_id,
		coordinatorId: row.coordinator_id,
		identityId: row.identity_id,
		groupId: row.group_id,
		deviceId: row.device_id,
		publicKey: row.public_key,
		fingerprint: row.fingerprint,
		reviewReceiptId: row.review_receipt_id,
		evidenceDigest: row.evidence_digest,
	});
	if (
		!input ||
		row.revision !== 1 ||
		row.revoked_at !== null ||
		(row.enrollment_identity_id !== null && !isAuthControllerId(row.enrollment_identity_id)) ||
		!timestamp(row.created_at)
	)
		throw new Error("invalid_controller");
	return row as unknown as CoordinatorAuthControllerAttestation;
}

function timestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

function captureReviewController(value: unknown): CoordinatorAuthControllerReviewInput {
	const row = exact(value, [
		"attestationId",
		"coordinatorId",
		"identityId",
		"groupId",
		"deviceId",
		"publicKey",
		"fingerprint",
		"reviewReceiptId",
		"evidenceDigest",
		"verifiedSnapshot",
	]);
	row.verifiedSnapshot = captureReviewSnapshotFields(row.verifiedSnapshot, row.groupId);
	const captured = captureAuthControllerReview(row);
	if (!captured?.verifiedSnapshot?.legacyHistory || !captured.verifiedSnapshot.accountOwnerTarget)
		throw new Error("invalid_review");
	return captured;
}

function captureReviewSnapshotFields(value: unknown, groupId: unknown): Record<string, unknown> {
	const snapshot = exact(value, [
		"enrollmentIdentityId",
		"invites",
		"legacyHistory",
		"accountOwnerTarget",
	]);
	snapshot.legacyHistory = captureReviewHistory(snapshot.legacyHistory, groupId);
	if (!Array.isArray(snapshot.invites)) throw new Error("invalid_review");
	for (const invite of snapshot.invites)
		exact(invite, [
			"inviteId",
			"kind",
			"actorId",
			"assignedIdentityId",
			"targetIdentityId",
			"digest",
		]);
	return snapshot;
}

function captureReviewHistory(value: unknown, groupId: unknown): ControllerHistorySnapshot {
	const fields = [
		"coordinatorId",
		"deviceId",
		"publicKey",
		"fingerprint",
		"keys",
		"discoveryKeys",
		"discoveryFragments",
		"fingerprints",
		"records",
	];
	if (value && typeof value === "object" && Object.hasOwn(value, "groupId")) fields.push("groupId");
	const history = exact(value, fields);
	if (Object.hasOwn(history, "groupId") && history.groupId !== groupId)
		throw new Error("invalid_review");
	if (!Array.isArray(history.keys) || !Array.isArray(history.records))
		throw new Error("invalid_review");
	for (const key of history.keys) exact(key, ["public_key", "fingerprint"]);
	for (const record of history.records)
		exact(record, [
			"group_id",
			"candidate_ref",
			"manifest_version",
			"completed_at",
			"created_at",
			"manifest_json",
		]);
	const captured = captureControllerHistorySnapshot(history);
	if (!captured) throw new Error("invalid_review");
	return {
		coordinatorId: captured.coordinatorId,
		deviceId: captured.deviceId,
		publicKey: captured.publicKey,
		fingerprint: captured.fingerprint,
		keys: captured.keys,
		discoveryKeys: captured.discoveryKeys,
		discoveryFragments: captured.discoveryFragments,
		fingerprints: captured.fingerprints,
		records: captured.records,
	};
}

/** Trusted operator-builder input only; this is not a public proof protocol. */
export function captureInternalOwnerResolutionReview(
	value: unknown,
): InternalOwnerResolutionReview | null {
	try {
		const row = exact(captureTree(value), [
			"controllerReview",
			"existingController",
			"existingResolution",
			"resolutionId",
			"ownershipEvidenceDigest",
			"consent",
		]);
		const consent = exact(row.consent, ["purpose", "scope", "evidenceDigest", "confirmedDigest"]);
		if (
			consent.purpose !== "existing_account_owner" ||
			consent.scope !== "historical_included_owner_labels_only" ||
			!digest(consent.evidenceDigest) ||
			consent.confirmedDigest !== consent.evidenceDigest ||
			!isAuthControllerId(row.resolutionId) ||
			!digest(row.ownershipEvidenceDigest)
		)
			return null;
		const controllerReview = captureReviewController(row.controllerReview);
		const existingController =
			row.existingController === null ? null : captureController(row.existingController);
		// Canonical key and metadata checks run asynchronously in the writer.
		const existingResolution =
			row.existingResolution === null
				? null
				: (exact(
						row.existingResolution,
						RESOLUTION_FIELDS,
					) as unknown as LegacyOwnerResolutionRecord);
		return {
			controllerReview,
			existingController,
			existingResolution,
			resolutionId: row.resolutionId,
			ownershipEvidenceDigest: row.ownershipEvidenceDigest,
			consent: {
				purpose: consent.purpose,
				scope: consent.scope,
				evidenceDigest: consent.evidenceDigest,
				confirmedDigest: consent.confirmedDigest,
			},
		};
	} catch {
		return null;
	}
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
	evidence: CoordinatorDeviceOwnershipEvidence,
	snapshot: Parameters<CoordinatorDeviceOwnershipEvidence["prepareAtomicRecheck"]>[0],
	review: InternalOwnerResolutionReview,
): Promise<void> {
	const freshDigest = await evidence.reviewedEvidenceDigest(snapshot);
	if (freshDigest === null || freshDigest !== review.ownershipEvidenceDigest)
		throw new Error("ownership_evidence_changed");
}

async function prepareCommit(
	backend: AuthLinkBackend,
	evidence: CoordinatorDeviceOwnershipEvidence,
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
export async function commitReviewedOwnerResolution(options: {
	backend: AuthLinkBackend;
	evidence: CoordinatorDeviceOwnershipEvidence;
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
