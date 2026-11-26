import type { Database } from "better-sqlite3";
import { getEffectiveCachedScopeAuthorization } from "./scope-membership-cache-read.js";
import { LEGACY_SHARED_REVIEW_SCOPE_ID, LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";

export interface ScopeVisibilityOptions {
	/** Public key of the runtime's actual signing key, not an enrolled DB row. */
	expectedPublicKey?: string;
	/** Read-only key loader, called once only when coordinator candidates exist. */
	loadExpectedPublicKey?: () => string | undefined;
}

function resolveVisibilityPublicKey(
	memberScopes: Array<{ scope_id: string | null; authority_type: string }>,
	options: ScopeVisibilityOptions,
): string | undefined {
	if (options.expectedPublicKey != null) return options.expectedPublicKey;
	if (!memberScopes.some((row) => row.scope_id != null && row.authority_type === "coordinator"))
		return undefined;
	return options.loadExpectedPublicKey?.();
}

/**
 * Resolve readable scopes once per request. Coordinator membership SQL lists
 * candidates only; retained proof must match the supplied actual signing key.
 * Unknown scopes deny, while local/manual/invite scopes retain existing rules.
 * NULL scopes remain the filter's dedicated local-default branch.
 */
export function resolveVisibleScopeIds(
	db: Database,
	deviceId: string,
	options: ScopeVisibilityOptions = {},
): string[] {
	const visible = new Set<string>(["", LOCAL_DEFAULT_SCOPE_ID, LEGACY_SHARED_REVIEW_SCOPE_ID]);
	const localScopes = db
		.prepare(
			`SELECT scope_id
			 FROM replication_scopes
			 WHERE status = 'active' AND authority_type = 'local'`,
		)
		.all() as Array<{ scope_id: string | null }>;
	for (const row of localScopes) {
		if (row.scope_id != null) visible.add(row.scope_id);
	}
	const memberScopes = db
		.prepare(
			`SELECT sm.scope_id AS scope_id, rs.authority_type
			 FROM scope_memberships sm
			 JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
			 WHERE sm.device_id = ?
			   AND sm.status = 'active'
			   AND rs.status = 'active'
			   AND sm.membership_epoch >= rs.membership_epoch`,
		)
		.all(deviceId) as Array<{ scope_id: string | null; authority_type: string }>;
	const expectedPublicKey = resolveVisibilityPublicKey(memberScopes, options);
	for (const row of memberScopes) {
		if (row.scope_id == null) continue;
		if (["local", "manual", "invite"].includes(row.authority_type)) {
			visible.add(row.scope_id);
			continue;
		}
		if (row.authority_type !== "coordinator") continue;
		if (!expectedPublicKey?.trim()) continue;
		const authorization = getEffectiveCachedScopeAuthorization(db, {
			deviceId,
			scopeId: row.scope_id,
			expectedPublicKey,
		});
		if (!authorization.authorized) continue;
		visible.add(row.scope_id);
	}
	return [...visible];
}
