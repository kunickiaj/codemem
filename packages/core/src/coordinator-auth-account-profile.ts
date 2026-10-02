import {
	AUTH_ACCOUNT_PROFILE_WRITE_WINDOW_MS,
	type CoordinatorAuthAccountProfileClearResult,
	type CoordinatorAuthAccountProfileInput,
	type CoordinatorAuthAccountProfileStore,
	type CoordinatorAuthAccountProfileWriteResult,
	type CoordinatorAuthSessionAccount,
} from "./coordinator-auth-account-profile-contract.js";
import { isCoordinatorAccountIssuer } from "./coordinator-auth-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import {
	AUTH_SESSION_LINK_MATCH_SQL,
	AUTH_SESSION_LIVE_GUARD_SQL,
	authSessionNow,
} from "./coordinator-auth-session.js";
import type { CoordinatorOidcProfile } from "./coordinator-oidc.js";

export * from "./coordinator-auth-account-profile-contract.js";

function hasPlainPrototype(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function capture(
	value: unknown,
	options: { fields: readonly string[]; required: boolean; plain?: boolean },
): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	try {
		if (Array.isArray(value)) return null;
		if (options.plain && !hasPlainPrototype(value)) return null;
		const result: Record<string, unknown> = Object.create(null);
		for (const key of options.fields) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor) {
				if (options.required) return null;
				continue;
			}
			if (!Object.hasOwn(descriptor, "value")) return null;
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return null;
	}
}
function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function captureConfig(value: unknown): CoordinatorAuthLinkConfig | null {
	const c = capture(value, {
		fields: ["coordinatorId", "issuer", "revision", "enabled"],
		required: true,
	});
	if (
		!c ||
		!isAuthControllerId(c.coordinatorId) ||
		!isCoordinatorAccountIssuer(c.issuer) ||
		!isHash(c.revision) ||
		typeof c.enabled !== "boolean"
	)
		return null;
	return {
		coordinatorId: c.coordinatorId,
		issuer: c.issuer,
		revision: c.revision,
		enabled: c.enabled,
	};
}
function optionalText(value: unknown, maxLength: number): string | undefined {
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
function optionalPicture(value: unknown): string | undefined {
	const text = optionalText(value, 2048);
	if (
		!text ||
		text.trim() !== text ||
		text.includes("\\") ||
		text.includes("#") ||
		!/^https:\/\//i.test(text) ||
		/^https:\/\/[^/?#]*@/i.test(text)
	)
		return undefined;
	try {
		const url = new URL(text);
		if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
		const canonical = url.href;
		return optionalText(canonical, 2048);
	} catch {
		return undefined;
	}
}
function projectProfile(fields: Record<string, unknown>): CoordinatorOidcProfile {
	const profile: CoordinatorOidcProfile = {};
	const displayName = optionalText(fields.displayName, 256);
	const email = optionalText(fields.email, 320);
	const pictureUrl = optionalPicture(fields.pictureUrl);
	if (displayName !== undefined) profile.displayName = displayName;
	if (email !== undefined) {
		profile.email = email;
		if (typeof fields.emailVerified === "boolean") profile.emailVerified = fields.emailVerified;
	}
	if (pictureUrl !== undefined) profile.pictureUrl = pictureUrl;
	return profile;
}
interface AccountRow {
	session_id: string;
	identity_id: string;
	link_id: string;
	issuer: string;
	subject: string;
	expires_at_ms: number;
	display_name: unknown;
	email: unknown;
	email_verified: unknown;
	picture_url: unknown;
}
const SESSION_FROM_SQL = `FROM coordinator_auth_sessions s
 JOIN coordinator_auth_account_links l ON ${AUTH_SESSION_LINK_MATCH_SQL}`;
const PROFILE_WRITE_SQL = `INSERT INTO coordinator_auth_account_profiles
 (coordinator_id, link_id, display_name, email, email_verified, picture_url, source_session_id, source_signed_in_at_ms)
 SELECT s.coordinator_id, s.link_id, ?, ?, ?, ?, s.session_id, s.created_at_ms
 ${SESSION_FROM_SQL}
 JOIN coordinator_auth_session_receipts r ON r.coordinator_id = s.coordinator_id
 AND r.session_id = s.session_id AND r.browser_transaction_hash = s.browser_transaction_hash
 AND r.link_id = s.link_id AND r.auth_config_revision = s.auth_config_revision AND r.created_at_ms = s.created_at_ms
 WHERE ${AUTH_SESSION_LIVE_GUARD_SQL} AND r.source = 'signin' AND r.attempt_id IS NULL
 AND ? < s.created_at_ms + ${AUTH_ACCOUNT_PROFILE_WRITE_WINDOW_MS}
 ON CONFLICT(coordinator_id, link_id) DO UPDATE SET
 display_name = excluded.display_name, email = excluded.email,
 email_verified = excluded.email_verified, picture_url = excluded.picture_url,
 source_session_id = excluded.source_session_id, source_signed_in_at_ms = excluded.source_signed_in_at_ms
 WHERE excluded.source_signed_in_at_ms > coordinator_auth_account_profiles.source_signed_in_at_ms`;
const PROFILE_READ_SQL = `SELECT s.session_id, s.identity_id, s.link_id, s.issuer, s.subject, s.expires_at_ms,
 p.display_name, p.email, p.email_verified, p.picture_url
 ${SESSION_FROM_SQL} LEFT JOIN coordinator_auth_account_profiles p
 ON p.coordinator_id = s.coordinator_id AND p.link_id = s.link_id
 WHERE ${AUTH_SESSION_LIVE_GUARD_SQL}`;
const PROFILE_RECORDED_SQL = `SELECT 1 ${SESSION_FROM_SQL}
 JOIN coordinator_auth_account_profiles p ON p.coordinator_id = s.coordinator_id AND p.link_id = s.link_id
 AND p.source_session_id = s.session_id
 WHERE ${AUTH_SESSION_LIVE_GUARD_SQL}`;
function liveValues(
	c: CoordinatorAuthLinkConfig,
	credentialHash: string,
	now: number,
): AuthLinkStatement["values"] {
	return [c.coordinatorId, credentialHash, c.issuer, c.revision, now, now];
}

/** Optional verified display snapshots only. No JWT/cookie verification or authority changes.
 * Purging stays separate from revocation: an older database lacking this table must
 * never prevent revocation. Future public handlers must authenticate the admin first.
 */
export class AuthAccountProfileOperations implements CoordinatorAuthAccountProfileStore {
	constructor(
		private readonly backend: AuthLinkBackend,
		private readonly clock: () => number = Date.now,
	) {}
	private async first<T>(statement: AuthLinkStatement): Promise<T | null> {
		try {
			return await this.backend.first<T>(statement);
		} catch {
			throw new Error("auth_account_profile_persistence_error");
		}
	}
	private async run(statement: AuthLinkStatement): Promise<number> {
		try {
			return await this.backend.run(statement);
		} catch {
			throw new Error("auth_account_profile_persistence_error");
		}
	}
	async recordAuthAccountProfile(
		input: CoordinatorAuthAccountProfileInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthAccountProfileWriteResult> {
		const c = captureConfig(config);
		const i = capture(input, { fields: ["credentialHash", "profile"], required: true });
		if (!c || !i || !isHash(i.credentialHash)) return { kind: "rejected", error: "invalid_input" };
		const fields = capture(i.profile, {
			fields: ["displayName", "email", "emailVerified", "pictureUrl"],
			required: false,
			plain: true,
		});
		if (!fields) return { kind: "rejected", error: "invalid_input" };
		if (!c.enabled) return { kind: "rejected", error: "auth_config_changed" };
		const profile = projectProfile(fields);
		const now = authSessionNow(this.clock);
		let verified: number | null = null;
		if (profile.emailVerified !== undefined) verified = Number(profile.emailVerified);
		await this.run({
			sql: PROFILE_WRITE_SQL,
			values: [
				profile.displayName ?? null,
				profile.email ?? null,
				verified,
				profile.pictureUrl ?? null,
				...liveValues(c, i.credentialHash, now),
				now,
			],
		});
		const recorded = await this.first({
			sql: PROFILE_RECORDED_SQL,
			values: liveValues(c, i.credentialHash, authSessionNow(this.clock)),
		});
		return { kind: recorded ? "recorded" : "not_recorded" };
	}
	async readAuthSessionAccount(
		credentialHash: string,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSessionAccount | null> {
		const c = captureConfig(config);
		if (!c?.enabled || !isHash(credentialHash)) return null;
		const row = await this.first<AccountRow>({
			sql: PROFILE_READ_SQL,
			values: liveValues(c, credentialHash, authSessionNow(this.clock)),
		});
		if (!row) return null;
		let emailVerified: boolean | undefined;
		if (row.email_verified === 0) emailVerified = false;
		if (row.email_verified === 1) emailVerified = true;
		return {
			session: {
				sessionId: row.session_id,
				identityId: row.identity_id,
				linkId: row.link_id,
				account: { issuer: row.issuer, subject: row.subject },
				expiresAtMs: row.expires_at_ms,
			},
			profile: projectProfile({
				displayName: row.display_name,
				email: row.email,
				emailVerified,
				pictureUrl: row.picture_url,
			}),
		};
	}
	async clearRevokedAuthAccountProfile(
		input: { linkId: string },
		scope: { coordinatorId: string },
	): Promise<CoordinatorAuthAccountProfileClearResult> {
		const i = capture(input, { fields: ["linkId"], required: true });
		const s = capture(scope, { fields: ["coordinatorId"], required: true });
		if (!i || !s || !isAuthControllerId(i.linkId) || !isAuthControllerId(s.coordinatorId))
			return { kind: "rejected", error: "invalid_input" };
		const deletedCount = await this.run({
			sql: `DELETE FROM coordinator_auth_account_profiles WHERE coordinator_id = ? AND link_id = ?
 AND EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = coordinator_auth_account_profiles.coordinator_id
 AND l.link_id = coordinator_auth_account_profiles.link_id AND l.revoked_at_ms IS NOT NULL)`,
			values: [s.coordinatorId, i.linkId],
		});
		return { kind: "cleared", deletedCount };
	}
}
