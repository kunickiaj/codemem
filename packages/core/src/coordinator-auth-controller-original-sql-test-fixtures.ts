/**
 * Test-only. This file exists only to pin equivalence with the pre-port SQL.
 *
 * Between the markers are, copied verbatim from main at 9a9bf301f before the controller
 * review moved to read-set guards: the snapshot stages and the insert, eligibility and
 * retry statements from coordinator-auth-controller.ts, and `withNegativeOwnerConsistency`
 * from coordinator-owner-negative-consistency.ts. After the markers, the controller
 * methods of d1-coordinator-store.ts and better-sqlite-coordinator-store.ts, copied
 * verbatim into two small classes; only `this.db` and the negative owner builder name
 * changed. The history and owner stages, the conflict and active statements, and the
 * review helpers are imported: they are unchanged since that commit. Do not edit the
 * copy to follow later changes; delete this file with
 * coordinator-auth-controller-equivalence.test.ts.
 */
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
	AUTH_CONTROLLER_CONFLICT_SQL,
	AUTH_CONTROLLER_ENROLLMENT_SQL,
	authControllerAuthorityValues,
	authControllerConflictValues,
	authControllerRetryResult,
	authControllerUnavailableResult,
	type CoordinatorAuthControllerAttestation,
	type CoordinatorAuthControllerCreateResult,
	type CoordinatorAuthControllerReviewInput,
	captureAuthControllerReview,
	isAuthControllerUniqueError,
} from "./coordinator-auth-controller.js";
import { CONTROLLER_HISTORY_CTE } from "./coordinator-auth-controller-history.js";
import {
	AUTH_CONTROLLER_OWNER_CTE,
	AUTH_CONTROLLER_OWNER_GUARD,
	CONTROLLER_HISTORY_GUARD,
} from "./coordinator-auth-controller-stages-original-sql-test-fixtures.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	ed25519KeyIdForRevocation,
	parseSshEd25519PublicKeyForRevocation,
} from "./coordinator-ed25519-key-id-compat.js";
import { prepareOriginalNegativeOwnerConsistency as prepareNegativeOwnerConsistency } from "./coordinator-owner-negative-original-sql-test-fixtures.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./d1-coordinator-store.js";

// Small helpers the stores kept private, as they were.
const nowISO = () => new Date().toISOString();
function enrollmentRevocationKeyId(publicKey: string): string | null {
	const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
	if (parsed.kind !== "ed25519") return null;
	return createHash("sha256").update(parsed.blob).digest("hex");
}
async function firstRow<T>(statement: D1PreparedStatementLike): Promise<T | null> {
	return await statement.first<T>();
}
async function runChanges(statement: D1PreparedStatementLike): Promise<number> {
	const result = (await statement.run()) as { meta?: { changes?: number } } | undefined;
	return Number(result?.meta?.changes ?? 0);
}

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
const AUTH_CONTROLLER_AUTHORITY_GUARD = `
	AND e.group_id = ? AND e.device_id = ? AND e.public_key = ?
	AND e.fingerprint = ? AND e.identity_id IS ?
	AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations WHERE
		(subject_kind = 'device_id' AND subject_value = ?) OR
		(subject_kind = 'ed25519_key' AND subject_value = ?))`;

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

/** Keep the ordinary authority and evidence trees in independent materialized
 * root stages instead of nesting one predicate beneath the other's SQL tree.
 */
export function withNegativeOwnerConsistency(
	statement: AuthLinkStatement,
	predicate: AuthLinkStatement,
): AuthLinkStatement {
	if (!statement.sql.trimStart().startsWith("WITH "))
		throw new Error("invalid_controller_statement");
	return {
		sql: `WITH negative_owner_consistency AS MATERIALIZED (${predicate.sql}), ${statement.sql.trimStart().slice(5)} AND (SELECT matches FROM negative_owner_consistency)`,
		values: [...predicate.values, ...statement.values],
	};
}
// ---- verbatim copy ends ----

/** The D1 store's controller review methods at 9a9bf301f. */
export class OriginalD1ControllerReview {
	constructor(private readonly db: D1DatabaseLike) {}

