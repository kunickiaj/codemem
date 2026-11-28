import type Database from "better-sqlite3";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { columnExists } from "./schema-lookups.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export interface CoordinatorDeviceLocalEvidence {
	readonly deviceId: string;
	readonly publicKey: string;
	readonly fingerprint: string;
}

function hasDeviceColumns(db: Database.Database): boolean {
	return ["device_id", "public_key", "fingerprint"].every((column) =>
		columnExists(db, "sync_device", column),
	);
}

/** Read public evidence only; connection lifetime and snapshot belong to the caller. */
export function readCoordinatorDeviceLocalEvidence(
	db: Database.Database,
): CoordinatorDeviceLocalEvidence | null {
	if (!hasDeviceColumns(db)) return null;
	const rows = db
		.prepare("SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 2")
		.all() as Record<string, unknown>[];
	const row = rows[0];
	if (
		rows.length !== 1 ||
		!row ||
		!isAuthControllerId(row.device_id) ||
		typeof row.public_key !== "string" ||
		!row.public_key.startsWith("ssh-ed25519 ") ||
		typeof row.fingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(row.fingerprint) ||
		fingerprintPublicKey(row.public_key) !== row.fingerprint
	)
		return null;
	return { deviceId: row.device_id, publicKey: row.public_key, fingerprint: row.fingerprint };
}
