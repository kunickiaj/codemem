import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import {
	AUTH_DEVICE_CLAIM_BINDING_STRUCTURE_SQL,
	AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import { captureAuthLinkConfig } from "./coordinator-auth-link-input.js";
import {
	authClaimGenesisSql,
	authDeviceClaimProvenanceSql,
} from "./coordinator-auth-link-provenance.js";
import {
	captureDeviceClaimBindingInput,
	type DeviceClaimBindingInput,
} from "./coordinator-device-claim-binding-contract.js";
import {
	assertPredicate,
	type ExistingFirstLinkBinding,
	existingFirstLinkBindingPin,
	readExistingFirstLinkBinding,
	reuseFirstLinkBindingStatements,
} from "./coordinator-device-claim-binding-reuse.js";
import { legacyDecisionCountsAsOwnerSql } from "./coordinator-legacy-team-completion.js";
import { readNegativeOwnerConsistency } from "./coordinator-owner-negative-read-set.js";

export interface PreparedDeviceClaimBinding {
	guard: AuthLinkStatement;
	enrollments: string;
	enrollmentCount: number;
	nullCount: number;
	input: DeviceClaimBindingInput;
	coordinatorId: string;
	now: number;
	/** Producer only: preserve this immutable positive ownership instead of minting. */
	existingBinding?: ExistingFirstLinkBinding;
	completedGuard?: AuthLinkStatement;
	/**
	 * Re-run the retained-ownership reads. They fail with the binding's own error, so a
	 * changed fact refuses the binding exactly as the old pin inside `guard` did, and they
	 * run where that pin ran: just before the binding's first write.
	 */
	negativeGuards: AuthLinkStatement[];
	/** The retained facts only, checked again after the enrollment update. */
	completedNegativeGuards: AuthLinkStatement[];
}

const LIVE_SIGNER = `EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id=e.group_id
 WHERE e.group_id=p.group_id AND e.device_id=p.device_id AND e.public_key=p.public_key
 AND e.fingerprint=p.fingerprint AND e.enabled=1 AND g.archived_at IS NULL
 AND (e.identity_id IS NULL OR e.identity_id=p.identity_id))`;
const EXACT_ENROLLMENTS = `(SELECT count(*) FROM enrolled_devices WHERE device_id=p.device_id)=json_array_length(?)
 AND NOT EXISTS (SELECT 1 FROM enrolled_devices e WHERE e.device_id=p.device_id AND NOT EXISTS
 (SELECT 1 FROM json_each(?) r WHERE e.group_id=json_extract(r.value,'$.groupId')
 AND e.public_key=json_extract(r.value,'$.publicKey') AND e.fingerprint=json_extract(r.value,'$.fingerprint')
 AND e.identity_id IS json_extract(r.value,'$.identityId') AND e.enabled=json_extract(r.value,'$.enabled')))`;
const NO_REVOCATION = `NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind='device_id' AND r.subject_value=p.device_id) OR (r.subject_kind='ed25519_key' AND r.subject_value=p.key_id))`;
const NO_BINDING = `NOT EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b WHERE b.device_id=p.device_id OR b.key_id=p.key_id)`;
// Legacy completion checks this requester only. A peer's legitimate prior
// inclusion under X must not reinstate first-link's no-other-owner restriction.
const LEGACY_MANIFEST = `CASE WHEN typeof(c.manifest_json)='text' AND json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END`;
const REQUESTER_LEGACY_COMPATIBLE = `NOT EXISTS (SELECT 1 FROM coordinator_legacy_team_completions c,
 json_each(${LEGACY_MANIFEST},'$.device_decisions') d
 WHERE json_extract(${LEGACY_MANIFEST},'$.coordinator_id')=p.coordinator_id
 AND (json_extract(d.value,'$.device_id')=p.device_id OR json_extract(d.value,'$.key_fingerprint')=p.fingerprint)
 AND (${legacyDecisionCountsAsOwnerSql("d.value", "deny")})
 AND (json_extract(d.value,'$.decision')='excluded' OR json_extract(d.value,'$.identity_id') IS NOT p.identity_id))`;

export function deviceClaimBindingGenesisSql(connections: boolean): string {
	return connections
		? authClaimGenesisSql("d")
		: `EXISTS (SELECT 1 FROM coordinator_auth_account_links l WHERE l.coordinator_id=d.coordinator_id AND l.link_id=d.claim_id AND ${authDeviceClaimProvenanceSql({ link: "l" })})`;
}
function claimSource(connections: boolean) {
	return `EXISTS (SELECT 1 FROM binding_genesis d JOIN binding_live_links l ON l.device_claim_id=d.claim_id)
 AND (SELECT count(*) FROM coordinator_auth_device_claims d WHERE d.coordinator_id=p.coordinator_id
 AND (d.device_id=p.device_id OR d.key_id=p.key_id))=1
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_audit_log a WHERE a.coordinator_id=p.coordinator_id
 AND a.identity_id=p.identity_id AND a.action='link_revoked')${connections ? ` AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id=p.coordinator_id AND h.identity_id=p.identity_id AND h.revoked_at_ms IS NOT NULL)` : ""}`;
}

