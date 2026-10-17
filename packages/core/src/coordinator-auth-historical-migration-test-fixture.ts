// Account-auth history only: 0029 adds its browser purpose;
// the 0030 owner-attempt table remains caller-owned.
export const AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES = Object.freeze([
	"0016_add_auth_controller_attestations.sql",
	"0017_add_auth_account_links.sql",
	"0018_add_auth_sessions.sql",
	"0019_add_auth_link_attempt_limit_indexes.sql",
	"0020_add_auth_browser_transactions.sql",
	"0021_add_auth_account_profiles.sql",
	"0022_add_auth_session_admission_index.sql",
	"0023_add_auth_signin_purge_floors.sql",
	"0024_add_auth_guarded_signin_retention.sql",
	"0025_add_auth_link_browser_start_hash.sql",
	"0029_add_owner_enrollment_attempts.sql",
	"0032_device_claim_proofs.sql",
	"0033_add_auth_link_profiles.sql",
] as const);
