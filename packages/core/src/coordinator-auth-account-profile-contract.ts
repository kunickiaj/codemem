import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import type { CoordinatorAuthSession } from "./coordinator-auth-session-contract.js";
import type { CoordinatorOidcProfile } from "./coordinator-oidc.js";

export const AUTH_ACCOUNT_PROFILE_WRITE_WINDOW_MS = 120000;
export interface CoordinatorAuthAccountProfileInput {
	credentialHash: string;
	profile: unknown;
}
export type CoordinatorAuthAccountProfileWriteResult =
	| { kind: "recorded" }
	| { kind: "not_recorded" }
	| { kind: "rejected"; error: "invalid_input" | "auth_config_changed" };
export interface CoordinatorAuthSessionAccount {
	session: CoordinatorAuthSession;
	profile: CoordinatorOidcProfile;
}
export type CoordinatorAuthAccountProfileClearResult =
	| { kind: "cleared"; deletedCount: number }
	| { kind: "rejected"; error: "invalid_input" };
/** Display only. Callers must verify OIDC before writing and configured-admin authority
 * before clearing. These operations never issue sessions or grant authority.
 */
export interface CoordinatorAuthAccountProfileStore {
	recordAuthAccountProfile(
		input: CoordinatorAuthAccountProfileInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthAccountProfileWriteResult>;
	readAuthSessionAccount(
		credentialHash: string,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSessionAccount | null>;
	clearRevokedAuthAccountProfile(
		input: { linkId: string },
		scope: { coordinatorId: string },
	): Promise<CoordinatorAuthAccountProfileClearResult>;
}

// Empty metadata table only: no foreign keys, backfill, or startup writes.
export const AUTH_ACCOUNT_PROFILE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_account_profiles (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 display_name TEXT CHECK (display_name IS NULL OR (typeof(display_name) = 'text' AND length(display_name) BETWEEN 1 AND 256)),
 email TEXT CHECK (email IS NULL OR (typeof(email) = 'text' AND length(email) BETWEEN 1 AND 320)),
 email_verified INTEGER CHECK (email_verified IS NULL OR (typeof(email_verified) = 'integer' AND email_verified IN (0,1) AND email IS NOT NULL)),
 picture_url TEXT CHECK (picture_url IS NULL OR (typeof(picture_url) = 'text' AND length(picture_url) BETWEEN 1 AND 2048 AND substr(picture_url, 1, 8) = 'https://')),
 source_session_id TEXT NOT NULL,
 source_signed_in_at_ms INTEGER NOT NULL CHECK (typeof(source_signed_in_at_ms) = 'integer' AND source_signed_in_at_ms BETWEEN 0 AND 9007199225940991),
 PRIMARY KEY (coordinator_id, link_id)
);`;
