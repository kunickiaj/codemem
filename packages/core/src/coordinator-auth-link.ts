import {
	CONNECTION_RELINK_ELIGIBLE_SQL,
	connectionFinalizeGuard,
	connectionRequesterGuard,
	connectionSuccessorStatements,
	createPinnedConnection,
} from "./coordinator-account-connection-link.js";
import type { ConnectionSchemaState } from "./coordinator-account-connection-schema.js";
import {
	hasConnectionSessionSchema,
	initialConnectionFloor,
} from "./coordinator-account-connection-session.js";
import { captureAuthAccountProfile } from "./coordinator-auth-account-profile.js";
import { parseCoordinatorAccountReference } from "./coordinator-auth-contract.js";
import { isAuthControllerId, isAuthControllerUniqueError } from "./coordinator-auth-controller.js";
import {
	AUTH_DEVICE_CLAIM_ELIGIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import { headlessLinkProvenanceStatement } from "./coordinator-auth-headless-provenance.js";
import { hasHeadlessLinkProvenance } from "./coordinator-auth-headless-schema.js";
import { readAuthLinkAttemptAuthority } from "./coordinator-auth-link-authority.js";
import {
	AUTH_LINK_ATTEMPT_TTL_MS,
	AUTH_LINK_CREATE_WINDOW_MS,
	AUTH_LINK_EXPIRE_BATCH_MAX,
	AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
	AUTH_LINK_MAX_ACTIVE_PER_IDENTITY,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
	AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
	AUTH_LINK_PURPOSE,
	AUTH_LINK_RETENTION_WINDOW_MS,
	type CoordinatorAuthLinkClaimInput,
	type CoordinatorAuthLinkConfig,
	type CoordinatorAuthLinkConfirmInput,
	type CoordinatorAuthLinkCreateInput,
	type CoordinatorAuthLinkCreateResult,
	type CoordinatorAuthLinkError,
	type CoordinatorAuthLinkFailInput,
	type CoordinatorAuthLinkFinalizeInput,
	type CoordinatorAuthLinkMaintenanceOptions,
	type CoordinatorAuthLinkMaintenanceResult,
	type CoordinatorAuthLinkOidcInput,
	type CoordinatorAuthLinkOidcResult,
	type CoordinatorAuthLinkRejected,
	type CoordinatorAuthLinkRequester,
	type CoordinatorAuthLinkResult,
	type CoordinatorAuthLinkSigner,
	type CoordinatorAuthLinkState,
	type CoordinatorAuthLinkStatus,
	type CoordinatorAuthLinkStore,
} from "./coordinator-auth-link-contract.js";
import {
	AUTH_LINK_HEADLESS_MARKER,
	AUTH_LINK_HEADLESS_MARKER_SQL,
	type CoordinatorAuthLinkHeadlessApproval,
	type CoordinatorAuthLinkHeadlessApprovalInput,
	type CoordinatorAuthLinkHeadlessCreateInput,
	type CoordinatorAuthLinkHeadlessFinalizeInput,
} from "./coordinator-auth-link-headless.js";
import {
	type Captured,
	capture,
	captureAuthLinkConfig as captureConfig,
	captureAuthLinkSigner as captureSigner,
	isHash,
} from "./coordinator-auth-link-input.js";
import {
	cleanAuthLinkProfiles,
	promoteAuthLinkProfile,
	stageAuthLinkProfile,
} from "./coordinator-auth-link-profile.js";
import { CONNECTION_BIRTHS_SQL } from "./coordinator-auth-link-provenance.js";
import { captureAuthLinkSource } from "./coordinator-auth-link-source.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import { writeGuarded } from "./coordinator-auth-read-set.js";
import { authPersistenceError } from "./coordinator-auth-schema.js";
import {
	deviceClaimBindingStatements,
	isDeviceClaimBindingConflict,
	prepareFirstLinkDeviceClaimBinding,
	readFirstLinkDeviceClaimOwnershipComplete,
} from "./coordinator-device-claim-binding.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { readNegativeOwnerConsistency } from "./coordinator-owner-negative-read-set.js";

export * from "./coordinator-auth-link-contract.js";
export interface AuthLinkStatement {
	sql: string;
	values: (string | number | null)[];
}
export interface AuthLinkBackend {
	/** Internal predicate preparation only; consumers must use checked SQL for output/writes. */
	prepareAuthLinkSource?: (
		attemptId: string,
		config: CoordinatorAuthLinkConfig,
		now: number,
		alias?: "a" | "coordinator_auth_link_attempts",
		options?: { currentDevice?: boolean },
	) => Promise<AuthLinkStatement>;
	prepareAuthLinkBrowserSource?: (
		input: { binderHash: string; stateHash?: string; attemptId?: string },
		config: CoordinatorAuthLinkConfig & { redirectUri: string },
		now: number,
	) => Promise<AuthLinkStatement>;
	/** Internal full-schema lookup on the wrapper's captured raw backend; never cached. */
	readAuthSchemaState?: () => Promise<ConnectionSchemaState>;
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
	all?<T>(statement: AuthLinkStatement): Promise<T[]>;
	/** Runs read statements in one round trip and returns each statement's rows. */
	readBatch?<T>(statements: AuthLinkStatement[]): Promise<T[][]>;
	run(statement: AuthLinkStatement): Promise<number>;
	/** Atomic execution; production backends return each statement's native change count. */
	batch(statements: AuthLinkStatement[]): Promise<unknown>;
}
interface Attempt {
	prior_link_id?: string | null;
	authority_kind: "controller_attestation" | "device_claim";
	coordinator_id: string;
	attempt_id: string;
	identity_id: string;
	group_id: string;
	device_id: string;
	public_key: string;
	fingerprint: string;
	controller_attestation_id: string | null;
	controller_review_receipt_id: string | null;
	controller_revision: number | null;
	issuer: string;
	auth_config_revision: string;
	runtime_verifier_hash: string;
	browser_start_hash: string | null;
	loopback_redirect: string;
	state: CoordinatorAuthLinkState;
	browser_transaction_hash: string | null;
	account_subject: string | null;
	completion_secret_hash: string | null;
	link_id: string | null;
	failure_reason: string | null;
	created_at_ms: number;
	expires_at_ms: number;
}
interface StagedProfile {
	display_name: string | null;
	email: string | null;
	email_verified: number | null;
}
/** Capture without invoking accessors; null denotes an omitted attested commitment. */
export function captureAuthLinkBrowserStartHash(value: unknown): string | null | false {
	if (!value || typeof value !== "object") return false;
	try {
		if (Array.isArray(value)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, "browserStartHash");
		if (!descriptor) return "browserStartHash" in value ? false : null;
		if (!Object.hasOwn(descriptor, "value") || !isHash(descriptor.value)) return false;
		return descriptor.value;
	} catch {
		return false;
	}
}
function captureExpectedIdentity(value: unknown): string | null | false {
	if (!value || typeof value !== "object") return false;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, "expectedIdentityId");
		if (!descriptor) return "expectedIdentityId" in value ? false : null;
		return "value" in descriptor && isAuthControllerId(descriptor.value) ? descriptor.value : false;
	} catch {
		return false;
	}
}
function captureCreateInput(value: unknown):
	| (Captured & {
			attemptId: string;
			runtimeVerifierHash: string;
			loopbackRedirect: string;
			browserStartHash: string | null;
			authority: CoordinatorAuthLinkCreateInput["authority"];
			expectedIdentityId: string | null;
	  })
	| null {
	const i = capture(value, [
		"attemptId",
		"signer",
		"runtimeVerifierHash",
		"loopbackRedirect",
		"authority",
	]);
	const authority = captureCreateAuthority(i?.authority);
	const browserStartHash = captureAuthLinkBrowserStartHash(value);
	const expectedIdentityId = captureExpectedIdentity(value);
	if (
		!i ||
		!authority ||
		expectedIdentityId === false ||
		(expectedIdentityId !== null &&
			authority.kind === "device_claim" &&
			authority.identityId !== expectedIdentityId) ||
		browserStartHash === false ||
		(authority.kind === "device_claim" && browserStartHash === null) ||
		!isAuthControllerId(i.attemptId) ||
		!isHash(i.runtimeVerifierHash) ||
		!parseCoordinatorAuthLoopback(i.loopbackRedirect).ok
	)
		return null;
	return {
		...i,
		attemptId: i.attemptId,
		runtimeVerifierHash: i.runtimeVerifierHash,
		loopbackRedirect: i.loopbackRedirect as string,
		browserStartHash,
		authority,
		expectedIdentityId,
	};
}
type CreateInput = NonNullable<ReturnType<typeof captureCreateInput>>;
/** Headless input has no loopback; the marker and user code hash fill the same columns. */
function captureHeadlessCreateInput(value: unknown): CreateInput | null {
	const i = capture(value, [
		"attemptId",
		"signer",
		"runtimeVerifierHash",
		"userCodeHash",
		"authority",
	]);
	const authority = captureCreateAuthority(i?.authority);
	const expectedIdentityId = captureExpectedIdentity(value);
	if (
		!i ||
		!authority ||
		expectedIdentityId === false ||
		!isAuthControllerId(i.attemptId) ||
		!isHash(i.runtimeVerifierHash) ||
		!isHash(i.userCodeHash)
	)
		return null;
	if (
		expectedIdentityId !== null &&
		authority.kind === "device_claim" &&
		authority.identityId !== expectedIdentityId
	)
		return null;
	return {
		signer: i.signer,
		attemptId: i.attemptId,
		runtimeVerifierHash: i.runtimeVerifierHash,
		loopbackRedirect: AUTH_LINK_HEADLESS_MARKER,
		browserStartHash: i.userCodeHash,
		authority,
		expectedIdentityId,
	};
}
function captureCreateAuthority(
	value: unknown,
): CoordinatorAuthLinkCreateInput["authority"] | null {
	const a = capture(value, ["kind"]);
	if (a?.kind === "controller_attestation") return { kind: "controller_attestation" };
	if (a?.kind !== "device_claim") return null;
	const claim = capture(value, ["identityId"]);
	return isAuthControllerId(claim?.identityId)
		? { kind: "device_claim", identityId: claim.identityId }
		: null;
}
function captureRequester(value: unknown): CoordinatorAuthLinkRequester | null {
	const k = capture(value, ["kind"]);
	if (k?.kind === "device") {
		const s = capture(value, ["signer"]);
		const signer = captureSigner(s?.signer);
		return signer ? { kind: "device", signer } : null;
	}
	if (k?.kind !== "browser") return null;
	const b = capture(value, ["browserTransactionHash"]);
	return isHash(b?.browserTransactionHash)
		? { kind: "browser", browserTransactionHash: b.browserTransactionHash }
		: null;
}
export function authLinkNow(clock: () => number): number {
	let now: number;
	try {
		now = clock();
	} catch {
		throw new Error("auth_link_invalid_clock");
	}
	if (
		!Number.isSafeInteger(now) ||
		now < 0 ||
		now > Number.MAX_SAFE_INTEGER - AUTH_LINK_ATTEMPT_TTL_MS
	)
		throw new Error("auth_link_invalid_clock");
	return now;
}
function rejected(error: CoordinatorAuthLinkError): CoordinatorAuthLinkRejected {
	return { kind: "rejected", error };
}
function isTerminal(row: Attempt): boolean {
	return ["expired", "failed", "finalized", "session_redeemed"].includes(row.state);
}
function status(row: Attempt, now: number): CoordinatorAuthLinkStatus {
	const state = !isTerminal(row) && now >= row.expires_at_ms ? "expired" : row.state;
	return { attemptId: row.attempt_id, state, expiresAtMs: row.expires_at_ms };
}
function configMatches(row: Attempt, c: CoordinatorAuthLinkConfig): boolean {
	return (
		c.enabled &&
		row.coordinator_id === c.coordinatorId &&
		row.issuer === c.issuer &&
		row.auth_config_revision === c.revision
	);
}
function signerMatches(row: Attempt, s: CoordinatorAuthLinkSigner): boolean {
	return (
		row.group_id === s.groupId &&
		row.device_id === s.deviceId &&
		row.public_key === s.publicKey &&
		row.fingerprint === s.fingerprint
	);
}
function creationMatches(
	row: Attempt,
	i: CreateInput,
	s: CoordinatorAuthLinkSigner,
	c: CoordinatorAuthLinkConfig,
): boolean {
	return (
		configMatches(row, c) &&
		signerMatches(row, s) &&
		row.authority_kind === i.authority.kind &&
		(i.expectedIdentityId === null || row.identity_id === i.expectedIdentityId) &&
		(i.authority.kind !== "device_claim" || row.identity_id === i.authority.identityId) &&
		row.runtime_verifier_hash === i.runtimeVerifierHash &&
		row.browser_start_hash === i.browserStartHash &&
		row.loopback_redirect === i.loopbackRedirect
	);
}
function requesterMatches(row: Attempt, r: CoordinatorAuthLinkRequester): boolean {
	if (r.kind === "device") return signerMatches(row, r.signer);
	return row.browser_transaction_hash === r.browserTransactionHash;
}
function diagnose(
	row: Attempt | null,
	c: CoordinatorAuthLinkConfig,
	now: number,
): CoordinatorAuthLinkRejected {
	if (!row) return rejected("attempt_unavailable");
	if (!configMatches(row, c)) return rejected("auth_config_changed");
	if (row.state === "expired") return rejected("attempt_expired");
	if (!isTerminal(row) && row.expires_at_ms <= now) return rejected("attempt_expired");
	return rejected("attempt_unavailable");
}
// Mode predicates run inside each write so one mode can never advance the other's rows.
const DESKTOP_MODE_SQL = `loopback_redirect <> ${AUTH_LINK_HEADLESS_MARKER_SQL}`;
const HEADLESS_MODE_SQL = `loopback_redirect = ${AUTH_LINK_HEADLESS_MARKER_SQL}`;
const LIVE_CONFIG =
	"coordinator_id = ? AND issuer = ? AND auth_config_revision = ? AND ? = 1 AND authority_kind = 'controller_attestation'";
