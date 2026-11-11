import { CONNECTION_RELINK_ELIGIBLE_SQL } from "./coordinator-account-connection-link.js";
import { connectionProfileColumns } from "./coordinator-account-connection-session.js";
import { projectAccountProfileView } from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_ELIGIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_ROW_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
	type CoordinatorDeviceClaimReadiness,
	type CoordinatorDeviceClaimReadinessInput,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import { AUTH_CURRENT_LEGACY_ASSIGNMENT_SQL } from "./coordinator-auth-legacy-assignment.js";
import {
	AUTH_LINK_CONTROLLER_SOURCE_SQL,
	type AuthLinkBackend,
	type AuthLinkStatement,
	authLinkControllerSourceValues,
	authLinkNow,
	captureAuthLinkConfig,
	captureAuthLinkSigner,
} from "./coordinator-auth-link.js";
import type { CoordinatorAccountLinkStatusV2 } from "./coordinator-auth-link-authority.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import {
	authAccountLinkProvenanceSql,
	authClaimGenesisSql,
	authDeviceClaimProvenanceSql,
} from "./coordinator-auth-link-provenance.js";
import { authPersistenceError } from "./coordinator-auth-schema.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

/** Public device-authenticated response. No account identifiers or credentials. */
export type CoordinatorAccountLinkStatus = CoordinatorAccountLinkStatusV2;
export interface CoordinatorAccountLinkStatusStore {
	readAccountLinkStatus(
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
		options: { identityId: string },
	): Promise<CoordinatorAccountLinkStatus>;
}
interface StatusRow {
	identity_id: string;
	link_id: string | null;
	issuer: string | null;
	revoked_at_ms: number | null;
	display_name: unknown;
	email: unknown;
	email_verified: unknown;
	picture_url: unknown;
	authority: "device_claim" | "controller_attestation";
	valid: number;
	/** 1 when the proof is this device's own claim or attestation, not a peer's. */
	own: number;
	/** 1 when this exact device key holds an ownership binding for the Identity. */
	bound: number;
	claim_count: number;
	controller_count: number;
	controller_identity: string | null;
}

function safeDisplayText(value: unknown, maxLength: number): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		value.trim().length === 0 ||
		/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	)
		return undefined;
	return value;
}

function claimConflicts(row: StatusRow): boolean {
	return (
		row.claim_count > 0 &&
		(row.claim_count !== 1 ||
			row.valid !== 1 ||
			row.controller_count > 1 ||
			(row.controller_identity !== null && row.controller_identity !== row.identity_id))
	);
}

function projectStatus(
	base: Extract<CoordinatorAccountLinkStatus, { state: "review_required" | "conflict" }>,
	row: StatusRow | null,
	config: CoordinatorAuthLinkConfig,
	identityId: string,
): CoordinatorAccountLinkStatus {
	if (!row) return base;
	if (claimConflicts(row))
		return { ...base, state: "conflict", identityId: null, authority: null, account: null };
	if (row.valid !== 1 || row.controller_count > 1) return base;
	const derived = { ...base, identityId: row.identity_id, authority: row.authority };
	if (row.revoked_at_ms !== null) return { ...derived, state: "revoked", account: null };
	if (row.link_id === null) {
		if (row.identity_id !== identityId) return base;
		return { ...derived, state: "unlinked", account: null };
	}
	if (row.issuer !== config.issuer) return { ...base, state: "conflict" };
	return { ...derived, state: "linked", account: requesterAccount(row, identityId) };
}

/** This device's own claim, ownership binding, or current attestation for the same Identity. */
function requesterHoldsProof(row: StatusRow): boolean {
	return (
		row.own === 1 ||
		row.bound === 1 ||
		(row.controller_count === 1 && row.controller_identity === row.identity_id)
	);
}

/**
 * Profile details need this device's own proof. A peer of the Identity learns
 * only that the account is linked elsewhere (ADR 0005 Section 8).
 */
