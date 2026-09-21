import type { Database } from "./db.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { ensureMemoryScopeRetirementSchema } from "./memory-scope-retirement.js";
import { ensureMemorySourceIdentitySchema } from "./memory-source-identity.js";

export function ensureMemoryOwnershipSchemas(db: Database): void {
	ensureMemorySourceIdentitySchema(db);
	ensureMemoryScopeRetirementSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	db.exec(`CREATE TABLE IF NOT EXISTS memory_ownership_recoveries (
		operation_id TEXT PRIMARY KEY,
		actor_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		request_json TEXT NOT NULL,
		reviewed_digest TEXT NOT NULL,
		result_json TEXT NOT NULL,
		created_at TEXT NOT NULL
	);`);
}
