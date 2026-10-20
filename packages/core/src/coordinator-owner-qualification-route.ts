import type { Context } from "hono";
import type { CoordinatorControllerReviewDeps } from "./coordinator-auth-controller-review-route.js";
import { authSchemaDefinitionCheck } from "./coordinator-auth-device-claim-schema.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import { captureAuthLinkConfig, isHash } from "./coordinator-auth-link-input.js";
import { isCoordinatorControllerAttestationReference } from "./coordinator-identity-group-grant-client.js";
import { OwnerEnrollmentQualificationOps } from "./coordinator-owner-enrollment-qualification.js";
import { COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL } from "./coordinator-owner-enrollment-schema.js";

export interface OwnerQualificationRouteDeps
	extends Pick<
		CoordinatorControllerReviewDeps,
		"adminSecret" | "readRequestBytes" | "parseJsonObject" | "rateLimitedResponse"
	> {
	config: CoordinatorAuthLinkConfig;
	/** Must be the backend of the selected runtime store, never a separate database. */
	backend: AuthLinkBackend;
}

// These are frozen repository DDL statements, not caller-supplied SQL. Check the
// complete 0036 table, indexes and triggers without applying or rebuilding them.
// ALTER TABLE ... RENAME in 0036 quotes this one table identifier. Normalize
// only that exact leading header, never quotes within CHECK/string literals.
const RENAMED_TABLE_HEADER = 'CREATE TABLE "coordinator_owner_enrollment_attempts"';
const ATTEMPT_TABLE_SQL = `CASE WHEN substr(sql, 1, ${RENAMED_TABLE_HEADER.length}) = '${RENAMED_TABLE_HEADER}'
 THEN 'CREATE TABLE coordinator_owner_enrollment_attempts' || substr(sql, ${RENAMED_TABLE_HEADER.length + 1}) ELSE sql END`;
export const ownerQualificationAttemptDefinitionChecks =
	COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL.replace(/^--[^\n]*$/gm, "")
		.trim()
		.split(/\n(?=CREATE )/u)
		.map((sql, index) => {
			const check = authSchemaDefinitionCheck(
				sql.trim().replace(/;$/u, ""),
				index === 0 ? { auxiliaryObjects: 13 } : undefined,
			);
			if (index !== 0) return check;
			// The generated predicate references sqlite_master.sql once. Preserve its
			// full-definition comparison and exact auxiliary-object count.
			return { ...check, matches: check.matches.replace(/\bsql\b/u, ATTEMPT_TABLE_SQL) };
		});
const ATTEMPT_READY = ownerQualificationAttemptDefinitionChecks
	.map((check) => check.matches)
	.join(" AND ");

async function authenticate(provided: string | undefined, configured: string | null) {
	if (!provided || !configured || provided.length > 8192) return false;
	const digest = (value: string) =>
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	const [expected, actual] = await Promise.all([digest(configured), digest(provided)]);
	const key = await crypto.subtle.importKey(
		"raw",
		expected,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, expected);
	return crypto.subtle.verify("HMAC", key, signature, actual);
}

function parseInput(data: Record<string, unknown> | null) {
	if (
		!data ||
		Object.keys(data).some((key) => !["attestation_id", "confirm_evidence_digest"].includes(key))
	)
		return null;
	if (!isCoordinatorControllerAttestationReference(data.attestation_id)) return null;
	if (Object.hasOwn(data, "confirm_evidence_digest") && !isHash(data.confirm_evidence_digest))
		return null;
	return {
		attestationId: data.attestation_id,
		expectedDigest: data.confirm_evidence_digest as string | undefined,
	};
}

async function authorize(c: Context, deps: OwnerQualificationRouteDeps): Promise<Response | null> {
	const authenticated = await authenticate(
		c.req.header("X-Codemem-Coordinator-Admin"),
		deps.adminSecret(),
	);
	const limited = deps.rateLimitedResponse(
		c,
		`owner-qualification:${authenticated ? "admin" : "anonymous"}`,
		{ authenticated },
	);
	if (limited) return limited;
	if (!authenticated) return c.json({ error: "unauthorized" }, 401);
	return null;
}

async function previewResponse(
	c: Context,
	ops: OwnerEnrollmentQualificationOps,
	attestationId: string,
	coordinatorId: string,
) {
	const result = await ops.preview({ attestationId });
	if (result.kind === "rejected") return c.json({ error: result.error }, 409);
	return c.json({
		state: "ready",
		coordinator_id: coordinatorId,
		evidence_digest: result.digest,
		attestation_id: result.attestationId,
		review_receipt_id: result.reviewReceiptId,
		link_id: result.linkId,
		claim_id: result.claimId,
		identity_id: result.identityId,
		group_id: result.groupId,
		device_id: result.deviceId,
		fingerprint: result.fingerprint,
	});
}

async function issueResponse(
	c: Context,
	ops: OwnerEnrollmentQualificationOps,
	input: { attestationId: string; expectedDigest: string },
	coordinatorId: string,
) {
	try {
		const result = await ops.issue(input);
		if (result.kind === "outcome_unknown")
			return c.json({ error: "qualification_outcome_unknown" }, 503);
		if (result.kind === "rejected") return c.json({ error: result.error }, 409);
		return c.json(
			{
				state: result.kind,
				qualification_id: result.qualificationId,
				attestation_id: input.attestationId,
				coordinator_id: coordinatorId,
				evidence_digest: input.expectedDigest,
			},
			result.kind === "created" ? 201 : 200,
		);
	} catch {
		return c.json({ error: "qualification_outcome_unknown" }, 503);
	}
}

/** Inactive seam: no production app registers this handler yet. */
export function createOwnerQualificationHandler(
	deps: OwnerQualificationRouteDeps,
): (c: Context) => Promise<Response> {
	const config = captureAuthLinkConfig(deps.config);
	const captured = { ...deps };
	const ops = config ? new OwnerEnrollmentQualificationOps(captured.backend, config) : null;
	return async (c) => {
		c.header("Cache-Control", "no-store");
		c.header("Referrer-Policy", "no-referrer");
		c.header("X-Content-Type-Options", "nosniff");
		try {
			const denied = await authorize(c, captured);
			if (denied) return denied;
			if (!config?.enabled || !ops) return c.json({ error: "qualification_unavailable" }, 503);
			const raw = await captured.readRequestBytes(c, 4096);
			if (!raw) return c.json({ error: "body_too_large" }, 413);
			const input = parseInput(captured.parseJsonObject(raw));
			if (!input) return c.json({ error: "qualification_invalid_input" }, 400);
			const ready = await captured.backend.first<{ ready: number }>({
				sql: `SELECT (${ATTEMPT_READY}) AS ready`,
				values: [],
			});
			if (ready?.ready !== 1) return c.json({ error: "qualification_unavailable" }, 503);
			if (input.expectedDigest === undefined)
				return await previewResponse(c, ops, input.attestationId, config.coordinatorId);
			return await issueResponse(
				c,
				ops,
				{ attestationId: input.attestationId, expectedDigest: input.expectedDigest },
				config.coordinatorId,
			);
		} catch {
			return c.json({ error: "qualification_unavailable" }, 503);
		}
	};
}
