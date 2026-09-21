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
	CREATE INDEX IF NOT EXISTS idx_memory_retirement_deliveries_pending
		ON memory_retirement_deliveries(peer_device_id, source_device_id, acknowledged_at, control_id);
	CREATE TABLE IF NOT EXISTS memory_retirement_peer_trust (
		local_device_id TEXT NOT NULL,
		peer_device_id TEXT NOT NULL,
		public_key TEXT NOT NULL,
		pinned_fingerprint TEXT NOT NULL,
		PRIMARY KEY (local_device_id, peer_device_id)
	);
	CREATE TABLE IF NOT EXISTS memory_retirement_receipts (
		control_id TEXT PRIMARY KEY,
		source_device_id TEXT NOT NULL,
		received_at TEXT NOT NULL
	);`);
}