	async createAuthControllerAttestation(
		input: CoordinatorAuthControllerReviewInput,
	): Promise<CoordinatorAuthControllerCreateResult> {
		const review = captureAuthControllerReview(input);
		if (!review) return { kind: "rejected", error: "invalid_review_input" };
		const source = await firstRow<CoordinatorEnrollment>(
			this.db.prepare(AUTH_CONTROLLER_ENROLLMENT_SQL).bind(review.groupId, review.deviceId),
		);
		if (!source) return authControllerUnavailableResult(review);
		const authority = authControllerAuthorityValues(
			source,
			await ed25519KeyIdForRevocation(source.public_key),
		);
		const conflict = await firstRow<CoordinatorAuthControllerAttestation>(
			this.db.prepare(AUTH_CONTROLLER_CONFLICT_SQL).bind(...authControllerConflictValues(review)),
		);
		if (conflict) return this.resolveAuthControllerRetry(review, authority);
		const consistency = await this.prepareAuthControllerConsistency(review);
		if (!consistency) return authControllerUnavailableResult(review);
		try {
			const statement = withNegativeOwnerConsistency(
				{
					sql: authControllerReviewSql(AUTH_CONTROLLER_INSERT_SQL, review),
					values: authControllerInsertValues(review, nowISO(), authority),
				},
				consistency,
			);
			const inserted = await runChanges(this.db.prepare(statement.sql).bind(...statement.values));
			if (inserted === 0) {
				// The winner changes the evidence pin. Recapture without accepting new conflicts.
				const retryConsistency = await this.prepareAuthControllerConsistency(review);
				if (!retryConsistency) return authControllerUnavailableResult(review);
				return this.resolveAuthControllerRetry(review, authority, retryConsistency);
			}
		} catch (error) {
			if (!isAuthControllerUniqueError(error)) throw error;
			return this.resolveAuthControllerRetry(review, authority);
		}
		const attestation = await firstRow<CoordinatorAuthControllerAttestation>(
			this.db
				.prepare(AUTH_CONTROLLER_ACTIVE_SQL)
				.bind(review.coordinatorId, review.attestationId, ...authority),
		);
		if (!attestation) throw new Error("auth_controller_persistence_incomplete");
		return { kind: "created", attestation };
	}

	private prepareAuthControllerConsistency(review: CoordinatorAuthControllerReviewInput) {
		return prepareNegativeOwnerConsistency(
			{
				first: <T>({ sql, values }: AuthLinkStatement) =>
					this.db
						.prepare(sql)
						.bind(...values)
						.first<T>(),
				all: async <T>({ sql, values }: AuthLinkStatement) => {
					const result = await this.db
						.prepare(sql)
						.bind(...values)
						.all<T>();
					if (!Array.isArray(result.results)) throw new Error("ownership_evidence_unavailable");
					return result.results;
				},
			},
			{
				...review,
				ownerIdentityId: review.identityId,
				enrollment: { groupId: review.groupId },
				verifiedHistory: review.verifiedSnapshot?.legacyHistory,
			},
		);
	}

	private async resolveAuthControllerRetry(
		input: CoordinatorAuthControllerReviewInput,
		authority: (string | null)[],
		consistency?: AuthLinkStatement,
	): Promise<CoordinatorAuthControllerCreateResult> {
		const eligible = await firstRow<{ eligible: number }>(
			this.db
				.prepare(authControllerReviewSql(AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL, input))
				.bind(...authControllerRetryEligibleValues(input, authority)),
		);
		if (!eligible) return authControllerUnavailableResult(input);
		const row = await firstRow<CoordinatorAuthControllerAttestation>(
			this.db.prepare(AUTH_CONTROLLER_CONFLICT_SQL).bind(...authControllerConflictValues(input)),
		);
		const result = authControllerRetryResult(input, row);
		if (result.kind === "rejected") return result;
		let statement: AuthLinkStatement = {
			sql: authControllerReviewSql(AUTH_CONTROLLER_RETRY_ACTIVE_SQL, input),
			values: authControllerRetryActiveValues(input, authority),
		};
		if (consistency) statement = withNegativeOwnerConsistency(statement, consistency);
		const active = await firstRow<CoordinatorAuthControllerAttestation>(
			this.db.prepare(statement.sql).bind(...statement.values),
		);
		// A change after the conflict read makes this review stale, including revocation.
		if (!active)
			return {
				kind: "rejected",
				error: input.verifiedSnapshot ? "review_stale" : "enrollment_mismatch",
			};
		return authControllerRetryResult(input, active);
	}

