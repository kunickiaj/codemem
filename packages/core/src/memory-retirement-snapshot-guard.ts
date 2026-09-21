import type { Database } from "./db.js";
import { hasMemoryScopeRetirement, isMemoryScopeRetired } from "./memory-scope-retirement.js";

/** Snapshot payloads have no op envelope: history requires their own explicit scope. */
export function retirementAllowsSnapshot(
	db: Database,
	entityId: string,
	payload: Record<string, unknown>,
	envelopeScope: string | null,
): boolean {
	const canonicalId = entityId.trim();
	if (!hasMemoryScopeRetirement(db, canonicalId)) return true;
	if (entityId !== canonicalId) return false;
	const scope = typeof payload.scope_id === "string" ? payload.scope_id.trim() : "";
	if (!scope || scope !== envelopeScope || isMemoryScopeRetired(db, entityId, scope)) return false;
	const metadata = payload.metadata_json;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return true;
	const metadataScope = (metadata as Record<string, unknown>).scope_id;
	return (
		metadataScope == null || (typeof metadataScope === "string" && metadataScope.trim() === scope)
	);
}
