import type { Database } from "./db.js";
import type { RecipientPolicyDenyOverlayRecord } from "./recipient-policy-reconciliation.js";

export function denyOverlayRow(row: Record<string, unknown>): RecipientPolicyDenyOverlayRecord {
	return {
		canonicalProjectIdentity: String(row.canonical_project_identity),
		scopeId: String(row.scope_id),
		deviceId: String(row.device_id),
		generation: Number(row.generation),
		reasonCode: String(row.reason_code),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

/** Any deny for the pair applies, including ambiguous legacy project overlays. */
export function getAnyRecipientPolicyDenyOverlayForScopeDevice(
	db: Database,
	input: { scopeId: string; deviceId: string },
): RecipientPolicyDenyOverlayRecord | null {
	const row = db
		.prepare(
			`SELECT * FROM recipient_policy_deny_overlays
			 WHERE scope_id = ? AND device_id = ?
			 ORDER BY canonical_project_identity
			 LIMIT 1`,
		)
		.get(input.scopeId, input.deviceId) as Record<string, unknown> | undefined;
	return row ? denyOverlayRow(row) : null;
}