	async readAuthControllerAttestationForSnapshot(
		input: CoordinatorAuthControllerReviewInput,
	): Promise<CoordinatorAuthControllerAttestation | null> {
		const review = captureAuthControllerReview(input);
		if (!review?.verifiedSnapshot?.accountOwnerTarget) return null;
		const source = await firstRow<CoordinatorEnrollment>(
			this.db.prepare(AUTH_CONTROLLER_ENROLLMENT_SQL).bind(review.groupId, review.deviceId),
		);
		if (!source) return null;
		const authority = authControllerAuthorityValues(
			source,
			await ed25519KeyIdForRevocation(source.public_key),
		);
		return firstRow<CoordinatorAuthControllerAttestation>(
			this.db
				.prepare(authControllerReviewSql(AUTH_CONTROLLER_RETRY_ACTIVE_SQL, review))
				.bind(...authControllerRetryActiveValues(review, authority)),
		);
	}
}

/** The SQLite store's controller review methods at 9a9bf301f. */
export class OriginalSqliteControllerReview {
	constructor(private readonly db: Database) {}

	async createAuthControllerAttestation(
		input: CoordinatorAuthControllerReviewInput,
	): Promise<CoordinatorAuthControllerCreateResult> {
		const review = captureAuthControllerReview(input);
		if (!review) return { kind: "rejected", error: "invalid_review_input" };
		const conflict = this.db
			.prepare(AUTH_CONTROLLER_CONFLICT_SQL)
			.get(...authControllerConflictValues(review)) as
			| CoordinatorAuthControllerAttestation
			| undefined;
		const hasConflict = conflict !== undefined;
		const consistency = hasConflict ? null : await this.prepareAuthControllerConsistency(review);
		if (!hasConflict && !consistency) return authControllerUnavailableResult(review);
		let retryAfterPinChange = false;
		const result = this.db
			.transaction((): CoordinatorAuthControllerCreateResult => {
				const source = this.db
					.prepare(AUTH_CONTROLLER_ENROLLMENT_SQL)
					.get(review.groupId, review.deviceId) as CoordinatorEnrollment | undefined;
				if (!source) return authControllerUnavailableResult(review);
				const authority = authControllerAuthorityValues(
					source,
					enrollmentRevocationKeyId(source.public_key),
				);
				if (hasConflict) return this.resolveAuthControllerRetrySync(review, authority);
				try {
					const statement = withNegativeOwnerConsistency(
						{
							sql: authControllerReviewSql(AUTH_CONTROLLER_INSERT_SQL, review),
							values: authControllerInsertValues(review, nowISO(), authority),
						},
						consistency ?? { sql: "SELECT 0 AS matches", values: [] },
					);
					const inserted = this.db.prepare(statement.sql).run(...statement.values);
					if (inserted.changes === 0) {
						retryAfterPinChange = true;
						return authControllerUnavailableResult(review);
					}
				} catch (error) {
					if (!isAuthControllerUniqueError(error)) throw error;
					return this.resolveAuthControllerRetrySync(review, authority);
				}
				const attestation = this.getActiveAuthControllerAttestationSync(
					review.coordinatorId,
					review.attestationId,
					authority,
				);
				if (!attestation) throw new Error("auth_controller_persistence_incomplete");
				return { kind: "created", attestation };
			})
			.immediate();
		if (!retryAfterPinChange) return result;
		return this.retryAuthControllerAfterPinChange(review);
	}

