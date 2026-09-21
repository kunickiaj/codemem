import type { Database } from "./db.js";

export function ensureMemoryRetirementDeliverySchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS memory_retirement_deliveries (
		control_id TEXT NOT NULL,
		peer_device_id TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		source_device_id TEXT NOT NULL,
		retired_scope_id TEXT NOT NULL,
		acknowledged_at TEXT,
		PRIMARY KEY (control_id, peer_device_id)
	);
	CREATE TABLE IF NOT EXISTS memory_retirement_receipts (
		control_id TEXT PRIMARY KEY,
		source_device_id TEXT NOT NULL,
		received_at TEXT NOT NULL
	);`);
}