function requesterAccount(
	row: StatusRow,
	identityId: string,
): CoordinatorAccountLinkStatus["account"] {
	if (row.identity_id !== identityId || !requesterHoldsProof(row)) return null;
	const account: NonNullable<CoordinatorAccountLinkStatus["account"]> = {};
	const displayName = safeDisplayText(row.display_name, 256);
	const email = row.email_verified === 1 ? safeDisplayText(row.email, 320) : undefined;
	if (displayName !== undefined) account.displayName = displayName;
	if (email !== undefined) account.email = email;
	const { pictureUrl } = projectAccountProfileView(
		{ pictureUrl: row.picture_url },
		row.issuer ?? "",
	);
	if (pictureUrl !== undefined) account.pictureUrl = pictureUrl;
	return account;
}

/** This exact device key's ownership binding for the requested Identity (ADR 0005 Section 8). */
const REQUESTER_BINDING_SQL = `SELECT 1 FROM coordinator_device_ownership_bindings ob
 WHERE ob.coordinator_id = p.coordinator_id AND ob.device_id = p.device_id AND ob.key_id = p.key_id
 AND ob.identity_id = p.identity_id`;

const NOT_REVOKED_SQL = `NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
  WHERE (r.subject_kind = 'device_id' AND r.subject_value = p.device_id)
  OR (r.subject_kind = 'ed25519_key' AND r.subject_value = p.key_id))`;
const currentEnrollmentSql = (identity: string) =>
	`EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
  WHERE e.group_id = p.group_id AND e.device_id = p.device_id AND e.public_key = p.public_key
  AND e.fingerprint = p.fingerprint AND e.enabled = 1 AND g.archived_at IS NULL
  AND (e.identity_id IS NULL OR e.identity_id = ${identity}))`;

/** This device's old claim under another Identity, once a binding moved it and that link ended. */
const SUPERSEDED_OWN_CLAIM_SQL = `d.identity_id <> p.identity_id AND EXISTS (${REQUESTER_BINDING_SQL})
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links al WHERE al.coordinator_id = d.coordinator_id
 AND al.identity_id = d.identity_id AND al.revoked_at_ms IS NULL)`;

const CANDIDATE_FIELDS = ["identity_id", "link_id", "issuer", "revoked_at_ms", "valid", "own"];
const jsonRows = (fields: string[]) =>
	`json_group_array(json_object(${fields.map((field) => `'${field}',${field}`).join(",")}))`;
const fromJson = (alias: string, fields: string[]) =>
	fields.map((field) => `json_extract(${alias}.value,'$.${field}') AS ${field}`).join(",");
const GENESIS_ROWS = `(SELECT json_extract(value,'$.claim_id') AS claim_id FROM json_each(p.genesis))`;
const LINK_ROWS = `(SELECT json_extract(value,'$.link_id') AS link_id,
 json_extract(value,'$.authority_kind') AS authority_kind FROM json_each(p.links))`;
const NO_CLAIMS = "json_array_length(p.claims) = 0";
const NO_CONTROLLER = "json_array_length(p.controllers) = 0";

/**
 * One statement, so authority, current enrollment, tombstones and metadata share a
 * snapshot. It uses no WITH: SQLite 3.54.0 and 3.54.1 (production D1) refuse a
 * statement that resolves a WITH name after about 100 table references, and every
 * reference to a WITH block counts its tables again. Each stage is instead a one-row
 * FROM subquery named p that adds a JSON column to the stage inside it, and later
 * stages read those columns with json_each. OFFSET keeps SQLite from flattening a
 * stage into its consumers, so each stage is computed once.
 *
 * Stages, innermost first: the 15 inputs; this device's current controller
 * attestations, its exact legacy assignment and (connection schema) the verified
 * claim genesis; verified links; claims; candidates.
 */