	private async retryAuthControllerAfterPinChange(
		review: CoordinatorAuthControllerReviewInput,
	): Promise<CoordinatorAuthControllerCreateResult> {
		// The winner changes the evidence pin. Recapture without accepting new conflicts.
		const retryConsistency = await this.prepareAuthControllerConsistency(review);
		if (!retryConsistency) return authControllerUnavailableResult(review);
		return this.db
			.transaction((): CoordinatorAuthControllerCreateResult => {
				const pin = this.db.prepare(retryConsistency.sql).get(...retryConsistency.values) as
					| { matches: number }
					| undefined;
				if (pin?.matches !== 1) return authControllerUnavailableResult(review);
				const source = this.db
					.prepare(AUTH_CONTROLLER_ENROLLMENT_SQL)
					.get(review.groupId, review.deviceId) as CoordinatorEnrollment | undefined;
				if (!source) return authControllerUnavailableResult(review);
				return this.resolveAuthControllerRetrySync(
					review,
					authControllerAuthorityValues(source, enrollmentRevocationKeyId(source.public_key)),
				);
			})
			.immediate();
	}

	private prepareAuthControllerConsistency(review: CoordinatorAuthControllerReviewInput) {
		return prepareNegativeOwnerConsistency(
			{
				first: async <T>({ sql, values }: AuthLinkStatement) =>
					(this.db.prepare(sql).get(...values) as T | undefined) ?? null,
				all: async <T>({ sql, values }: AuthLinkStatement) =>
					this.db.prepare(sql).all(...values) as T[],
			},
			{
				...review,
				ownerIdentityId: review.identityId,
				enrollment: { groupId: review.groupId },
				verifiedHistory: review.verifiedSnapshot?.legacyHistory,
			},
		);
	}

	private resolveAuthControllerRetrySync(
		input: CoordinatorAuthControllerReviewInput,
		authority: (string | null)[],
	): CoordinatorAuthControllerCreateResult {
		if (
			!this.db
				.prepare(authControllerReviewSql(AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL, input))
				.get(...authControllerRetryEligibleValues(input, authority))
		)
			return {
				kind: "rejected",
				error: input.verifiedSnapshot ? "review_stale" : "enrollment_mismatch",
			};
		const row = this.db
			.prepare(AUTH_CONTROLLER_CONFLICT_SQL)
			.get(...authControllerConflictValues(input)) as
			| CoordinatorAuthControllerAttestation
			| undefined;
		const result = authControllerRetryResult(input, row ?? null);
		if (result.kind === "rejected") return result;
		const active = this.getActiveAuthControllerAttestationSync(
			input.coordinatorId,
			input.attestationId,
			authority,
		);
		if (!active) return { kind: "rejected", error: "enrollment_mismatch" };
		return { kind: "existing", attestation: active };
	}

	private getActiveAuthControllerAttestationSync(
		coordinatorId: string,
		attestationId: string,
		authority?: (string | null)[],
	): CoordinatorAuthControllerAttestation | null {
		if (!authority) {
			const source = this.db
				.prepare(AUTH_CONTROLLER_CURRENT_ENROLLMENT_SQL)
				.get(coordinatorId, attestationId) as CoordinatorEnrollment | undefined;
			if (!source) return null;
			authority = authControllerAuthorityValues(
				source,
				enrollmentRevocationKeyId(source.public_key),
			);
		}
		return (
			(this.db
				.prepare(AUTH_CONTROLLER_ACTIVE_SQL)
				.get(coordinatorId, attestationId, ...authority) as
				| CoordinatorAuthControllerAttestation
				| undefined) ?? null
		);
	}

	async readAuthControllerAttestationForSnapshot(
		input: CoordinatorAuthControllerReviewInput,
	): Promise<CoordinatorAuthControllerAttestation | null> {
		const review = captureAuthControllerReview(input);
		if (!review?.verifiedSnapshot?.accountOwnerTarget) return null;
		const source = this.db
			.prepare(AUTH_CONTROLLER_ENROLLMENT_SQL)
			.get(review.groupId, review.deviceId) as CoordinatorEnrollment | undefined;
		if (!source) return null;
		const authority = authControllerAuthorityValues(
			source,
			enrollmentRevocationKeyId(source.public_key),
		);
		return (
			(this.db
				.prepare(authControllerReviewSql(AUTH_CONTROLLER_RETRY_ACTIVE_SQL, review))
				.get(...authControllerRetryActiveValues(review, authority)) as
				| CoordinatorAuthControllerAttestation
				| undefined) ?? null
		);
	}
}
