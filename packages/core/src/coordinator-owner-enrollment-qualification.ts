import { connectionRequesterGuard } from "./coordinator-account-connection-link.js";
import { readConnectionSchemaState } from "./coordinator-account-connection-schema.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { authSchemaDefinitionCheck } from "./coordinator-auth-device-claim-schema.js";
import {
	type AuthLinkBackend,
	type AuthLinkStatement,
	authLinkNow,
} from "./coordinator-auth-link.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import { capture, captureAuthLinkConfig, isHash } from "./coordinator-auth-link-input.js";
import { authLinkLiveGenerationSql } from "./coordinator-auth-link-liveness.js";
import { authDeviceClaimProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS,
	type CoordinatorOwnerEnrollmentQualificationRow,
} from "./coordinator-owner-enrollment-qualification-schema.js";

/** Internal admin capability only. No route, store startup, grant or owner consumer uses it. */
export type OwnerQualificationRejected = {
	kind: "rejected";
	error: "invalid_input" | "unavailable" | "preview_changed" | "qualification_conflict";
};
/** The write may have committed. This is not a denial or proof of rollback. */
export type OwnerQualificationOutcomeUnknown = { kind: "outcome_unknown" };
export interface OwnerQualificationPreview {
	kind: "ready";
	digest: string;
	attestationId: string;
	reviewReceiptId: string;
	linkId: string;
	claimId: string;
	identityId: string;
	groupId: string;
	deviceId: string;
	fingerprint: string;
}

// Fixed order is the canonical encoding, shared by the digest and winning SQL.
// Include actual current enrollment separately from the review's historical label.
const BIRTH = {
	coordinator_id: "l.coordinator_id",
	link_id: "l.link_id",
	device_claim_id: "d.claim_id",
	identity_id: "l.identity_id",
	source_group_id: "a.group_id",
	device_id: "a.device_id",
	public_key: "a.public_key",
	fingerprint: "a.fingerprint",
	key_id: "d.key_id",
	controller_attestation_id: "a.attestation_id",
	controller_attestation_revision: "a.revision",
	controller_attestation_created_at: "a.created_at",
	review_receipt_id: "a.review_receipt_id",
	evidence_digest: "a.evidence_digest",
	enrollment_identity_id: "a.enrollment_identity_id",
	link_attempt_id: "l.attempt_id",
	link_auth_config_revision: "l.auth_config_revision",
	link_created_at_ms: "l.created_at_ms",
} as const;
type Birth = Omit<
	CoordinatorOwnerEnrollmentQualificationRow,
	"qualification_id" | "created_at_ms" | "revoked_at_ms"
>;
interface Source extends Birth {
	snapshot: string;
}
const SNAPSHOT = `json_array(${[
	...Object.values(BIRTH),
	"l.issuer",
	"l.subject",
	"l.authority_kind",
	"l.controller_attestation_id",
	"l.signin_floor",
	"l.revoked_at_ms",
	"d.identity_id",
	"d.group_id",
	"d.device_id",
	"d.public_key",
	"d.fingerprint",
	"d.attempt_id",
	"d.issuer",
	"d.auth_config_revision",
	"d.created_at_ms",
	"e.identity_id",
	"e.public_key",
	"e.fingerprint",
	"e.enabled",
	"e.created_at",
	"e.display_name",
].join(",")})`;
const SOURCE = `FROM coordinator_auth_controller_attestations a
 JOIN enrolled_devices e ON e.group_id=a.group_id AND e.device_id=a.device_id
 JOIN groups g ON g.group_id=e.group_id
 JOIN coordinator_auth_account_links l ON l.coordinator_id=a.coordinator_id AND l.identity_id=a.identity_id
 JOIN coordinator_auth_device_claims d ON d.coordinator_id=l.coordinator_id AND d.claim_id=l.device_claim_id
 WHERE (a.coordinator_id=? AND a.attestation_id=? AND l.issuer=?)
 AND (a.revoked_at IS NULL AND a.revision=1 AND length(a.review_receipt_id)>0 AND length(a.evidence_digest)=64)
 AND (e.public_key=a.public_key AND e.fingerprint=a.fingerprint AND e.enabled=1 AND g.archived_at IS NULL)
 AND (e.identity_id IS NULL OR e.identity_id=a.identity_id)
 AND e.identity_id IS a.enrollment_identity_id
 AND (a.enrollment_identity_id IS NULL OR a.enrollment_identity_id=a.identity_id)
 AND (d.identity_id=a.identity_id AND d.group_id=a.group_id AND d.device_id=a.device_id
 AND d.public_key=a.public_key AND d.fingerprint=a.fingerprint)
 AND (${authLinkLiveGenerationSql({ link: "l", connections: true })})
 AND (${authDeviceClaimProvenanceSql({ link: "l", connections: true })})`;
const SOURCE_COLUMNS = Object.entries(BIRTH)
	.map(([name, expression]) => `${expression} AS ${name}`)
	.join(",");