function statusSql(connections: boolean): string {
	// A current attestation for this exact enrollment whose device and key are not revoked.
	const controllers = `(SELECT json_group_array(c.controller_identity_id) FROM (
  SELECT a.identity_id AS controller_identity_id ${AUTH_LINK_CONTROLLER_SOURCE_SQL}
  AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
  WHERE (r.subject_kind = 'device_id' AND r.subject_value = a.device_id)
  OR (r.subject_kind = 'ed25519_key' AND r.subject_value = ?))) c)`;
	const assigned = `CASE WHEN (${AUTH_CURRENT_LEGACY_ASSIGNMENT_SQL} AND ${AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL})
   AND (${AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL})
   AND (${AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL}
   AND ${AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL})
   AND (${AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL}) THEN 1 ELSE 0 END`;
	const genesis = `(SELECT json_group_array(json_object('claim_id',d.claim_id,'identity_id',d.identity_id))
  FROM coordinator_auth_device_claims d WHERE d.coordinator_id = p.coordinator_id
  AND (d.device_id = p.device_id OR d.key_id = p.key_id OR d.identity_id = p.identity_id) AND ${authClaimGenesisSql("d")})`;
	const links = `(SELECT json_group_array(json_object('link_id',l.link_id,'authority_kind',l.authority_kind))
  FROM coordinator_auth_account_links l WHERE l.coordinator_id = p.coordinator_id
  AND (l.identity_id IN (SELECT json_extract(value,'$.identity_id') FROM json_each(p.genesis))
  OR l.identity_id IN (SELECT value FROM json_each(p.controllers)))
  AND ${authAccountLinkProvenanceSql("l", { connections: true })})`;
	const ownClaimProof = connections
		? "(sg.claim_id IS NOT NULL AND (l.link_id IS NULL OR sl.link_id IS NOT NULL))"
		: authDeviceClaimProvenanceSql({ link: "l", canonicalKeyId: "?" });
	const peerClaimProof = connections
		? "(sl.link_id IS NOT NULL AND sl.authority_kind = 'device_claim')"
		: authDeviceClaimProvenanceSql({ link: "l" });
	const claims = `(SELECT ${jsonRows(CANDIDATE_FIELDS)} FROM (
  SELECT d.identity_id, l.link_id, l.issuer, l.revoked_at_ms,
  CASE WHEN (l.identity_id = d.identity_id${connections ? " OR (l.link_id IS NULL AND sg.claim_id IS NOT NULL)" : ""})
  AND ${currentEnrollmentSql("d.identity_id")}
  AND ${NOT_REVOKED_SQL}
  AND ((d.group_id = p.group_id AND d.device_id = p.device_id
  AND d.key_id = p.key_id AND d.fingerprint = p.fingerprint
  AND ${ownClaimProof})
  OR (d.identity_id = p.identity_id AND d.device_id <> p.device_id
  AND d.key_id <> p.key_id AND d.fingerprint <> p.fingerprint
  AND p.assigned = 1
  AND ${peerClaimProof}))
  THEN 1 ELSE 0 END AS valid,
  CASE WHEN d.device_id = p.device_id AND d.key_id = p.key_id THEN 1 ELSE 0 END AS own
  FROM coordinator_auth_device_claims d
  LEFT JOIN coordinator_auth_account_links l ON l.coordinator_id = d.coordinator_id AND ${connections ? "l.identity_id = d.identity_id" : "l.device_claim_id = d.claim_id"}
  ${connections ? `LEFT JOIN ${GENESIS_ROWS} sg ON sg.claim_id = d.claim_id LEFT JOIN ${LINK_ROWS} sl ON sl.link_id = l.link_id` : ""}
  WHERE d.coordinator_id = p.coordinator_id
  AND (d.device_id = p.device_id OR d.key_id = p.key_id
  OR (d.identity_id = p.identity_id AND p.assigned = 1))
  AND NOT (${SUPERSEDED_OWN_CLAIM_SQL})))`;
	// A rebound device has no claim of its own; its binding names the Identity and the
	// Identity's link is the account. Valid only while the device's exact enrollment is
	// current, neither device nor key is revoked, and the link was born through a
	// reviewed claim or attestation.
	const candidates = `(SELECT ${jsonRows([...CANDIDATE_FIELDS, "authority"])} FROM (
  SELECT ${fromJson("c", CANDIDATE_FIELDS)}, 'device_claim' AS authority FROM json_each(p.claims) c
  UNION ALL SELECT a.value, l.link_id, l.issuer, l.revoked_at_ms,
  ${connections ? "CASE WHEN l.link_id IS NULL OR valid_controller.link_id IS NOT NULL THEN 1 ELSE 0 END" : "1"}, 1, 'controller_attestation'
  FROM json_each(p.controllers) a LEFT JOIN coordinator_auth_account_links l ON l.coordinator_id = p.coordinator_id
  AND l.identity_id = a.value ${connections ? "" : "AND l.authority_kind = 'controller_attestation' AND l.controller_attestation_id IS NOT NULL AND l.device_claim_id IS NULL"}
  ${connections ? `LEFT JOIN ${LINK_ROWS} valid_controller ON valid_controller.link_id = l.link_id` : ""}
  WHERE ${NO_CLAIMS}
  UNION ALL SELECT ob.identity_id, l.link_id, l.issuer, l.revoked_at_ms,
  CASE WHEN ${currentEnrollmentSql("ob.identity_id")}
  AND ${NOT_REVOKED_SQL}
  AND (l.link_id IS NULL OR ${authAccountLinkProvenanceSql("l", { connections })})
  THEN 1 ELSE 0 END, 1, 'device_claim'
  FROM coordinator_device_ownership_bindings ob
  LEFT JOIN coordinator_auth_account_links l ON l.coordinator_id = p.coordinator_id AND l.identity_id = ob.identity_id
  WHERE ob.coordinator_id = p.coordinator_id AND ob.device_id = p.device_id AND ob.key_id = p.key_id
  AND ob.identity_id = p.identity_id AND ${NO_CLAIMS} AND ${NO_CONTROLLER}
  UNION ALL SELECT p.identity_id, NULL, NULL, NULL, 1, 1, 'device_claim'
  WHERE ${NO_CLAIMS} AND ${NO_CONTROLLER}
  AND NOT EXISTS (${REQUESTER_BINDING_SQL}) AND ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL}))`;
	const stage = (inner: string, columns: string) =>
		`(SELECT p.*, ${columns} FROM ${inner} p LIMIT 1 OFFSET 0)`;
	const facts = stage(
		AUTH_DEVICE_CLAIM_INPUT_ROW_SQL,
		`${controllers} AS controllers, ${assigned} AS assigned${connections ? `, ${genesis} AS genesis` : ""}`,
	);
	const linked = connections ? stage(facts, `${links} AS links`) : facts;
	const claimed = stage(linked, `${claims} AS claims`);
	const a = (field: string) => `json_extract(a.value,'$.${field}')`;
	const revoked = connections
		? `coalesce((SELECT min(h.revoked_at_ms) FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = p.coordinator_id AND h.identity_id = ${a("identity_id")} AND h.revoked_at_ms IS NOT NULL),${a("revoked_at_ms")})`
		: a("revoked_at_ms");
	const profile = connections
		? connectionProfileColumns("m")
		: `CASE WHEN m.link_id IS NOT NULL THEN m.display_name ELSE b.display_name END AS display_name,
  CASE WHEN m.link_id IS NOT NULL THEN m.email ELSE b.email END AS email,
  CASE WHEN m.link_id IS NOT NULL THEN m.email_verified ELSE b.email_verified END AS email_verified,
  CASE WHEN m.link_id IS NOT NULL THEN m.picture_url ELSE b.picture_url END AS picture_url`;
	return `SELECT ${["identity_id", "link_id", "issuer", "valid", "own", "authority"].map((field) => `${a(field)} AS ${field}`).join(",")},
 EXISTS (${REQUESTER_BINDING_SQL} AND ob.identity_id = ${a("identity_id")}) AS bound,
 ${revoked} AS revoked_at_ms,
 json_array_length(p.claims) AS claim_count,
 json_array_length(p.controllers) AS controller_count,
 json_extract(p.controllers,'$[0]') AS controller_identity,
  ${profile}
  FROM ${stage(claimed, `${candidates} AS candidates`)} p
  JOIN json_each(p.candidates) a
  LEFT JOIN coordinator_auth_account_links l ON l.coordinator_id = p.coordinator_id AND l.link_id = ${a("link_id")}
  AND l.identity_id = ${a("identity_id")} AND ${a("identity_id")} = p.identity_id AND l.issuer = ${a("issuer")}
  AND l.revoked_at_ms IS NULL
  LEFT JOIN coordinator_auth_account_profiles m ON m.coordinator_id = l.coordinator_id
  AND m.link_id = l.link_id
  LEFT JOIN coordinator_auth_link_profiles b ON b.coordinator_id = l.coordinator_id
  AND b.link_id = l.link_id AND b.attempt_id = l.attempt_id AND b.issuer = l.issuer
  AND b.subject = l.subject AND b.auth_config_revision = l.auth_config_revision LIMIT 1`;
}

