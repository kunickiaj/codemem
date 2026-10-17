import { AUTH_DEVICE_CLAIM_DEFINITION_CHECKS } from "./coordinator-auth-device-claim-schema.js";

/** Frozen schema-10 readiness, copied before V3 changes current readiness.
 * This intentionally checks exactly three claim-table triggers through the
 * separately frozen V2 proof definitions. Never add the V3 genesis guard here.
 * It reproduces the old binary's predicate, not full migration recognition;
 * exact predecessor DDL/dependency validation is a separate implementation unit.
 */
export const AUTH_SCHEMA_V2_READY_COUNT = 10;
export const AUTH_SCHEMA_V2_READINESS_SQL = `SELECT
 (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_attempts') WHERE lower(name) = 'authority_kind')
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_links') WHERE lower(name) IN ('authority_kind','device_claim_id'))
	+ (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_audit_log') WHERE lower(name) IN ('authority_kind','device_claim_id'))
	+ (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_link_profiles')
 + ${AUTH_DEVICE_CLAIM_DEFINITION_CHECKS.map(({ matches }) => `(${matches})`).join(" + ")} AS ready`;