// Positive provenance stays in independent root stages. Nesting the two proof
// expressions beneath the compatibility conjunction exceeds native D1 depth 100.
function claimSourceStages(connections: boolean): string {
	return `binding_claims AS MATERIALIZED (SELECT d.* FROM coordinator_auth_device_claims d JOIN claim_input p
 ON (d.coordinator_id=p.coordinator_id AND d.identity_id=p.identity_id AND d.group_id=p.group_id)
 AND (d.device_id=p.device_id AND d.public_key=p.public_key AND d.fingerprint=p.fingerprint)
 AND (d.key_id=p.key_id AND d.issuer=p.issuer)),
 binding_genesis AS MATERIALIZED (SELECT d.claim_id FROM binding_claims d WHERE ${deviceClaimBindingGenesisSql(connections)}),
 binding_link_candidates AS MATERIALIZED (SELECT l.* FROM coordinator_auth_account_links l JOIN claim_input p
 ON l.coordinator_id=p.coordinator_id AND l.identity_id=p.identity_id AND l.issuer=p.issuer WHERE l.revoked_at_ms IS NULL),
 binding_live_links AS MATERIALIZED (SELECT l.device_claim_id FROM binding_link_candidates l WHERE ${authDeviceClaimProvenanceSql({ link: "l", connections })})`;
}

/** Captures server metadata only. The returned SQL must run inside the winning batch.
 * Unlike first-link eligibility, existing own claim/link, peer bindings and grants
 * are allowed. No attestation or negative-owner result supplies positive authority.
 */