const QUALIFICATION_READY = COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS.map(
	(sql, index) =>
		authSchemaDefinitionCheck(
			sql.replace(/^(?:\s|--[^\n]*\n)*/u, "").replace(/;\s*$/u, ""),
			index === 0 ? { auxiliaryObjects: 5 } : undefined,
		).matches,
).join(" AND ");

async function digestSource(source: Source, config: CoordinatorAuthLinkConfig): Promise<string> {
	const bytes = new TextEncoder().encode(
		JSON.stringify([
			"codemem.owner-enrollment-qualification.preview.v1",
			config.enabled,
			config.coordinatorId,
			config.issuer,
			config.revision,
			source.snapshot,
		]),
	);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function preview(source: Source, digest: string): OwnerQualificationPreview {
	return {
		kind: "ready",
		digest,
		attestationId: source.controller_attestation_id,
		reviewReceiptId: source.review_receipt_id,
		linkId: source.link_id,
		claimId: source.device_claim_id,
		identityId: source.identity_id,
		groupId: source.source_group_id,
		deviceId: source.device_id,
		fingerprint: source.fingerprint,
	};
}
const unavailable = (): OwnerQualificationRejected => ({ kind: "rejected", error: "unavailable" });
interface Prepared {
	source: Source;
	guard: AuthLinkStatement;
	digest: string;
}

export class OwnerEnrollmentQualificationOps {
	private readonly config: CoordinatorAuthLinkConfig | null;
	constructor(
		private readonly backend: AuthLinkBackend,
		config: CoordinatorAuthLinkConfig,
		private readonly clock: () => number = Date.now,
	) {
		// Capture trusted configuration before the first asynchronous operation.
		this.config = captureAuthLinkConfig(config);
	}
	private async schemaReady(): Promise<boolean> {
		if ((await readConnectionSchemaState(this.backend)) !== "ready") return false;
		return (
			(
				await this.backend.first<{ ready: number }>({
					sql: `SELECT (${QUALIFICATION_READY}) AS ready`,
					values: [],
				})
			)?.ready === 1
		);
	}
	private async prepare(attestationId: string, now: number): Promise<Prepared | null> {
		const c = this.config;
		if (!c?.enabled || !(await this.schemaReady())) return null;
		const source = await this.backend.first<Source>({
			sql: `SELECT ${SOURCE_COLUMNS}, ${SNAPSHOT} AS snapshot ${SOURCE}`,
			values: [c.coordinatorId, attestationId, c.issuer],
		});
		if (!source || !isHash(source.evidence_digest)) return null;
		const keyId = await ed25519KeyIdForRevocation(source.public_key);
		if (!keyId || keyId !== source.key_id) return null;
		const guard = await connectionRequesterGuard(
			this.backend,
			source.identity_id,
			{
				groupId: source.source_group_id,
				deviceId: source.device_id,
				publicKey: source.public_key,
				fingerprint: source.fingerprint,
			},
			c,
			now,
		);
		const digest = await digestSource(source, c);
		const prepared = { source, guard, digest };
		// Key classification and hashing await; never trust the earlier SELECT alone.
		if (!(await this.live(prepared))) return null;
		return prepared;
	}
	private liveStatement(p: Prepared): AuthLinkStatement {
		const c = this.config;
		if (!c) return { sql: "SELECT 1 WHERE 0", values: [] };
		return {
			sql: `${SOURCE} AND (${SNAPSHOT}=?) AND (${p.guard.sql})
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind='device_id' AND r.subject_value=a.device_id)
 OR (r.subject_kind='ed25519_key' AND r.subject_value=d.key_id))`,
			values: [
				c.coordinatorId,
				p.source.controller_attestation_id,
				c.issuer,
				p.source.snapshot,
				...p.guard.values,
			],
		};
	}
	private async live(p: Prepared): Promise<boolean> {
		const s = this.liveStatement(p);
		return !!(await this.backend.first({ sql: `SELECT 1 ${s.sql}`, values: s.values }));
	}
	async preview(input: {
		attestationId: string;
	}): Promise<OwnerQualificationPreview | OwnerQualificationRejected> {
		const i = capture(input, ["attestationId"]);
		if (!isAuthControllerId(i?.attestationId)) return { kind: "rejected", error: "invalid_input" };
		try {
			const p = await this.prepare(i.attestationId, authLinkNow(this.clock));
			if (!p) return unavailable();
			const existing = await this.existing(p);
			if (existing && !this.matches(existing, p.source))
				return { kind: "rejected", error: "qualification_conflict" };
			return preview(p.source, p.digest);
		} catch {
			return unavailable();
		}
	}
	async issue(input: {
		attestationId: string;
		expectedDigest: string;
	}): Promise<
		| { kind: "created" | "existing"; qualificationId: string }
		| OwnerQualificationRejected
		| OwnerQualificationOutcomeUnknown
	> {
		const i = capture(input, ["attestationId", "expectedDigest"]);
		if (!isAuthControllerId(i?.attestationId) || !isHash(i?.expectedDigest))
			return { kind: "rejected", error: "invalid_input" };
		let writeAttempted = false;
		try {
			const now = authLinkNow(this.clock);
			const p = await this.prepare(i.attestationId, now);
			if (!p) return unavailable();
			if (p.digest !== i.expectedDigest) return { kind: "rejected", error: "preview_changed" };
			const qualificationId = crypto.randomUUID();
			const s = this.liveStatement(p);
			const statement: AuthLinkStatement = {
				sql: `INSERT INTO coordinator_owner_enrollment_qualifications
 (qualification_id,${Object.keys(BIRTH).join(",")},created_at_ms,revoked_at_ms)
 SELECT ?,${Object.values(BIRTH).join(",")},?,NULL ${s.sql}
 AND l.created_at_ms<=? AND NOT EXISTS (SELECT 1 FROM coordinator_owner_enrollment_qualifications q
 WHERE q.coordinator_id=l.coordinator_id AND q.link_id=l.link_id)`,
				values: [qualificationId, now, ...s.values, now],
			};
			// A backend can commit and then lose the response. Never infer rollback.
			writeAttempted = true;
			const changes = await this.backend.run(statement);
			if (changes === 1) return { kind: "created", qualificationId };
			return await this.retry(p);
		} catch {
			if (writeAttempted) return { kind: "outcome_unknown" };
			return unavailable();
		}
	}
	private existing(p: Prepared): Promise<CoordinatorOwnerEnrollmentQualificationRow | null> {
		return this.backend.first({
			sql: "SELECT * FROM coordinator_owner_enrollment_qualifications WHERE coordinator_id=? AND link_id=?",
			values: [p.source.coordinator_id, p.source.link_id],
		});
	}
	/** Revoke only a fixed server-resolved record/link pair; never require the old device to live. */
	async revoke(input: {
		qualificationId: string;
		linkId: string;
	}): Promise<
		| { kind: "revoked"; qualificationId: string }
		| OwnerQualificationRejected
		| OwnerQualificationOutcomeUnknown
	> {
		const i = capture(input, ["qualificationId", "linkId"]);
		if (!isAuthControllerId(i?.qualificationId) || !isAuthControllerId(i?.linkId))
			return { kind: "rejected", error: "invalid_input" };
		let writeAttempted = false;
		try {
			const c = this.config;
			const now = authLinkNow(this.clock);
			if (!c?.enabled || !(await this.schemaReady())) return unavailable();
			const values = [c.coordinatorId, i.qualificationId, i.linkId];
			const statement: AuthLinkStatement = {
				// Clock rollback must not delay revocation or rewrite an earlier receipt.
				sql: `UPDATE coordinator_owner_enrollment_qualifications SET revoked_at_ms=MAX(?,created_at_ms)
 WHERE coordinator_id=? AND qualification_id=? AND link_id=? AND revoked_at_ms IS NULL`,
				values: [now, ...values],
			};
			writeAttempted = true;
			await this.backend.run(statement);
			const row = await this.backend.first<{ qualification_id: string }>({
				sql: `SELECT qualification_id FROM coordinator_owner_enrollment_qualifications
 WHERE coordinator_id=? AND qualification_id=? AND link_id=? AND revoked_at_ms IS NOT NULL`,
				values,
			});
			return row ? { kind: "revoked", qualificationId: row.qualification_id } : unavailable();
		} catch {
			if (writeAttempted) return { kind: "outcome_unknown" };
			return unavailable();
		}
	}
	private matches(row: CoordinatorOwnerEnrollmentQualificationRow, source: Source): boolean {
		return (
			row.revoked_at_ms === null &&
			Object.keys(BIRTH).every((key) => {
				const field = key as keyof Birth;
				return row[field] === source[field];
			})
		);
	}
	private async retry(
		p: Prepared,
	): Promise<{ kind: "existing"; qualificationId: string } | OwnerQualificationRejected> {
		// Keep one atomic snapshot, but isolate full provenance from birth matching:
		// native D1 counts both trees toward its depth limit when nested together.
		const s = this.liveStatement(p);
		const row = await this.backend.first<CoordinatorOwnerEnrollmentQualificationRow>({
			sql: `WITH qualification_live_source AS MATERIALIZED (
 SELECT ${SOURCE_COLUMNS} ${s.sql})
 SELECT q.* FROM coordinator_owner_enrollment_qualifications q
 JOIN qualification_live_source source ON ${Object.keys(BIRTH)
		.map((key) => `q.${key} IS source.${key}`)
		.join(" AND ")}
 WHERE q.revoked_at_ms IS NULL`,
			values: s.values,
		});
		return row
			? { kind: "existing", qualificationId: row.qualification_id }
			: { kind: "rejected", error: "qualification_conflict" };
	}
}
