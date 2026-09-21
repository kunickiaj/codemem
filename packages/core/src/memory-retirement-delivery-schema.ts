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
	);
	CREATE TABLE IF NOT EXISTS memory_retirement_reset_receivers (
		reset_id TEXT PRIMARY KEY, source_device_id TEXT NOT NULL, source_public_key TEXT NOT NULL,
		local_device_id TEXT NOT NULL, boundary TEXT NOT NULL, next_offset INTEGER NOT NULL DEFAULT 0,
		complete INTEGER NOT NULL DEFAULT 0, last_page_digest TEXT
	);
	CREATE TABLE IF NOT EXISTS memory_retirement_reset_manifests (
		reset_id TEXT NOT NULL, peer_device_id TEXT NOT NULL, source_device_id TEXT NOT NULL,
		boundary TEXT NOT NULL, controls_json TEXT NOT NULL,
		PRIMARY KEY(reset_id, peer_device_id, source_device_id)
	);`);
}