/** Bound values in the order statusSql writes its placeholders. */
function statusValues(
	connections: boolean,
	captured: AuthLinkStatement["values"],
	controllerSource: AuthLinkStatement["values"],
	keyId: string,
): AuthLinkStatement["values"] {
	// Without the connection schema the own-claim proof pins the canonical key ID.
	return [...(connections ? [] : [keyId]), ...controllerSource, keyId, ...captured];
}

/** Reads only. Rechecks the exact enrollment and controller after key derivation. */
export class AccountLinkStatusOperations implements CoordinatorAccountLinkStatusStore {
	constructor(
		private readonly backend: Pick<AuthLinkBackend, "first">,
		private readonly clock: () => number = Date.now,
	) {}

	/** Internal store capability only. It does not reserve a claim or expose account data. */
	async readAuthDeviceClaimReadiness(
		input: CoordinatorDeviceClaimReadinessInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorDeviceClaimReadiness> {
		const c = captureAuthLinkConfig(config);
		if (!c?.enabled) return { kind: "unavailable" };
		try {
			const captured = await captureDeviceClaimEligibility(
				this.backend,
				input,
				c,
				authLinkNow(this.clock),
			);
			if (!captured) return { kind: "unavailable" };
			const row = await this.backend.first<{ eligible: number }>({
				sql: `${AUTH_DEVICE_CLAIM_INPUT_SQL} SELECT CASE WHEN (${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL})${captured.connectionSession ? ` OR (${CONNECTION_RELINK_ELIGIBLE_SQL})` : ""} THEN 1 ELSE 0 END AS eligible FROM claim_input p`,
				values: captured.values,
			});
			if (row?.eligible !== 1) return { kind: "unavailable" };
			return { kind: "eligible", authority: "device_claim", identityId: captured.identityId };
		} catch (error) {
			throw authPersistenceError(error, "auth_device_claim_unavailable");
		}
	}

	async readAccountLinkStatus(
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
		options: { identityId: string },
	): Promise<CoordinatorAccountLinkStatus> {
		const c = captureAuthLinkConfig(config);
		const s = captureAuthLinkSigner(signer);
		if (!c?.enabled || !s || !isAuthControllerId(options?.identityId))
			throw new Error("account_link_status_unavailable");
		const base: CoordinatorAccountLinkStatus = {
			version: 2,
			coordinatorId: c.coordinatorId,
			groupId: s.groupId,
			deviceId: s.deviceId,
			fingerprint: s.fingerprint,
			identityId: null,
			authority: null,
			state: "review_required",
			account: null,
		};
		try {
			const identityId = options.identityId;
			const keyId = await ed25519KeyIdForRevocation(s.publicKey);
			if (!keyId) return base;
			const captured = await captureDeviceClaimEligibility(
				this.backend,
				{ signer: s, identityId },
				c,
				authLinkNow(this.clock),
			);
			if (!captured) return base;
			const connections = captured.connectionSession;
			const row = await this.backend.first<StatusRow>({
				sql: statusSql(connections),
				values: statusValues(
					connections,
					captured.values,
					authLinkControllerSourceValues(c, s),
					keyId,
				),
			});
			return projectStatus(base, row, c, identityId);
		} catch (error) {
			throw authPersistenceError(error, "account_link_status_unavailable");
		}
	}
}
