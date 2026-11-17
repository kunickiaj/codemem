import { createHash } from "node:crypto";
import { parseSshEd25519PublicKeyForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import type { Database } from "./db.js";

/*
 * Device IDs this device knows were retired. A `device_id` row means the
 * coordinator revoked that ID outright. A `key` row means the coordinator revoked
 * the key this device pinned for that ID, so the ID stays retired only while no
 * pairing under it pins a different key. Keys compare by canonical key ID when
 * both sides parse, because different key text can carry the same key.
 */

export type RetiredAliasKind = "device_id" | "key";

export interface RetiredAlias {
	kind: RetiredAliasKind;
	fingerprint: string;
	keyId: string | null;
}

export interface CurrentPin {
	publicKey: string | null;
	fingerprint: string | null;
}

/**
 * The coordinator's canonical key ID (SHA-256 of the canonical SSH blob), computed
 * synchronously so the inventory can use it. Null for keys that aren't SSH Ed25519.
 */
export function canonicalKeyId(publicKey: string | null): string | null {
	if (!publicKey) return null;
	const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
	if (parsed.kind !== "ed25519") return null;
	return createHash("sha256").update(parsed.blob).digest("hex");
}

export function ensureRetiredDeviceAliasSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS retired_device_aliases (
		device_id TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK(kind IN ('device_id', 'key')),
		fingerprint TEXT NOT NULL,
		key_id TEXT,
		retired_at TEXT NOT NULL
	)`);
}

/** Every recorded alias. Empty before this device retires anything. */
export function listRetiredDeviceAliases(db: Database): Map<string, RetiredAlias> {
	const table = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retired_device_aliases'")
		.get();
	if (!table) return new Map();
	const rows = db
		.prepare("SELECT device_id, kind, fingerprint, key_id FROM retired_device_aliases")
		.all() as Array<{
		device_id: string;
		kind: RetiredAliasKind;
		fingerprint: string;
		key_id: string | null;
	}>;
	return new Map(
		rows.map((row) => [
			row.device_id,
			{ kind: row.kind, fingerprint: row.fingerprint, keyId: row.key_id },
		]),
	);
}

/** Whether an alias still retires its ID, given the key a current pairing under it pins. */
export function retiredAliasApplies(
	alias: RetiredAlias | undefined,
	currentPin: CurrentPin | null,
): boolean {
	if (!alias) return false;
	if (alias.kind === "device_id") return true;
	if (!currentPin || (!currentPin.publicKey && !currentPin.fingerprint)) return true;
	const currentKeyId = canonicalKeyId(currentPin.publicKey);
	if (alias.keyId && currentKeyId) return currentKeyId === alias.keyId;
	return currentPin.fingerprint === alias.fingerprint;
}

export function recordRetiredDeviceAliases(
	db: Database,
	aliases: Array<{
		deviceId: string;
		kind: RetiredAliasKind;
		fingerprint: string;
		keyId: string | null;
	}>,
): void {
	ensureRetiredDeviceAliasSchema(db);
	// An ID revocation outranks a key-only record; otherwise the latest key wins.
	const upsert = db.prepare(
		`INSERT INTO retired_device_aliases(device_id, kind, fingerprint, key_id, retired_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(device_id) DO UPDATE SET
		  kind = CASE WHEN retired_device_aliases.kind = 'device_id' THEN 'device_id' ELSE excluded.kind END,
		  fingerprint = excluded.fingerprint,
		  key_id = excluded.key_id,
		  retired_at = excluded.retired_at`,
	);
	const now = new Date().toISOString();
	for (const alias of aliases)
		upsert.run(alias.deviceId, alias.kind, alias.fingerprint, alias.keyId, now);
}
