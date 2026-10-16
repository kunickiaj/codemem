import {
	AUTH_LINK_AUTHORITY_COLUMNS,
	AUTH_LINK_AUTHORITY_GUARD_SQL,
	AUTH_LINK_CONTROLLER_SOURCE_SQL,
	type AuthLinkAuthoritySource,
	type AuthLinkBackend,
	authLinkControllerSourceValues,
	captureAuthLinkConfig,
	captureAuthLinkSigner,
	deriveAuthLinkAuthority,
} from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { authPersistenceError } from "./coordinator-auth-schema.js";

/** Public device-authenticated response. No account identifiers or credentials. */
export interface CoordinatorAccountLinkStatus {
	version: 1;
	coordinatorId: string;
	groupId: string;
	deviceId: string;
	fingerprint: string;
	identityId: string | null;
	state: "review_required" | "unlinked" | "linked" | "revoked" | "conflict";
	account: { email?: string; displayName?: string } | null;
}
export interface CoordinatorAccountLinkStatusStore {
	readAccountLinkStatus(
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
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

function projectStatus(
	base: CoordinatorAccountLinkStatus,
	row: StatusRow | null,
	config: CoordinatorAuthLinkConfig,
): CoordinatorAccountLinkStatus {
	if (!row) return base;
	const derived = { ...base, identityId: row.identity_id };
	if (row.link_id === null) return { ...derived, state: "unlinked" };
	if (row.revoked_at_ms !== null) return { ...derived, state: "revoked" };
	if (row.issuer !== config.issuer) return { ...base, state: "conflict" };
	const account: NonNullable<CoordinatorAccountLinkStatus["account"]> = {};
	const displayName = safeDisplayText(row.display_name, 256);
	const email = row.email_verified === 1 ? safeDisplayText(row.email, 320) : undefined;
	if (displayName !== undefined) account.displayName = displayName;
	if (email !== undefined) account.email = email;
	return { ...derived, state: "linked", account };
}

/** Reads only. Rechecks the exact enrollment and controller after key derivation. */
export class AccountLinkStatusOperations implements CoordinatorAccountLinkStatusStore {
	constructor(private readonly backend: Pick<AuthLinkBackend, "first">) {}

	async readAccountLinkStatus(
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAccountLinkStatus> {
		const c = captureAuthLinkConfig(config);
		const s = captureAuthLinkSigner(signer);
		if (!c?.enabled || !s) throw new Error("account_link_status_unavailable");
		const base: CoordinatorAccountLinkStatus = {
			version: 1,
			coordinatorId: c.coordinatorId,
			groupId: s.groupId,
			deviceId: s.deviceId,
			fingerprint: s.fingerprint,
			identityId: null,
			state: "review_required",
			account: null,
		};
		try {
			const values = authLinkControllerSourceValues(c, s);
			const source = await this.backend.first<
				AuthLinkAuthoritySource & { authority_count: number }
			>({
				sql: `SELECT ${AUTH_LINK_AUTHORITY_COLUMNS}, count(*) OVER () AS authority_count
				 ${AUTH_LINK_CONTROLLER_SOURCE_SQL}`,
				values,
			});
			if (source?.authority_count !== 1) return base;
			const authority = await deriveAuthLinkAuthority(source);
			// The final statement reads authority, tombstones and display metadata together.
			const row = await this.backend.first<StatusRow>({
				sql: `WITH controller AS (
				 SELECT a.identity_id ${AUTH_LINK_CONTROLLER_SOURCE_SQL} ${AUTH_LINK_AUTHORITY_GUARD_SQL}
				 ), unique_controller AS (SELECT identity_id FROM controller
				 WHERE (SELECT count(*) FROM controller) = 1)
				 SELECT a.identity_id, l.link_id, l.issuer, l.revoked_at_ms,
				 p.display_name, p.email, p.email_verified
				 FROM unique_controller a LEFT JOIN coordinator_auth_account_links l
				 ON l.coordinator_id = ? AND l.identity_id = a.identity_id AND l.authority_kind = 'controller_attestation'
				 LEFT JOIN coordinator_auth_account_profiles p
				 ON p.coordinator_id = l.coordinator_id AND p.link_id = l.link_id`,
				values: [...values, ...authority, c.coordinatorId],
			});
			return projectStatus(base, row, c);
		} catch (error) {
			throw authPersistenceError(error, "account_link_status_unavailable");
		}
	}
}
