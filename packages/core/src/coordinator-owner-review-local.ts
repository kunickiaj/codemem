import Database from "better-sqlite3";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export interface CoordinatorOwnerReviewLocalOptions {
	dbPath: string;
	actorId?: string;
	deviceIdOverride?: string;
	identitySource?: "env" | "config";
}
export interface CoordinatorOwnerReviewLocalEvidence {
	state: "ready" | "needs_review";
	reasons: string[];
	device: { deviceId: string; publicKey: string; fingerprint: string; label?: string } | null;
	identity: {
		identityId: string;
		label?: string;
		source: "env" | "config" | "device_fallback";
	} | null;
	memoryCounts: { current: number | null; others: number | null; unknown: number | null };
	teamCount: number | null;
	projectCount: number | null;
	ownershipRecords: { actorPresent: boolean; deviceAssignmentPresent: boolean };
}
type Row = Record<string, unknown>;
type OwnershipRecord = { present: boolean; label?: string };
function hasColumns(db: Database.Database, table: string, required: string[]): boolean {
	const exists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
	if (!exists) return false;
	const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as {
		name: string;
	}[];
	return required.every((column) => columns.some((row) => row.name === column));
}
function label(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return (
		value
			.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
			.trim()
			.slice(0, 120) || undefined
	);
}
function readDevice(
	db: Database.Database,
): NonNullable<CoordinatorOwnerReviewLocalEvidence["device"]> | null {
	if (!hasColumns(db, "sync_device", ["device_id", "public_key", "fingerprint"])) return null;
	const rows = db
		.prepare("SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 2")
		.all() as Row[];
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
function checkActor(db: Database.Database, identityId: string, reasons: string[]): OwnershipRecord {
	if (!hasColumns(db, "actors", ["actor_id", "is_local", "status", "merged_into_actor_id"])) {
		reasons.push("actor_evidence_unavailable");
		return { present: false };
	}
	const row = db.prepare("SELECT * FROM actors WHERE actor_id = ?").get(identityId) as
		| Row
		| undefined;
	const others = db
		.prepare(
			"SELECT 1 FROM actors WHERE actor_id != ? AND is_local = 1 AND status = 'active' AND merged_into_actor_id IS NULL LIMIT 1",
		)
		.get(identityId);
	if (others) reasons.push("local_actor_ambiguous");
	if (row && (row.is_local !== 1 || row.status !== "active" || row.merged_into_actor_id !== null))
		reasons.push("current_actor_unavailable");
	return { present: row !== undefined, label: label(row?.display_name) };
}
function checkDeviceAssignment(
	db: Database.Database,
	deviceId: string,
	identityId: string,
	reasons: string[],
): OwnershipRecord {
	if (!hasColumns(db, "identity_devices", ["device_id", "identity_id", "status"])) {
		reasons.push("device_assignment_unavailable");
		return { present: false };
	}
	const row = db.prepare("SELECT * FROM identity_devices WHERE device_id = ?").get(deviceId) as
		| Row
		| undefined;
	if (row && (row.status !== "active" || row.identity_id !== identityId))
		reasons.push("device_identity_conflict");
	return { present: row !== undefined, label: label(row?.display_name) };
}
function memoryCounts(
	db: Database.Database,
	identityId: string,
): CoordinatorOwnerReviewLocalEvidence["memoryCounts"] {
	if (!hasColumns(db, "memory_items", ["actor_id"]))
		return { current: null, others: null, unknown: null };
	// Authorship only, never origin_device_id, and never an ownership migration.
	return db
		.prepare(`SELECT
		COUNT(CASE WHEN actor_id = ? THEN 1 END) AS current,
		COUNT(CASE WHEN actor_id IS NOT NULL AND trim(actor_id) != '' AND actor_id != ? THEN 1 END) AS others,
		COUNT(CASE WHEN actor_id IS NULL OR trim(actor_id) = '' THEN 1 END) AS unknown
		FROM memory_items`)
		.get(identityId, identityId) as CoordinatorOwnerReviewLocalEvidence["memoryCounts"];
}
function accessCounts(db: Database.Database, identityId: string) {
	let teamCount: number | null = null;
	let projectCount: number | null = null;
	if (hasColumns(db, "policy_team_memberships", ["identity_id", "status"])) {
		teamCount = (
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM policy_team_memberships WHERE identity_id = ? AND status = 'active'",
				)
				.get(identityId) as { count: number }
		).count;
	}
	if (hasColumns(db, "project_recipients", ["recipient_kind", "recipient_id", "status"])) {
		projectCount = (
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM project_recipients WHERE recipient_kind = 'identity' AND recipient_id = ? AND status = 'active'",
				)
				.get(identityId) as { count: number }
		).count;
	}
	return { teamCount, projectCount };
}
function readEvidence(
	db: Database.Database,
	options: CoordinatorOwnerReviewLocalOptions,
): CoordinatorOwnerReviewLocalEvidence {
	const device = readDevice(db);
	const empty: CoordinatorOwnerReviewLocalEvidence = {
		state: "needs_review",
		reasons: ["device_unavailable"],
		device: null,
		identity: null,
		memoryCounts: { current: null, others: null, unknown: null },
		teamCount: null,
		projectCount: null,
		ownershipRecords: { actorPresent: false, deviceAssignmentPresent: false },
	};
	if (!device) return empty;
	const actorId = options.actorId?.trim();
	const identityId = actorId || `local:${device.deviceId}`;
	if (!isAuthControllerId(identityId)) return { ...empty, device, reasons: ["identity_invalid"] };
	const reasons: string[] = [];
	const override = options.deviceIdOverride?.trim();
	if (override && override !== device.deviceId) reasons.push("device_override_mismatch");
	const actor = checkActor(db, identityId, reasons);
	const assignment = checkDeviceAssignment(db, device.deviceId, identityId, reasons);
	return {
		state: reasons.length ? "needs_review" : "ready",
		reasons,
		device: { ...device, label: assignment.label },
		identity: {
			identityId,
			label: actor.label,
			source: actorId ? (options.identitySource ?? "config") : "device_fallback",
		},
		memoryCounts: memoryCounts(db, identityId),
		ownershipRecords: { actorPresent: actor.present, deviceAssignmentPresent: assignment.present },
		...accessCounts(db, identityId),
	};
}
/** A read-only snapshot. No MemoryStore, schema initialization, or private-key access. */
export function readCoordinatorOwnerReviewLocalEvidence(
	options: CoordinatorOwnerReviewLocalOptions,
): CoordinatorOwnerReviewLocalEvidence {
	if (!options.dbPath || options.dbPath === ":memory:")
		throw new Error("owner_review_local_unavailable");
	const db = new Database(options.dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
	try {
		return db.transaction(() => readEvidence(db, options))();
	} finally {
		db.close();
	}
}