const CURRENT_CONFIG = "coordinator_id = ? AND issuer = ? AND auth_config_revision = ? AND ? = 1";
// Cancellation and time cleanup release an uncommitted promise, not ownership.
const RELEASABLE_SOURCE = `(authority_kind = 'controller_attestation' OR
 (authority_kind = 'device_claim' AND controller_attestation_id IS NULL
 AND controller_review_receipt_id IS NULL AND controller_revision IS NULL))`;
function configValues(c: CoordinatorAuthLinkConfig): (string | number)[] {
	return [c.coordinatorId, c.issuer, c.revision, Number(c.enabled)];
}
interface AuthoritySource {
	group_id: string;
	device_id: string;
	public_key: string;
	fingerprint: string;
	identity_id: string | null;
	controller_identity_id: string;
	attestation_id: string;
	review_receipt_id: string;
	revision: number;
}
const AUTHORITY_COLUMNS = `e.group_id, e.device_id, e.public_key, e.fingerprint, e.identity_id,
 a.identity_id AS controller_identity_id, a.attestation_id, a.review_receipt_id, a.revision`;
// Pin this call's enrollment, not the historical enrollment Identity in the attestation.
const AUTHORITY_GUARD = `AND e.group_id = ? AND e.device_id = ? AND e.public_key = ?
 AND e.fingerprint = ? AND e.identity_id IS ? AND a.identity_id = ?
 AND a.attestation_id = ? AND a.review_receipt_id = ? AND a.revision = ?
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations WHERE
  (subject_kind = 'device_id' AND subject_value = ?) OR
  (subject_kind = 'ed25519_key' AND subject_value = ?))`;
function authorityValues(
	source: AuthoritySource,
	keyId: string | null,
): (string | number | null)[] {
	return [
		source.group_id,
		source.device_id,
		source.public_key,
		source.fingerprint,
		source.identity_id,
		source.controller_identity_id,
		source.attestation_id,
		source.review_receipt_id,
		source.revision,
		source.device_id,
		keyId,
	];
}
async function deriveAuthority(source: AuthoritySource): Promise<(string | number | null)[]> {
	const values = authorityValues(source, null);
	try {
		values[values.length - 1] = await ed25519KeyIdForRevocation(source.public_key);
		return values;
	} catch {
		throw new Error("auth_link_persistence_error");
	}
}
const AUTHORITY_SOURCE_SQL = `coordinator_auth_controller_attestations a
 JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
 JOIN groups g ON g.group_id = a.group_id
 WHERE a.coordinator_id = coordinator_auth_link_attempts.coordinator_id
 AND coordinator_auth_link_attempts.authority_kind = 'controller_attestation'
 AND a.attestation_id = coordinator_auth_link_attempts.controller_attestation_id AND a.review_receipt_id = coordinator_auth_link_attempts.controller_review_receipt_id
 AND a.revision = coordinator_auth_link_attempts.controller_revision AND a.revoked_at IS NULL
 AND a.identity_id = coordinator_auth_link_attempts.identity_id
 AND a.group_id = coordinator_auth_link_attempts.group_id AND a.device_id = coordinator_auth_link_attempts.device_id
 AND a.public_key = coordinator_auth_link_attempts.public_key AND a.fingerprint = coordinator_auth_link_attempts.fingerprint
 AND e.enabled = 1 AND g.archived_at IS NULL AND e.public_key = a.public_key AND e.fingerprint = a.fingerprint
 AND (e.identity_id IS NULL OR e.identity_id = a.identity_id)`;
const AUTHORITY = `EXISTS (SELECT 1 FROM ${AUTHORITY_SOURCE_SQL} ${AUTHORITY_GUARD})`;
const CREATE_SOURCE_SQL = `FROM coordinator_auth_controller_attestations a
 JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
 JOIN groups g ON g.group_id = a.group_id
 WHERE a.coordinator_id = ? AND a.group_id = ? AND a.device_id = ? AND a.public_key = ? AND a.fingerprint = ?
 AND a.revoked_at IS NULL AND a.revision = 1 AND ? = 1 AND e.enabled = 1 AND g.archived_at IS NULL
 AND e.public_key = a.public_key AND e.fingerprint = a.fingerprint AND (e.identity_id IS NULL OR e.identity_id = a.identity_id)`;
const CREATE_SQL = `INSERT INTO coordinator_auth_link_attempts (
 coordinator_id, attempt_id, identity_id, group_id, device_id, public_key, fingerprint,
 controller_attestation_id, controller_review_receipt_id, controller_revision, authority_kind,
 issuer, auth_config_revision, runtime_verifier_hash, loopback_redirect, browser_start_hash, state, created_at_ms, expires_at_ms)
 SELECT ?, ?, a.identity_id, a.group_id, a.device_id, a.public_key, a.fingerprint,
 a.attestation_id, a.review_receipt_id, a.revision, 'controller_attestation', ?, ?, ?, ?, ?, 'pending', ?, ?
  ${CREATE_SOURCE_SQL} ${AUTHORITY_GUARD}
 ${creationAdmissionSql("a")}`;