export async function prepareDeviceClaimBinding(
	backend: AuthLinkBackend,
	input: DeviceClaimBindingInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<PreparedDeviceClaimBinding | null> {
	return prepareBinding(backend, input, config, now, { reuseExistingBinding: false });
}

/** First-link producer only. Existing ownership keeps its original provenance. */
export async function prepareFirstLinkDeviceClaimBinding(
	backend: AuthLinkBackend,
	input: DeviceClaimBindingInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<PreparedDeviceClaimBinding | null> {
	return prepareBinding(backend, input, config, now, { reuseExistingBinding: true });
}

async function captureBindingPreparation(
	backend: AuthLinkBackend,
	value: DeviceClaimBindingInput,
	configuration: CoordinatorAuthLinkConfig,
	now: number,
) {
	const input = captureDeviceClaimBindingInput(value);
	const config = captureAuthLinkConfig(configuration);
	if (!input || !config?.enabled || !Number.isSafeInteger(now) || now < 0) return null;
	const captured = await captureDeviceClaimEligibility(
		backend,
		{ signer: input.signer, identityId: input.currentIdentityId },
		config,
		now,
	);
	if (!captured) return null;
	return { input, config, captured };
}

function completedEnrollmentSnapshot(enrollments: string, identityId: string): string {
	return JSON.stringify(
		(JSON.parse(enrollments) as Record<string, unknown>[]).map((row) => ({ ...row, identityId })),
	);
}

/** Its guards fail with the binding's own error, as the old pin inside `guard` made it fail. */
function readBindingNegativeOwner(
	backend: AuthLinkBackend,
	input: DeviceClaimBindingInput,
	coordinatorId: string,
) {
	return readNegativeOwnerConsistency(
		backend,
		{
			coordinatorId,
			deviceId: input.signer.deviceId,
			publicKey: input.signer.publicKey,
			fingerprint: input.signer.fingerprint,
			ownerIdentityId: input.currentIdentityId,
			enrollment: { groupId: input.signer.groupId },
		},
		{ guard: (holds) => assertPredicate(holds) },
	);
}

async function prepareBinding(
	backend: AuthLinkBackend,
	value: DeviceClaimBindingInput,
	configuration: CoordinatorAuthLinkConfig,
	now: number,
	options: { reuseExistingBinding: boolean },
): Promise<PreparedDeviceClaimBinding | null> {
	const prepared = await captureBindingPreparation(backend, value, configuration, now);
	if (!prepared) return null;
	const { input, config, captured } = prepared;
	const existingBinding = options.reuseExistingBinding
		? await readExistingFirstLinkBinding(
				backend,
				input,
				config.coordinatorId,
				captured.values[6] as string,
			)
		: undefined;
	if (existingBinding === null) return null;
	const bindingGuard = existingBinding
		? existingFirstLinkBindingPin(existingBinding)
		: { sql: NO_BINDING, values: [] };
	const negative = await readBindingNegativeOwner(backend, input, config.coordinatorId);
	if (!negative) return null;
	const row = await backend.first<{ rows: string; null_count: number }>({
		sql: `SELECT json_group_array(json_object('groupId',group_id,'publicKey',public_key,'fingerprint',fingerprint,'identityId',identity_id,'enabled',enabled)) AS rows,
 sum(identity_id IS NULL) AS null_count FROM (SELECT * FROM enrolled_devices WHERE device_id=? ORDER BY group_id LIMIT 51)`,
		values: [input.signer.deviceId],
	});
	const count = JSON.parse(row?.rows ?? "[]").length as number;
	if (!row || count < 1 || count > 50) return null;
	const connections = await hasConnectionSessionSchema(backend);
	const guardInput = {
		captured: captured.values,
		connections,
		bindingGuard,
		enrollments: row.rows,
	};
	return {
		input,
		coordinatorId: config.coordinatorId,
		now,
		enrollments: row.rows,
		enrollmentCount: count,
		nullCount: row.null_count,
		existingBinding,
		guard: bindingPlanGuard(guardInput),
		completedGuard: existingBinding
			? bindingPlanGuard({
					...guardInput,
					enrollments: completedEnrollmentSnapshot(row.rows, input.currentIdentityId),
				})
			: undefined,
		negativeGuards: negative.guards,
		completedNegativeGuards: existingBinding ? negative.retainedGuards : [],
	};
}

function bindingPlanGuard(input: {
	captured: AuthLinkStatement["values"];
	connections: boolean;
	bindingGuard: AuthLinkStatement;
	enrollments: string;
}): AuthLinkStatement {
	const { captured, connections, bindingGuard, enrollments } = input;
	// SQLite 3.54.0 and 3.54.1 (production D1) refuse a statement that resolves a CTE
	// name after about 100 table references. Checks that reference CTEs come first and
	// binding_guards is the last FROM term of binding_ok, so the plain-table checks
	// after them are not counted. The two checks with bound values keep their order.
	const checks = [
		claimSource(connections),
		AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
		LIVE_SIGNER,
		EXACT_ENROLLMENTS,
		NO_REVOCATION,
		bindingGuard.sql,
		AUTH_DEVICE_CLAIM_BINDING_STRUCTURE_SQL,
		AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
		AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
		AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
		REQUESTER_LEGACY_COMPATIBLE,
	];
	return {
		sql: `${AUTH_DEVICE_CLAIM_INPUT_SQL}, ${claimSourceStages(connections)},
 binding_guards AS MATERIALIZED (SELECT ${checks.map((check, index) => `(${check}) AS g${index}`).join(",")} FROM claim_input p),
 binding_ok AS MATERIALIZED (SELECT ${checks.map((_, index) => `g${index}`).join(" AND ")} AS ok FROM binding_guards)
 SELECT p.*,d.claim_id FROM claim_input p JOIN coordinator_auth_device_claims d ON d.coordinator_id=p.coordinator_id AND d.device_id=p.device_id
 WHERE (SELECT ok FROM binding_ok)=1`,
		values: [...captured, enrollments, enrollments, ...bindingGuard.values],
	};
}

/** The invalid JSON path fails before any BEFORE INSERT trigger can use
 * RAISE(IGNORE) to suppress the assertion. A satisfied count projects no rows.
 */
function assertChanges(expected: number): AuthLinkStatement {
	return {
		sql: `INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
 SELECT json_extract('{}','device_claim_binding_count_mismatch'),NULL,NULL,NULL,NULL,NULL,NULL,NULL WHERE changes()<>?`,
		values: [expected],
	};
}

/** Append after the producer's original strict first-link winning writes, or use
 * the legacy service. Never execute these outside an atomic batch. The claim,
 * genesis attempt/link/audit, and current link must already exist at execution.
 */
export function deviceClaimBindingStatements(
	plan: PreparedDeviceClaimBinding,
	bindingId: string,
	eventId: string,
	options: {
		/** Trusted SQL predicate identifying the exact finalized producer winner, with bound values. */ winning?: AuthLinkStatement;
	} = {},
): AuthLinkStatement[] {
	const { input, coordinatorId, now } = plan;
	const pins = [coordinatorId, bindingId, input.signer.deviceId, input.currentIdentityId];
	const winner = `b.coordinator_id=? AND b.binding_id=? AND b.device_id=? AND b.identity_id=? AND b.provenance='owner_enrollment'`;
	const writes = plan.existingBinding
		? reuseFirstLinkBindingStatements(plan, plan.existingBinding)
		: [
				...plan.negativeGuards,
				{
					sql: `INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
 SELECT device_id,key_id,identity_id,coordinator_id,?,'owner_enrollment','device_claim:'||claim_id,? FROM (${plan.guard.sql}) WHERE 1`,
					values: [bindingId, new Date(now).toISOString(), ...plan.guard.values],
				},
				assertChanges(1),
				{
					sql: `UPDATE enrolled_devices SET identity_id=? WHERE device_id=? AND identity_id IS NULL AND public_key=? AND fingerprint=?
 AND EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b WHERE ${winner})`,
					values: [
						input.currentIdentityId,
						input.signer.deviceId,
						input.signer.publicKey,
						input.signer.fingerprint,
						...pins,
					],
				},
				assertChanges(plan.nullCount),
				// The existing immutable self-bind audit accepts previous=target. It records
				// the binding, exact enrollment count and completion time without a new schema.
				{
					sql: `INSERT INTO coordinator_device_rebind_audit_log
 (coordinator_id,event_id,attempt_id,action,binding_id,device_id,previous_identity_id,target_identity_id,enrollment_count,created_at_ms)
 SELECT b.coordinator_id,?,b.source_ref,'owner_device_rebound',b.binding_id,b.device_id,b.identity_id,b.identity_id,?,?
 FROM coordinator_device_ownership_bindings b WHERE ${winner}`,
					values: [eventId, plan.enrollmentCount, now, ...pins],
				},
				assertChanges(1),
			];
	if (!options.winning) return writes;
	const winning = options.winning;
	return writes.map((statement) => ({
		sql: `WITH binding_write_winner AS MATERIALIZED (SELECT (${winning.sql}) AS won) ${statement.sql} AND (SELECT won FROM binding_write_winner)=1`,
		values: [...winning.values, ...statement.values],
	}));
}