function creationAdmissionSql(source: "a" | "p"): string {
	return `
 AND NOT EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts t
  WHERE t.coordinator_id = ${source}.coordinator_id AND t.attempt_id = ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions t
  WHERE t.coordinator_id = ${source}.coordinator_id AND t.attempt_id = ? AND t.purpose NOT IN ('signin','link'))
 AND (SELECT count(*) FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = ${source}.coordinator_id AND t.group_id = ${source}.group_id AND t.device_id = ${source}.device_id
  AND t.state IN ('pending','browser_claimed','oidc_verified','confirmed') AND t.expires_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = ${source}.coordinator_id AND t.identity_id = ${source}.identity_id
  AND t.state IN ('pending','browser_claimed','oidc_verified','confirmed') AND t.expires_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = ${source}.coordinator_id AND t.group_id = ${source}.group_id AND t.device_id = ${source}.device_id
  AND t.created_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = ${source}.coordinator_id AND t.group_id = ${source}.group_id AND t.device_id = ${source}.device_id
  AND t.created_at_ms > ?) < ?
 AND (SELECT count(*) FROM (SELECT 1 FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = ${source}.coordinator_id AND t.state NOT IN ('finalized','session_redeemed') LIMIT ?)) < ?`;
}
function creationAdmissionValues(attemptId: string, now: number): (string | number)[] {
	return [
		attemptId,
		attemptId,
		now,
		AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
		now,
		AUTH_LINK_MAX_ACTIVE_PER_IDENTITY,
		now - AUTH_LINK_CREATE_WINDOW_MS,
		AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
		now - AUTH_LINK_RETENTION_WINDOW_MS,
		AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION,
		AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
		AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
	];
}
function deviceCreationEligibilitySql(options: { relink: boolean }): string {
	return options.relink ? CONNECTION_RELINK_ELIGIBLE_SQL : AUTH_DEVICE_CLAIM_ELIGIBLE_SQL;
}
function isSharedAdmissionLimit(error: unknown): boolean {
	return (
		error instanceof Error &&
		/^(?:D1_ERROR: )?connection_attempt_limited(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)?$/.test(
			error.message,
		)
	);
}
const DEVICE_CREATE_SQL = `${AUTH_DEVICE_CLAIM_INPUT_SQL}
 INSERT INTO coordinator_auth_link_attempts (
 coordinator_id,attempt_id,identity_id,group_id,device_id,public_key,fingerprint,
 controller_attestation_id,controller_review_receipt_id,controller_revision,authority_kind,
 issuer,auth_config_revision,runtime_verifier_hash,loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms)
 SELECT p.coordinator_id,p.attempt_id,p.identity_id,p.group_id,p.device_id,p.public_key,p.fingerprint,
 NULL,NULL,NULL,'device_claim',p.issuer,p.revision,?,?,?,'pending',p.now_ms,p.now_ms + ${AUTH_LINK_ATTEMPT_TTL_MS}
 FROM claim_input p WHERE ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL} ${creationAdmissionSql("p")}`;
const DEVICE_RETRY_SQL = `${AUTH_DEVICE_CLAIM_INPUT_SQL}
 SELECT 1 FROM claim_input p JOIN coordinator_auth_link_attempts t
 ON t.coordinator_id = p.coordinator_id AND t.attempt_id = p.attempt_id
 WHERE t.authority_kind = 'device_claim' AND t.identity_id = p.identity_id
 AND t.group_id = p.group_id AND t.device_id = p.device_id AND t.public_key = p.public_key AND t.fingerprint = p.fingerprint
 AND t.issuer = p.issuer AND t.auth_config_revision = p.revision
 AND t.runtime_verifier_hash = ? AND t.browser_start_hash IS ? AND t.loopback_redirect = ?
 AND t.state <> 'expired' AND t.expires_at_ms > p.now_ms AND ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL}`;
const MAINTENANCE_CANDIDATE_SQL = `${RELEASABLE_SOURCE} AND link_id IS NULL AND (
 (state IN ('pending','browser_claimed','oidc_verified','confirmed') AND expires_at_ms <= ?)
 OR (state IN ('failed','expired') AND account_subject IS NOT NULL))`;
const MAINTENANCE_SQL = `UPDATE coordinator_auth_link_attempts
 SET state = CASE WHEN state = 'failed' THEN 'failed' ELSE 'expired' END, account_subject = NULL
 WHERE coordinator_id = ? AND ${MAINTENANCE_CANDIDATE_SQL}
 AND attempt_id IN (SELECT attempt_id FROM coordinator_auth_link_attempts
  WHERE coordinator_id = ? AND ${MAINTENANCE_CANDIDATE_SQL}
  ORDER BY expires_at_ms, attempt_id LIMIT ?)`;
function captureMaintenanceLimit(options: unknown): number | null {
	if (options === undefined) return AUTH_LINK_EXPIRE_BATCH_MAX;
	if (!options || typeof options !== "object") return null;
	try {
		if (Array.isArray(options)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(options, "limit");
		if (!descriptor) {
			if ("limit" in options) return null;
			return AUTH_LINK_EXPIRE_BATCH_MAX;
		}
		if (!Object.hasOwn(descriptor, "value")) return null;
		const limit: unknown = descriptor.value;
		if (
			typeof limit !== "number" ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > AUTH_LINK_EXPIRE_BATCH_MAX
		)
			return null;
		return limit;
	} catch {
		return null;
	}
}
function createSourceValues(
	c: CoordinatorAuthLinkConfig,
	s: CoordinatorAuthLinkSigner,
): (string | number)[] {
	return [c.coordinatorId, s.groupId, s.deviceId, s.publicKey, s.fingerprint, Number(c.enabled)];
}

export type { AuthoritySource as AuthLinkAuthoritySource };
// Shared with the read-only own-account query: never derive authority from labels alone.
export {
	AUTHORITY_COLUMNS as AUTH_LINK_AUTHORITY_COLUMNS,
	AUTHORITY_GUARD as AUTH_LINK_AUTHORITY_GUARD_SQL,
	CREATE_SOURCE_SQL as AUTH_LINK_CONTROLLER_SOURCE_SQL,
	captureConfig as captureAuthLinkConfig,
	captureSigner as captureAuthLinkSigner,
	createSourceValues as authLinkControllerSourceValues,
	deriveAuthority as deriveAuthLinkAuthority,
};

/** Optional persistence capability. No token verification, routes, sessions or grants. */
export class AuthLinkOperations implements CoordinatorAuthLinkStore {
	constructor(
		private readonly backend: AuthLinkBackend,
		private readonly clock: () => number = Date.now,
	) {}
	private async read(
		attemptId: string,
		c: CoordinatorAuthLinkConfig,
		source: { authority: Attempt["authority_kind"] | "either" } = {
			authority: "controller_attestation",
		},
	): Promise<Attempt | null> {
		const row = await this.first<Attempt>({
			sql: `SELECT * FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?${source.authority === "either" ? "" : " AND authority_kind = ?"}`,
			values: [
				c.coordinatorId,
				attemptId,
				...(source.authority === "either" ? [] : [source.authority]),
			],
		});
		const authority = row && readAuthLinkAttemptAuthority(row);
		return authority && (source.authority === "either" || authority.kind === source.authority)
			? row
			: null;
	}
	private async first<T>(statement: AuthLinkStatement): Promise<T | null> {
		try {
			return await this.backend.first<T>(statement);
		} catch (error) {
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
	}
	private async connectionSchema(): Promise<boolean> {
		try {
			return await hasConnectionSessionSchema(this.backend);
		} catch (error) {
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
	}
	private async execute(
		statement: AuthLinkStatement,
		conflict: CoordinatorAuthLinkError,
		options: { sharedAdmission?: boolean } = {},
	): Promise<number | CoordinatorAuthLinkRejected> {
		try {
			return await this.backend.run(statement);
		} catch (error) {
			if (isAuthControllerUniqueError(error)) return rejected(conflict);
			if (options.sharedAdmission && isSharedAdmissionLimit(error)) return 0;
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
	}
	private async readAuthority(
		attemptId: string,
		c: CoordinatorAuthLinkConfig,
	): Promise<(string | number | null)[] | null> {
		const source = await this.first<AuthoritySource>({
			sql: `SELECT ${AUTHORITY_COLUMNS} FROM coordinator_auth_link_attempts,
			 ${AUTHORITY_SOURCE_SQL} AND coordinator_auth_link_attempts.attempt_id = ?
			 AND coordinator_auth_link_attempts.coordinator_id = ?
			 AND coordinator_auth_link_attempts.issuer = ?
			 AND coordinator_auth_link_attempts.auth_config_revision = ? AND ? = 1`,
			values: [attemptId, ...configValues(c)],
		});
		if (!source) return null;
		return deriveAuthority(source);
	}
	private async source(
		attemptId: string,
		c: CoordinatorAuthLinkConfig,
		now: number,
		options: { currentDevice?: boolean } = {},
	) {
		try {
			const prepare = this.backend.prepareAuthLinkSource;
			if (prepare)
				return await prepare(attemptId, c, now, "coordinator_auth_link_attempts", options);
			return await captureAuthLinkSource(
				this.backend,
				attemptId,
				c,
				now,
				"coordinator_auth_link_attempts",
				options,
			);
		} catch (error) {
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
	}
	async maintainAuthLinkAttempts(
		config: CoordinatorAuthLinkConfig,
		options?: CoordinatorAuthLinkMaintenanceOptions,
	): Promise<CoordinatorAuthLinkMaintenanceResult> {
		const c = captureConfig(config);
		const limit = captureMaintenanceLimit(options);
		if (!c || limit === null) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const result = await this.execute(
			{
				sql: MAINTENANCE_SQL,
				values: [c.coordinatorId, now, c.coordinatorId, now, limit],
			},
			"attempt_conflict",
		);
		if (typeof result !== "number") return result;
		const cleaned = await this.execute(cleanAuthLinkProfiles(c, now, limit), "attempt_conflict");
		if (typeof cleaned !== "number") return cleaned;
		return {
			kind: "maintained",
			processedCount: result,
			more: result === limit || cleaned === limit,
		};
	}
	async createAuthLinkAttempt(
		input: CoordinatorAuthLinkCreateInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkCreateResult> {
		return this.createCaptured(captureCreateInput(input), config);
	}
	/** Same authority, admission and exact-retry rules as desktop create. */
	async createHeadlessAuthLinkAttempt(
		input: CoordinatorAuthLinkHeadlessCreateInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkCreateResult> {
		return this.createCaptured(captureHeadlessCreateInput(input), config);
	}
	private async createCaptured(
		i: CreateInput | null,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkCreateResult> {
		const c = captureConfig(config);
		const s = captureSigner(i?.signer);
		if (!c || !i || !s) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const existing = await this.read(i.attemptId, c, { authority: "either" });
		if (existing) return this.retryCreation(existing, i, s, c, now);
		if (i.authority.kind === "device_claim") return this.createDeviceAttempt(i, s, c, now);
		return this.createAttestedAttempt(i, s, c, now);
	}
	private async createAttestedAttempt(
		i: CreateInput,
		s: CoordinatorAuthLinkSigner,
		c: CoordinatorAuthLinkConfig,
		now: number,
	): Promise<CoordinatorAuthLinkCreateResult> {
		const source = await this.first<AuthoritySource>({
			sql: `SELECT ${AUTHORITY_COLUMNS} ${CREATE_SOURCE_SQL}`,
			values: createSourceValues(c, s),
		});
		if (!source) {
			const row = await this.read(i.attemptId, c, { authority: "either" });
			if (row) return this.createRetry(row, i, s, c, now, null);
			return rejected("controller_not_active");
		}
		const authority = await deriveAuthority(source);
		if (i.expectedIdentityId !== null && source.controller_identity_id !== i.expectedIdentityId)
			return rejected("controller_not_active");
		const values = [
			c.coordinatorId,
			i.attemptId,
			c.issuer,
			c.revision,
			i.runtimeVerifierHash,
			i.loopbackRedirect as string,
			i.browserStartHash,
			now,
			now + AUTH_LINK_ATTEMPT_TTL_MS,
			...createSourceValues(c, s),
			...authority,
			...creationAdmissionValues(i.attemptId, now),
		];
		const result = await this.executeCreation(
			{ sql: CREATE_SQL, values },
			{
				coordinator: c.coordinatorId,
				attempt: i.attemptId,
				identity: source.controller_identity_id,
				now,
			},
			s,
			c,
		);
		const row = await this.read(i.attemptId, c, { authority: "either" });
		if (result === 0) {
			if (row) return this.createRetry(row, i, s, c, now, authority);
			return this.diagnoseCreateAdmission(i.attemptId, c, s, authority);
		}
		if (typeof result !== "number") return this.createRetry(row, i, s, c, now, authority);
		if (!row || !creationMatches(row, i, s, c)) throw new Error("auth_link_persistence_incomplete");
		return { kind: "created", status: status(row, now), identityId: row.identity_id };
	}
	private async executeCreation(
		statement: AuthLinkStatement,
		pin: { coordinator: string; attempt: string; identity: string; now: number },
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
	): Promise<number | CoordinatorAuthLinkRejected> {
		if (!(await this.connectionSchema())) return this.execute(statement, "attempt_conflict");
		try {
			const guard = await connectionRequesterGuard(
				this.backend,
				pin.identity,
				signer,
				config,
				pin.now,
			);
			return await createPinnedConnection(
				this.backend,
				{
					sql: `${statement.sql} AND ${guard.sql}`,
					values: [...statement.values, ...guard.values],
				},
				pin,
			);
		} catch (error) {
			if (isAuthControllerUniqueError(error)) return rejected("attempt_conflict");
			if (isSharedAdmissionLimit(error)) return 0;
			if (String(error).includes("NOT NULL constraint failed"))
				return rejected("attempt_unavailable");
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
	}
	private async retryCreation(
		row: Attempt,
		i: CreateInput,
		s: CoordinatorAuthLinkSigner,
		c: CoordinatorAuthLinkConfig,
		now: number,
	): Promise<CoordinatorAuthLinkCreateResult> {
		if (!creationMatches(row, i, s, c) || row.state === "expired" || row.expires_at_ms <= now)
			return rejected("attempt_conflict");
		if (i.authority.kind === "device_claim") {
			if (row.prior_link_id) return this.retryContinuation(row, i, c, now);
			const captured = await this.captureDevice(i, s, c, now);
			const active =
				captured &&
				(await this.first({
					sql: DEVICE_RETRY_SQL,
					values: [
						...captured.values,
						i.runtimeVerifierHash,
						i.browserStartHash,
						i.loopbackRedirect,
					],
				}));
			if (!active) {
				const current = await this.read(i.attemptId, c, { authority: "either" });
				return rejected(
					current && !creationMatches(current, i, s, c)
						? "attempt_conflict"
						: "attempt_unavailable",
				);
			}
			if (await this.readOwnerReservation(i.attemptId, c)) return rejected("attempt_conflict");
			return { kind: "existing", status: status(row, now), identityId: row.identity_id };
		}
		return this.createRetry(row, i, s, c, now, await this.readAuthority(i.attemptId, c));
	}
	private async retryContinuation(
		row: Attempt,
		i: CreateInput,
		c: CoordinatorAuthLinkConfig,
		now: number,
	): Promise<CoordinatorAuthLinkCreateResult> {
		const source = await this.source(i.attemptId, c, now);
		if (
			!(await this.first({
				sql: `SELECT 1 FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ? AND ${source.sql}`,
				values: [c.coordinatorId, i.attemptId, ...source.values],
			}))
		)
			return rejected("attempt_unavailable");
		return { kind: "existing", status: status(row, now), identityId: row.identity_id };
	}
	private async captureDevice(
		i: CreateInput,
		s: CoordinatorAuthLinkSigner,
		c: CoordinatorAuthLinkConfig,
		now: number,
	) {
		if (i.authority.kind !== "device_claim") return null;
		try {
			return await captureDeviceClaimEligibility(
				this.backend,
				{ signer: s, identityId: i.authority.identityId, attemptId: i.attemptId },
				c,
				now,
			);
		} catch (error) {
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
	}
	private async createDeviceAttempt(
		i: CreateInput,
		s: CoordinatorAuthLinkSigner,
		c: CoordinatorAuthLinkConfig,
		now: number,
	): Promise<CoordinatorAuthLinkCreateResult> {
		const captured = await this.captureDevice(i, s, c, now);
		if (!captured) return rejected("attempt_unavailable");
		const relink =
			captured.connectionSession &&
			(await this.first({
				sql: "SELECT 1 FROM coordinator_auth_device_claims WHERE coordinator_id = ? AND identity_id = ?",
				values: [c.coordinatorId, captured.identityId],
			}));
		const result = await this.execute(
			{
				sql: relink
					? `${AUTH_DEVICE_CLAIM_INPUT_SQL} INSERT INTO coordinator_auth_link_attempts
 (coordinator_id,attempt_id,identity_id,group_id,device_id,public_key,fingerprint,controller_attestation_id,controller_review_receipt_id,controller_revision,authority_kind,issuer,auth_config_revision,runtime_verifier_hash,loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms,prior_link_id)
 SELECT p.coordinator_id,p.attempt_id,p.identity_id,p.group_id,p.device_id,p.public_key,p.fingerprint,NULL,NULL,NULL,'device_claim',p.issuer,p.revision,?,?,?,'pending',p.now_ms,p.now_ms+600000,
 (SELECT h.link_id FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id=p.coordinator_id AND h.identity_id=p.identity_id AND h.successor_link_id IS NULL)
 FROM claim_input p WHERE ${CONNECTION_RELINK_ELIGIBLE_SQL} ${creationAdmissionSql("p")}`
					: DEVICE_CREATE_SQL,
				values: [
					...captured.values,
					i.runtimeVerifierHash,
					i.loopbackRedirect,
					i.browserStartHash,
					...creationAdmissionValues(i.attemptId, now),
				],
			},
			"attempt_conflict",
			{ sharedAdmission: captured.connectionSession },
		);
		const eligibility = deviceCreationEligibilitySql({ relink: Boolean(relink) });
		const row = await this.read(i.attemptId, c, { authority: "either" });
		if (typeof result !== "number" || result === 0) {
			if (row) return this.retryCreation(row, i, s, c, now);
			if (typeof result !== "number") return result;
			const eligible = await this.first({
				sql: `${AUTH_DEVICE_CLAIM_INPUT_SQL} SELECT 1 FROM claim_input p WHERE ${eligibility}`,
				values: captured.values,
			});
			if (!eligible) return rejected("attempt_unavailable");
			return rejected(
				(await this.readOwnerReservation(i.attemptId, c)) ? "attempt_conflict" : "attempt_limited",
			);
		}
		if (!row || !creationMatches(row, i, s, c)) throw new Error("auth_link_persistence_incomplete");
		return { kind: "created", status: status(row, now), identityId: row.identity_id };
	}
	private async diagnoseCreateAdmission(
		attemptId: string,
		c: CoordinatorAuthLinkConfig,
		s: CoordinatorAuthLinkSigner,
		authority: (string | number | null)[],
	): Promise<CoordinatorAuthLinkCreateResult> {
		const active = await this.first({
			sql: `SELECT 1 ${CREATE_SOURCE_SQL} ${AUTHORITY_GUARD}`,
			values: [...createSourceValues(c, s), ...authority],
		});
		if (!active) return rejected("controller_not_active");
		const reserved = await this.readOwnerReservation(attemptId, c);
		return rejected(reserved ? "attempt_conflict" : "attempt_limited");
	}
	private readOwnerReservation(attemptId: string, c: CoordinatorAuthLinkConfig) {
		return this.first({
			sql: `SELECT 1 FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ? AND attempt_id = ?
 UNION ALL SELECT 1 FROM coordinator_auth_browser_transactions WHERE coordinator_id = ? AND attempt_id = ?
 AND purpose NOT IN ('signin','link') LIMIT 1`,
			values: [c.coordinatorId, attemptId, c.coordinatorId, attemptId],
		});
	}
	private async createRetry(
		row: Attempt | null,
		i: CreateInput,
		s: CoordinatorAuthLinkSigner,
		c: CoordinatorAuthLinkConfig,
		now: number,
		authority: (string | number | null)[] | null,
	): Promise<CoordinatorAuthLinkCreateResult> {
		if (
			!row ||
			!creationMatches(row, i, s, c) ||
			row.state === "expired" ||
			row.expires_at_ms <= now
		)
			return rejected("attempt_conflict");
		if (!authority) return rejected("controller_not_active");
		const active = await this.first({
			sql: `SELECT 1 FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${LIVE_CONFIG} AND ${AUTHORITY}`,
			values: [row.attempt_id, ...configValues(c), ...authority],
		});
		if (!active) return rejected("controller_not_active");
		if (await this.readOwnerReservation(row.attempt_id, c)) return rejected("attempt_conflict");
		return { kind: "existing", status: status(row, now), identityId: row.identity_id };
	}
	private async transition(
		i: { attemptId: string; browserTransactionHash: string },
		c: CoordinatorAuthLinkConfig,
		now: number,
		update: AuthLinkStatement,
		after?: AuthLinkStatement | null,
	): Promise<CoordinatorAuthLinkResult> {
		const result = after
			? await this.executeTransitionBatch(update, after)
			: await this.execute(update, "attempt_conflict");
		if (typeof result !== "number") return result;
		const row = await this.read(i.attemptId, c, { authority: "either" });
		if (!result) {
			if (
				row &&
				row.browser_transaction_hash !== null &&
				row.browser_transaction_hash !== i.browserTransactionHash
			)
				return rejected("attempt_unavailable");
			return diagnose(row, c, now);
		}
		if (!row || row.browser_transaction_hash !== i.browserTransactionHash)
			throw new Error("auth_link_persistence_incomplete");
		return { kind: "applied", status: status(row, now) };
	}
	private async executeTransitionBatch(update: AuthLinkStatement, after: AuthLinkStatement) {
		try {
			const counts = await this.backend.batch([update, after]);
			if (
				!Array.isArray(counts) ||
				counts.length !== 2 ||
				typeof counts[0] !== "number" ||
				!Number.isSafeInteger(counts[0])
			)
				throw new Error("auth_link_batch_result_missing");
			return counts[0];
		} catch (error) {
			if (isAuthControllerUniqueError(error)) return rejected("attempt_conflict");
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
	}
	private browserInput(
		input: unknown,
		extra: string[] = [],
	): (CoordinatorAuthLinkClaimInput & Captured) | null {
		const i = capture(input, ["attemptId", "browserTransactionHash", ...extra]);
		if (!i || !isAuthControllerId(i.attemptId) || !isHash(i.browserTransactionHash)) return null;
		return i as CoordinatorAuthLinkClaimInput & Captured;
	}
	async claimAuthLinkAttempt(
		input: CoordinatorAuthLinkClaimInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const i = this.browserInput(input);
		if (!c || !i) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const update = {
			sql: `UPDATE coordinator_auth_link_attempts SET state = 'browser_claimed', browser_transaction_hash = ?, claimed_at_ms = ? WHERE attempt_id = ? AND ${LIVE_CONFIG} AND expires_at_ms > ? AND state = 'pending' AND browser_start_hash IS NULL AND browser_transaction_hash IS NULL AND ${DESKTOP_MODE_SQL} AND NOT EXISTS (SELECT 1 FROM coordinator_auth_session_receipts r WHERE r.coordinator_id = coordinator_auth_link_attempts.coordinator_id AND r.browser_transaction_hash = ?)`,
			values: [
				i.browserTransactionHash,
				now,
				i.attemptId,
				...configValues(c),
				now,
				i.browserTransactionHash,
			],
		};
		const result = await this.transition(i, c, now, update);
		if (result.kind !== "rejected" || result.error !== "attempt_unavailable") return result;
		const row = await this.read(i.attemptId, c);
		if (
			row &&
			configMatches(row, c) &&
			row.expires_at_ms > now &&
			row.state === "browser_claimed" &&
			row.browser_start_hash == null &&
			row.browser_transaction_hash === i.browserTransactionHash
		)
			return { kind: "existing", status: status(row, now) };
		return result;
	}
	/** Caller supplies independently server-verified OIDC claims; this does not validate JWTs. */
	async recordAuthLinkOidcVerified(
		input: CoordinatorAuthLinkOidcInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkOidcResult> {
		const c = captureConfig(config);
		const i = this.browserInput(input, ["account"]);
		if (!c || !i) return rejected("invalid_input");
		const accountValue = capture(i.account, ["issuer", "subject"]);
		const account = parseCoordinatorAccountReference(accountValue, { issuer: c.issuer });
		if (!account.ok) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const descriptor = Object.getOwnPropertyDescriptor(input, "profile");
		const profile = captureAuthAccountProfile(
			descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined,
		);
		const now = authLinkNow(this.clock);
		const source = await this.source(i.attemptId, c, now);
		const staged = stageAuthLinkProfile(
			{
				attemptId: i.attemptId,
				browserTransactionHash: i.browserTransactionHash,
				account: account.account,
				profile,
			},
			c,
			now,
		);
		const result = await this.transition(
			i,
			c,
			now,
			{
				sql: `UPDATE coordinator_auth_link_attempts SET state = 'oidc_verified', account_subject = ?, oidc_verified_at_ms = ? WHERE attempt_id = ? AND ${CURRENT_CONFIG} AND expires_at_ms > ? AND state = 'browser_claimed' AND browser_transaction_hash = ? AND account_subject IS NULL AND ${source.sql}`,
				values: [
					account.account.subject,
					now,
					i.attemptId,
					...configValues(c),
					now,
					i.browserTransactionHash,
					...source.values,
				],
			},
			staged,
		);
		if (result.kind === "rejected") return result;
		const row = await this.read(i.attemptId, c, { authority: "either" });
		if (!row) throw new Error("auth_link_persistence_incomplete");
		return {
			kind: "applied",
			status: result.status,
			target: {
				identityId: row.identity_id,
				groupId: row.group_id,
				deviceId: row.device_id,
				fingerprint: row.fingerprint,
				...(row.loopback_redirect === AUTH_LINK_HEADLESS_MARKER ? { headless: true as const } : {}),
			},
		};
	}
	/** completionSecretHash must come from the trusted coordinator generator, not request nomination. */
	async confirmAuthLinkAttempt(
		input: CoordinatorAuthLinkConfirmInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const i = this.browserInput(input, ["completionSecretHash"]);
		if (!c || !i || !isHash(i.completionSecretHash)) return rejected("invalid_input");
		return this.confirmWith(i, c, {
			sql: "?",
			values: [i.completionSecretHash],
			mode: DESKTOP_MODE_SQL,
		});
	}
	/** The device already holds the runtime verifier, so it doubles as the completion proof. */
	async confirmHeadlessAuthLinkAttempt(
		input: CoordinatorAuthLinkClaimInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const i = this.browserInput(input);
		if (!c || !i) return rejected("invalid_input");
		return this.confirmWith(i, c, {
			sql: "runtime_verifier_hash",
			values: [],
			mode: HEADLESS_MODE_SQL,
		});
	}
	private async confirmWith(
		i: CoordinatorAuthLinkClaimInput,
		c: CoordinatorAuthLinkConfig,
		completion: { sql: string; values: string[]; mode: string },
	): Promise<CoordinatorAuthLinkResult> {
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const source = await this.source(i.attemptId, c, now);
		return this.transition(i, c, now, {
			sql: `UPDATE coordinator_auth_link_attempts SET state = 'confirmed', completion_secret_hash = ${completion.sql}, confirmed_at_ms = ? WHERE attempt_id = ? AND ${CURRENT_CONFIG} AND expires_at_ms > ? AND state = 'oidc_verified' AND browser_transaction_hash = ? AND completion_secret_hash IS NULL AND ${completion.mode} AND ${source.sql}`,
			values: [
				...completion.values,
				now,
				i.attemptId,
				...configValues(c),
				now,
				i.browserTransactionHash,
				...source.values,
			],
		});
	}
	/** Read-only snapshot; confirmation must still atomically check the browser proof and state. */
	async readAuthLinkCompletionDestination(
		input: CoordinatorAuthLinkClaimInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<{ destination: string } | null> {
		const c = captureConfig(config);
		const i = this.browserInput(input);
		if (!c || !i || !c.enabled) return null;
		const now = authLinkNow(this.clock);
		const source = await this.source(i.attemptId, c, now);
		const row = await this.first<Attempt>({
			sql: `SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${CURRENT_CONFIG}
 AND browser_transaction_hash = ? AND ${source.sql}`,
			values: [i.attemptId, ...configValues(c), i.browserTransactionHash, ...source.values],
		});
		if (
			!row ||
			!configMatches(row, c) ||
			row.attempt_id !== i.attemptId ||
			row.browser_transaction_hash !== i.browserTransactionHash ||
			row.state !== "oidc_verified" ||
			!(row.created_at_ms <= now && now < row.expires_at_ms) ||
			!parseCoordinatorAuthLoopback(row.loopback_redirect).ok
		)
			return null;
		return { destination: row.loopback_redirect };
	}
	async getAuthLinkAttemptStatus(
		attemptId: string,
		requester: CoordinatorAuthLinkRequester,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkStatus | null> {
		const read = await this.readStatusRow(attemptId, requester, config);
		return read && status(read.row, read.now);
	}
	/**
	 * The browser-bound status plus the attempt's mode, from the same single row
	 * read, so browser pages learn the mode without another statement.
	 */
	async getAuthLinkBrowserAttemptStatus(
		input: CoordinatorAuthLinkClaimInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<{ status: CoordinatorAuthLinkStatus; headless: boolean } | null> {
		const i = this.browserInput(input);
		if (!i) return null;
		const requester = {
			kind: "browser" as const,
			browserTransactionHash: i.browserTransactionHash,
		};
		const read = await this.readStatusRow(i.attemptId, requester, config);
		if (!read) return null;
		const headless = read.row.loopback_redirect === AUTH_LINK_HEADLESS_MARKER;
		return { status: status(read.row, read.now), headless };
	}
	private async readStatusRow(
		attemptId: string,
		requester: CoordinatorAuthLinkRequester,
		config: CoordinatorAuthLinkConfig,
	): Promise<{ row: Attempt; now: number } | null> {
		const c = captureConfig(config);
		const r = captureRequester(requester);
		if (!c || !r || !isAuthControllerId(attemptId) || !c.enabled) return null;
		const now = authLinkNow(this.clock);
		const source = await this.source(attemptId, c, now, { currentDevice: r.kind === "device" });
		const proof = requesterGuard(r);
		const row = await this.first<Attempt>({
			sql: `SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${CURRENT_CONFIG}
 AND ${proof.sql} AND ${source.sql}`,
			values: [attemptId, ...configValues(c), ...proof.values, ...source.values],
		});
		if (!row || !configMatches(row, c) || !requesterMatches(row, r)) return null;
		return { row, now };
	}
	/** The enrolled name of a headless attempt's device; read only to render headless consent. */
	async readHeadlessAuthLinkDeviceName(
		input: CoordinatorAuthLinkClaimInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<string | null> {
		const c = captureConfig(config);
		const i = this.browserInput(input);
		if (!c?.enabled || !i) return null;
		const row = await this.first<{ display_name: string | null }>({
			sql: `SELECT d.display_name FROM coordinator_auth_link_attempts a
 JOIN enrolled_devices d ON d.group_id = a.group_id AND d.device_id = a.device_id
 WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.browser_transaction_hash = ? AND a.${HEADLESS_MODE_SQL}`,
			values: [c.coordinatorId, i.attemptId, i.browserTransactionHash],
		});
		return typeof row?.display_name === "string" ? row.display_name : null;
	}
	/** The confirmed account for the signing device to approve; null for any other state or mode. */
	async readHeadlessAuthLinkApproval(
		input: CoordinatorAuthLinkHeadlessApprovalInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkHeadlessApproval | null> {
		const c = captureConfig(config);
		const i = capture(input, ["attemptId", "signer"]);
		const s = captureSigner(i?.signer);
		if (!c?.enabled || !i || !s || !isAuthControllerId(i.attemptId)) return null;
		const now = authLinkNow(this.clock);
		const source = await this.source(i.attemptId, c, now, { currentDevice: true });
		const proof = requesterGuard({ kind: "device", signer: s });
		const row = await this.first<Attempt>({
			sql: `SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${CURRENT_CONFIG}
 AND state = 'confirmed' AND expires_at_ms > ? AND ${HEADLESS_MODE_SQL} AND ${proof.sql} AND ${source.sql}`,
			values: [i.attemptId, ...configValues(c), now, ...proof.values, ...source.values],
		});
		if (
			!row ||
			!configMatches(row, c) ||
			!signerMatches(row, s) ||
			row.state !== "confirmed" ||
			row.loopback_redirect !== AUTH_LINK_HEADLESS_MARKER ||
			row.account_subject === null
		)
			return null;
		return { issuer: row.issuer, subject: row.account_subject, ...(await this.stagedProfile(row)) };
	}
	private async stagedProfile(row: Attempt) {
		const profile = await this.first<StagedProfile>({
			sql: `SELECT display_name, email, email_verified FROM coordinator_auth_link_profiles
 WHERE coordinator_id = ? AND attempt_id = ? AND issuer = ? AND subject = ? AND auth_config_revision = ?
 AND browser_transaction_hash = ? AND link_id IS NULL`,
			values: [
				row.coordinator_id,
				row.attempt_id,
				row.issuer,
				row.account_subject,
				row.auth_config_revision,
				row.browser_transaction_hash,
			],
		});
		let emailVerified: boolean | null = null;
		if (profile?.email_verified === 1) emailVerified = true;
		else if (profile?.email_verified === 0) emailVerified = false;
		return {
			displayName: profile?.display_name ?? null,
			email: profile?.email ?? null,
			emailVerified,
		};
	}
	private async acknowledgeFailedAttempt(
		row: Attempt,
		c: CoordinatorAuthLinkConfig,
		now: number,
		kind: "applied" | "existing",
	): Promise<CoordinatorAuthLinkResult> {
		const cleanup = await this.execute(
			{
				sql: "DELETE FROM coordinator_auth_link_profiles WHERE coordinator_id = ? AND attempt_id = ? AND link_id IS NULL",
				values: [c.coordinatorId, row.attempt_id],
			},
			"attempt_conflict",
		);
		if (typeof cleanup !== "number") return cleanup;
		return { kind, status: status(row, now) };
	}
	async failAuthLinkAttempt(
		input: CoordinatorAuthLinkFailInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const i = capture(input, ["attemptId", "requester", "reason"]);
		const r = captureRequester(i?.requester);
		if (
			!c ||
			!i ||
			!r ||
			!isAuthControllerId(i.attemptId) ||
			!["cancelled", "provider_failure", "config_failure"].includes(i.reason as string) ||
			(r.kind === "device" && i.reason !== "cancelled")
		)
			return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const reason = i.reason === "cancelled" ? `${r.kind}_cancelled` : (i.reason as string);
		const proof = requesterGuard(r);
		const result = await this.execute(
			{
				sql: `UPDATE coordinator_auth_link_attempts SET state = 'failed', failure_reason = ?, failed_at_ms = ?, account_subject = CASE WHEN authority_kind = 'device_claim' THEN NULL ELSE account_subject END WHERE attempt_id = ? AND ${CURRENT_CONFIG} AND ${RELEASABLE_SOURCE} AND link_id IS NULL AND expires_at_ms > ? AND state IN ('pending','browser_claimed','oidc_verified','confirmed') AND ${proof.sql}`,
				values: [reason, now, i.attemptId, ...configValues(c), now, ...proof.values],
			},
			"attempt_conflict",
		);
		if (typeof result !== "number") return result;
		const row = await this.read(i.attemptId, c, { authority: "either" });
		if (row && !requesterMatches(row, r)) return rejected("attempt_unavailable");
		// A signed own-attempt cancel can acknowledge browser cancellation without
		// rewriting its reason or creating any account authority.
		if (
			row &&
			configMatches(row, c) &&
			r.kind === "device" &&
			i.reason === "cancelled" &&
			row.state === "failed" &&
			row.failure_reason === "browser_cancelled" &&
			row.link_id === null &&
			row.created_at_ms <= now &&
			now < row.expires_at_ms
		)
			return this.acknowledgeFailedAttempt(row, c, now, "existing");
		if (
			row &&
			configMatches(row, c) &&
			requesterMatches(row, r) &&
			row.state === "failed" &&
			row.failure_reason === reason
		)
			return this.acknowledgeFailedAttempt(row, c, now, result ? "applied" : "existing");
		return diagnose(row, c, now);
	}
	async finalizeAuthLinkAttempt(
		input: CoordinatorAuthLinkFinalizeInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		return this.finalizeWithMode(input, config, { kind: "desktop" });
	}
	/** Links only the account the device approved; any other verified account writes nothing. */
	async finalizeHeadlessAuthLinkAttempt(
		input: CoordinatorAuthLinkHeadlessFinalizeInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const approved = capture(capture(input, ["approvedAccount"])?.approvedAccount, [
			"issuer",
			"subject",
		]);
		const account = c && parseCoordinatorAccountReference(approved, { issuer: c.issuer });
		if (!account?.ok) return rejected("invalid_input");
		// Fail closed: a headless link is never written without its provenance row.
		if (!(await hasHeadlessLinkProvenance(this.backend))) return rejected("attempt_unavailable");
		return this.finalizeWithMode(input, config, { kind: "headless", ...account.account });
	}
	private async finalizeWithMode(
		input: CoordinatorAuthLinkFinalizeInput,
		config: CoordinatorAuthLinkConfig,
		mode: FinalizeMode,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const captured = captureFinalize(input, c);
		const i: FinalizeRequest | null = captured && { ...captured, mode };
		if (!c || !i) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		if (
			i.groupId !== i.signer.groupId ||
			i.deviceId !== i.signer.deviceId ||
			i.fingerprint !== i.signer.fingerprint
		)
			return rejected("attempt_unavailable");
		const now = authLinkNow(this.clock);
		const linkId = globalThis.crypto.randomUUID();
		const connections = await this.connectionSchema();
		const row = await this.read(i.attemptId, c, { authority: "either" });
		if (row && !finalizeModeMatches(row, mode)) return rejected("attempt_unavailable");
		if (row?.authority_kind === "device_claim") return this.finalizeDevice(i, c, now, linkId, row);
		const authority = await this.readAuthority(i.attemptId, c);
		const requester = andStatement(
			connections
				? await connectionRequesterGuard(this.backend, i.identityId, i.signer, c, now)
				: { sql: "1 = 1", values: [] },
			finalizeModeGuard(mode),
		);
		try {
			await this.backend.batch([
				...finalizeStatements(i, c, now, linkId, authority, connections, requester),
				...(connections ? connectionSuccessorStatements(c.coordinatorId, i.attemptId, linkId) : []),
				promoteAuthLinkProfile(c.coordinatorId, i.attemptId, linkId),
				...(await initialConnectionFloor(this.backend, c.coordinatorId, linkId)),
				...provenanceStatements(i, c, linkId),
			]);
		} catch (error) {
			if (isAuthControllerUniqueError(error)) return rejected("link_conflict");
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
		return this.finalizeReceipt(i, c, now, linkId);
	}
	private async finalizeDevice(
		i: FinalizeRequest,
		c: CoordinatorAuthLinkConfig,
		now: number,
		linkId: string,
		row: Attempt,
	): Promise<CoordinatorAuthLinkResult> {
		if (!configMatches(row, c) || !finalizeMatches(row, i)) return diagnose(row, c, now);
		const source = await this.finalizeSource(i, c, now);
		// Exact retries read retained evidence. The immutable proof must never be reinserted.
		if (["finalized", "session_redeemed"].includes(row.state))
			return this.deviceReceipt(i, c, now, linkId, source);
		const keyId = await ed25519KeyIdForRevocation(i.signer.publicKey);
		if (!keyId) return rejected("attempt_unavailable");
		const connections = await this.connectionSchema();
		const binding = await this.prepareFirstClaimBinding(i, c, now, linkId, row, connections);
		if (!binding) return rejected("attempt_unavailable");
		const consistency = await readNegativeOwnerConsistency(this.backend, {
			coordinatorId: c.coordinatorId,
			ownerIdentityId: i.identityId,
			deviceId: i.signer.deviceId,
			publicKey: i.signer.publicKey,
			fingerprint: i.signer.fingerprint,
			enrollment: { groupId: i.signer.groupId },
		});
		if (!consistency) return rejected("attempt_unavailable");
		try {
			// The retained-ownership guards replace the pin the attempt update and claim insert
			// carried. A changed fact writes nothing, as that pin made the whole batch a no-op,
			// and the receipt below then refuses.
			await writeGuarded(this.backend, consistency.guards, [
				...deviceFinalizeStatements(i, c, now, linkId, keyId, source, connections),
				...(connections ? connectionSuccessorStatements(c.coordinatorId, i.attemptId, linkId) : []),
				promoteAuthLinkProfile(c.coordinatorId, i.attemptId, linkId),
				...(await initialConnectionFloor(this.backend, c.coordinatorId, linkId)),
				...provenanceStatements(i, c, linkId),
				...binding,
			]);
		} catch (error) {
			if (
				isAuthControllerUniqueError(error) ||
				String(error).includes("auth_device_claim_collision")
			)
				return rejected("link_conflict");
			if (isDeviceClaimBindingConflict(error)) return rejected("attempt_unavailable");
			throw authPersistenceError(error, "auth_link_persistence_error");
		}
		return this.deviceReceipt(i, c, now, linkId, await this.finalizeSource(i, c, now), {
			requireCompleteBinding: true,
		});
	}
	private async prepareFirstClaimBinding(
		i: FinalizeRequest,
		c: CoordinatorAuthLinkConfig,
		now: number,
		linkId: string,
		row: Attempt,
		connections: boolean,
	): Promise<AuthLinkStatement[] | null> {
		if (row.prior_link_id) return [];
		const plan = await prepareFirstLinkDeviceClaimBinding(
			this.backend,
			{ signer: i.signer, currentIdentityId: i.identityId },
			c,
			now,
		);
		if (!plan) return null;
		return deviceClaimBindingStatements(
			plan,
			globalThis.crypto.randomUUID(),
			globalThis.crypto.randomUUID(),
			{
				winning: {
					sql: `EXISTS (SELECT 1 FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${CURRENT_CONFIG}
 AND authority_kind = 'device_claim' AND state = 'finalized' AND link_id = ? AND finalized_at_ms = ?${connections ? " AND prior_link_id IS NULL" : ""})`,
					values: [i.attemptId, ...configValues(c), linkId, now],
				},
			},
		);
	}
	private async finalizeSource(
		i: FinalizeRequest,
		c: CoordinatorAuthLinkConfig,
		now: number,
	): Promise<AuthLinkStatement> {
		const source = await this.source(i.attemptId, c, now, { currentDevice: true });
		return andStatement(source, finalizeModeGuard(i.mode));
	}
	private async deviceReceipt(
		i: CoordinatorAuthLinkFinalizeInput,
		c: CoordinatorAuthLinkConfig,
		now: number,
		linkId: string,
		source: AuthLinkStatement,
		options: { requireCompleteBinding?: boolean } = {},
	): Promise<CoordinatorAuthLinkResult> {
		const row = await this.first<Attempt>({
			sql: `SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${CURRENT_CONFIG}
 AND authority_kind = 'device_claim' AND state IN ('finalized','session_redeemed') AND ${source.sql}`,
			values: [i.attemptId, ...configValues(c), ...source.values],
		});
		if (!row || !finalizeMatches(row, i)) return rejected("attempt_unavailable");
		if (
			options.requireCompleteBinding &&
			!row.prior_link_id &&
			!(await readFirstLinkDeviceClaimOwnershipComplete(
				this.backend,
				{ signer: i.signer, currentIdentityId: i.identityId },
				c,
				now,
			))
		)
			return rejected("attempt_unavailable");
		return { kind: row.link_id === linkId ? "applied" : "existing", status: status(row, now) };
	}
	private async finalizeReceipt(
		i: CoordinatorAuthLinkFinalizeInput,
		c: CoordinatorAuthLinkConfig,
		now: number,
		linkId: string,
	): Promise<CoordinatorAuthLinkResult> {
		const row = await this.read(i.attemptId, c);
		if (
			row &&
			configMatches(row, c) &&
			finalizeMatches(row, i) &&
			["finalized", "session_redeemed"].includes(row.state)
		) {
			const receipt = await this.first({
				sql: receiptSql(await this.connectionSchema()),
				values: [c.coordinatorId, i.attemptId, row.link_id],
			});
			if (!receipt) throw new Error("auth_link_persistence_incomplete");
			return { kind: row.link_id === linkId ? "applied" : "existing", status: status(row, now) };
		}
		if (row && !finalizeMatches(row, i)) return rejected("attempt_unavailable");
		const diagnosis = diagnose(row, c, now);
		if (
			!row ||
			diagnosis.error !== "attempt_unavailable" ||
			row.state !== "confirmed" ||
			!finalizeMatches(row, i)
		)
			return diagnosis;
		return rejected("controller_not_active");
	}
}
function deviceFinalizeStatements(
	i: CoordinatorAuthLinkFinalizeInput,
	c: CoordinatorAuthLinkConfig,
	now: number,
	linkId: string,
	keyId: string,
	source: AuthLinkStatement,
	connections = false,
): AuthLinkStatement[] {
	// Every insert selects only this batch's winning transition, never an older receipt.
	const winning = `attempt_id = ? AND ${CURRENT_CONFIG} AND authority_kind = 'device_claim'
 AND state = 'finalized' AND link_id = ? AND finalized_at_ms = ?`;
	const values = [i.attemptId, ...configValues(c), linkId, now];
	return [
		{
			sql: `UPDATE coordinator_auth_link_attempts SET state = 'finalized', link_id = ?, finalized_at_ms = ?
 WHERE (attempt_id = ? AND ${CURRENT_CONFIG} AND authority_kind = 'device_claim' AND state = 'confirmed')
 AND (created_at_ms <= ? AND expires_at_ms > ?) AND (group_id = ? AND identity_id = ? AND device_id = ? AND fingerprint = ? AND public_key = ?)
 AND (runtime_verifier_hash = ? AND completion_secret_hash = ? AND account_subject IS NOT NULL AND browser_transaction_hash IS NOT NULL)
 AND (created_at_ms <= claimed_at_ms AND claimed_at_ms <= oidc_verified_at_ms AND oidc_verified_at_ms <= confirmed_at_ms AND confirmed_at_ms <= ?)
 AND (${source.sql})${connections ? ` AND (${connectionFinalizeGuard("coordinator_auth_link_attempts")})` : ""}`,
			values: [
				linkId,
				now,
				i.attemptId,
				...configValues(c),
				now,
				now,
				i.groupId,
				i.identityId,
				i.deviceId,
				i.fingerprint,
				i.signer.publicKey,
				i.runtimeVerifierHash,
				i.completionSecretHash,
				now,
				...source.values,
			],
		},
		{
			sql: `INSERT INTO coordinator_auth_device_claims
 (claim_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,key_id,attempt_id,issuer,auth_config_revision,created_at_ms)
 SELECT link_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,?,attempt_id,issuer,auth_config_revision,finalized_at_ms
 FROM coordinator_auth_link_attempts WHERE ${winning}${connections ? " AND prior_link_id IS NULL" : ""}`,
			values: [keyId, ...values],
		},
		{
			sql: `INSERT INTO coordinator_auth_account_links
 (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,device_claim_id,auth_config_revision,created_at_ms,authority_kind)
 SELECT coordinator_id,link_id,issuer,account_subject,identity_id,attempt_id,NULL,${connections ? "(SELECT claim_id FROM coordinator_auth_device_claims d WHERE d.coordinator_id=coordinator_auth_link_attempts.coordinator_id AND d.identity_id=coordinator_auth_link_attempts.identity_id)" : "link_id"},auth_config_revision,finalized_at_ms,'device_claim'
 FROM coordinator_auth_link_attempts WHERE ${winning}`,
			values,
		},
		{
			sql: `INSERT INTO coordinator_auth_link_audit_log
 (coordinator_id,link_id,action,attempt_id,identity_id,group_id,device_id,fingerprint,controller_attestation_id,device_claim_id,auth_config_revision,created_at_ms,authority_kind)
 SELECT coordinator_id,link_id,'link_created',attempt_id,identity_id,group_id,device_id,fingerprint,NULL,${connections ? "(SELECT claim_id FROM coordinator_auth_device_claims d WHERE d.coordinator_id=coordinator_auth_link_attempts.coordinator_id AND d.identity_id=coordinator_auth_link_attempts.identity_id)" : "link_id"},auth_config_revision,finalized_at_ms,'device_claim'
 FROM coordinator_auth_link_attempts WHERE ${winning}`,
			values,
		},
	];
}
type FinalizeMode = { kind: "desktop" } | { kind: "headless"; issuer: string; subject: string };
type FinalizeRequest = CoordinatorAuthLinkFinalizeInput & { mode: FinalizeMode };
/** Written in the winning finalize batch, so a headless link and its provenance commit together. */
function provenanceStatements(
	i: FinalizeRequest,
	c: CoordinatorAuthLinkConfig,
	linkId: string,
): AuthLinkStatement[] {
	if (i.mode.kind !== "headless") return [];
	return [headlessLinkProvenanceStatement(c.coordinatorId, i.attemptId, linkId)];
}
function finalizeModeGuard(mode: FinalizeMode): AuthLinkStatement {
	const t = "coordinator_auth_link_attempts";
	if (mode.kind === "desktop") return { sql: `${t}.${DESKTOP_MODE_SQL}`, values: [] };
	return {
		sql: `${t}.${HEADLESS_MODE_SQL} AND ${t}.issuer = ? AND ${t}.account_subject = ?`,
		values: [mode.issuer, mode.subject],
	};
}
function finalizeModeMatches(row: Attempt, mode: FinalizeMode): boolean {
	if (mode.kind === "desktop") return row.loopback_redirect !== AUTH_LINK_HEADLESS_MARKER;
	return (
		row.loopback_redirect === AUTH_LINK_HEADLESS_MARKER &&
		row.issuer === mode.issuer &&
		row.account_subject === mode.subject
	);
}
function andStatement(a: AuthLinkStatement, b: AuthLinkStatement): AuthLinkStatement {
	return { sql: `(${a.sql}) AND (${b.sql})`, values: [...a.values, ...b.values] };
}
function requesterGuard(r: CoordinatorAuthLinkRequester): AuthLinkStatement {
	if (r.kind === "browser")
		return { sql: "browser_transaction_hash = ?", values: [r.browserTransactionHash] };
	return {
		sql: "group_id = ? AND device_id = ? AND public_key = ? AND fingerprint = ?",
		values: [r.signer.groupId, r.signer.deviceId, r.signer.publicKey, r.signer.fingerprint],
	};
}
function captureFinalize(
	input: unknown,
	c: CoordinatorAuthLinkConfig | null,
): CoordinatorAuthLinkFinalizeInput | null {
	const i = capture(input, [
		"purpose",
		"coordinatorId",
		"attemptId",
		"groupId",
		"identityId",
		"deviceId",
		"fingerprint",
		"runtimeVerifierHash",
		"completionSecretHash",
		"signer",
	]);
	const s = captureSigner(i?.signer);
	if (!c || !i || !s || i.purpose !== AUTH_LINK_PURPOSE || i.coordinatorId !== c.coordinatorId)
		return null;
	if (
		![i.attemptId, i.groupId, i.identityId, i.deviceId].every(isAuthControllerId) ||
		![i.fingerprint, i.runtimeVerifierHash, i.completionSecretHash].every(isHash)
	)
		return null;
	return { ...i, signer: s } as unknown as CoordinatorAuthLinkFinalizeInput;
}
function finalizeMatches(row: Attempt, i: CoordinatorAuthLinkFinalizeInput): boolean {
	return (
		signerMatches(row, i.signer) &&
		row.identity_id === i.identityId &&
		row.runtime_verifier_hash === i.runtimeVerifierHash &&
		row.completion_secret_hash === i.completionSecretHash
	);
}
function finalizeStatements(
	i: CoordinatorAuthLinkFinalizeInput,
	c: CoordinatorAuthLinkConfig,
	now: number,
	linkId: string,
	authority: (string | number | null)[] | null,
	connections = false,
	requester: AuthLinkStatement = { sql: "1 = 1", values: [] },
): AuthLinkStatement[] {
	const authorityGuard = authority ? AUTHORITY : "0 = 1";
	const consume: AuthLinkStatement = {
		sql: `UPDATE coordinator_auth_link_attempts SET state = 'finalized', link_id = ?, finalized_at_ms = ? WHERE attempt_id = ? AND ${LIVE_CONFIG} AND state = 'confirmed' AND expires_at_ms > ? AND group_id = ? AND identity_id = ? AND device_id = ? AND fingerprint = ? AND public_key = ? AND runtime_verifier_hash = ? AND completion_secret_hash = ? AND ${authorityGuard}${connections ? ` AND ${connectionFinalizeGuard("coordinator_auth_link_attempts")}` : ""} AND ${requester.sql}`,
		values: [
			linkId,
			now,
			i.attemptId,
			...configValues(c),
			now,
			i.groupId,
			i.identityId,
			i.deviceId,
			i.fingerprint,
			i.signer.publicKey,
			i.runtimeVerifierHash,
			i.completionSecretHash,
			...(authority ?? []),
			...requester.values,
		],
	};
	const link: AuthLinkStatement = {
		sql: `INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id, attempt_id, controller_attestation_id, auth_config_revision, created_at_ms, authority_kind) SELECT coordinator_id, link_id, issuer, account_subject, identity_id, attempt_id, controller_attestation_id, auth_config_revision, finalized_at_ms, 'controller_attestation' FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${LIVE_CONFIG} AND link_id = ? AND state = 'finalized'`,
		values: [i.attemptId, ...configValues(c), linkId],
	};
	const audit: AuthLinkStatement = {
		sql: `INSERT INTO coordinator_auth_link_audit_log (coordinator_id, link_id, action, attempt_id, identity_id, group_id, device_id, fingerprint, controller_attestation_id, auth_config_revision, created_at_ms, authority_kind) SELECT t.coordinator_id, t.link_id, 'link_created', t.attempt_id, t.identity_id, t.group_id, t.device_id, t.fingerprint, t.controller_attestation_id, t.auth_config_revision, t.finalized_at_ms, 'controller_attestation' FROM coordinator_auth_link_attempts t JOIN coordinator_auth_account_links l ON l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id AND l.authority_kind = 'controller_attestation' WHERE t.authority_kind = 'controller_attestation' AND t.attempt_id = ? AND t.coordinator_id = ? AND t.issuer = ? AND t.auth_config_revision = ? AND ? = 1 AND t.link_id = ?`,
		values: [i.attemptId, ...configValues(c), linkId],
	};
	return [consume, link, audit];
}
function receiptSql(connections: boolean) {
	return `SELECT 1 FROM coordinator_auth_link_attempts t
 JOIN ${connections ? `(${CONNECTION_BIRTHS_SQL})` : "coordinator_auth_account_links"} l ON l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id
 AND l.attempt_id = t.attempt_id AND l.identity_id = t.identity_id AND l.issuer = t.issuer AND l.subject = t.account_subject
 AND l.authority_kind = 'controller_attestation' AND l.controller_attestation_id IS NOT NULL AND l.controller_attestation_id IS t.controller_attestation_id AND l.device_claim_id IS NULL AND l.auth_config_revision = t.auth_config_revision AND l.created_at_ms = t.finalized_at_ms
 JOIN coordinator_auth_link_audit_log a ON a.coordinator_id = t.coordinator_id AND a.link_id = t.link_id AND a.action = 'link_created'
 AND a.attempt_id = t.attempt_id AND a.identity_id = t.identity_id AND a.group_id = t.group_id AND a.device_id = t.device_id
 AND a.fingerprint = t.fingerprint AND a.authority_kind = 'controller_attestation' AND a.controller_attestation_id IS t.controller_attestation_id AND a.device_claim_id IS NULL AND a.auth_config_revision = t.auth_config_revision AND a.created_at_ms = t.finalized_at_ms
 WHERE t.authority_kind = 'controller_attestation' AND t.coordinator_id = ? AND t.attempt_id = ? AND t.link_id = ?`;
}
