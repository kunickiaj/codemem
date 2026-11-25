import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";

export interface CoordinatorListDeviceRemovalsInput {
	beforeSeq?: number;
	deviceId?: string;
	includeBlocked?: boolean;
	/** Defaults to 500 and is capped at 500, including with a device filter. */
	limit?: number;
}
export interface CoordinatorDeviceRemovalListItem {
	readonly removal_id: string;
	readonly removal_seq: number;
	readonly group_id: string;
	readonly device_id: string;
	readonly fingerprint: string;
	readonly key_id: string | null;
	readonly display_name: string | null;
	readonly identity_id: string | null;
	readonly removed_at: string;
	readonly revoked?: true;
}
export interface CoordinatorDeviceRemovalListResult {
	items: CoordinatorDeviceRemovalListItem[];
	next_before_seq: number | null;
}

export function captureRemovalList(raw: CoordinatorListDeviceRemovalsInput) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_input");
	const { beforeSeq, deviceId, includeBlocked, limit } = raw;
	if (
		(beforeSeq !== undefined && !Number.isSafeInteger(beforeSeq)) ||
		(deviceId !== undefined && !isAuthControllerId(deviceId)) ||
		(includeBlocked !== undefined && typeof includeBlocked !== "boolean") ||
		(limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
	)
		throw new Error("invalid_input");
	return {
		beforeSeq,
		deviceId,
		includeBlocked: includeBlocked ?? false,
		limit: Math.min(limit ?? 500, 500),
	};
}
type Options = ReturnType<typeof captureRemovalList>;

// Exactly the admission ledger's global ID/canonical-key rule. Null opaque key
// IDs match no key subject, while an ID subject still blocks an opaque device.
const BLOCKED_SQL = DEVICE_REVOCATION_SUBJECT_EXISTS_SQL.replace("?", "t.device_id").replace(
	"?",
	"t.key_id",
);

export function removalListStatement(options: Options) {
	const where = ["t.lifted_at IS NULL"];
	const values: (string | number)[] = [];
	if (options.beforeSeq !== undefined) {
		where.push("t.removal_seq < ?");
		values.push(options.beforeSeq);
	}
	if (options.deviceId !== undefined) {
		where.push("t.device_id = ?");
		values.push(options.deviceId);
	}
	if (!options.includeBlocked) where.push(`NOT (${BLOCKED_SQL})`);
	values.push(options.limit + 1);
	return {
		sql: `SELECT t.removal_id, t.removal_seq, t.group_id, t.device_id, t.fingerprint,
t.key_id, t.display_name, t.identity_id, t.removed_at, (${BLOCKED_SQL}) AS revoked
FROM coordinator_device_removals t WHERE ${where.join(" AND ")}
ORDER BY t.removal_seq DESC LIMIT ?`,
		values,
		read: true,
	};
}

type ListRow = Omit<CoordinatorDeviceRemovalListItem, "revoked"> & { revoked: number };
function validRow(row: unknown): row is ListRow {
	if (!row || typeof row !== "object") return false;
	const value = row as Record<string, unknown>;
	return (
		["removal_id", "group_id", "device_id", "fingerprint", "removed_at"].every(
			(field) => typeof value[field] === "string",
		) &&
		["key_id", "display_name", "identity_id"].every(
			(field) => value[field] === null || typeof value[field] === "string",
		) &&
		Number.isSafeInteger(value.removal_seq) &&
		(value.removal_seq as number) > 0 &&
		(value.revoked === 0 || value.revoked === 1)
	);
}

/** Pick only public listing fields, even if a backend returns extra columns. */
function listingItem(row: ListRow): CoordinatorDeviceRemovalListItem {
	const {
		removal_id,
		removal_seq,
		group_id,
		device_id,
		fingerprint,
		key_id,
		display_name,
		identity_id,
		removed_at,
	} = row;
	const item = {
		removal_id,
		removal_seq,
		group_id,
		device_id,
		fingerprint,
		key_id,
		display_name,
		identity_id,
		removed_at,
	};
	if (row.revoked === 1) return { ...item, revoked: true };
	return item;
}

/** Validate the public page and project only the documented tombstone fields. */
export function parseDeviceRemovalListPage(
	payload: Record<string, unknown> | null,
	beforeSeq?: number,
	options: { includeBlocked?: boolean } = {},
): CoordinatorDeviceRemovalListResult {
	const invalid = () => new Error("coordinator_removal_list_malformed");
	if (payload?.version !== 1 || !Array.isArray(payload.items) || payload.items.length > 500)
		throw invalid();
	let previous = beforeSeq ?? Infinity;
	const items = payload.items.map((item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
		const blocked = "revoked" in item;
		if (blocked && (!options.includeBlocked || item.revoked !== true)) throw invalid();
		const row = { ...item, revoked: blocked ? 1 : 0 };
		if (!validRow(row) || row.removal_seq >= previous) throw invalid();
		previous = row.removal_seq;
		return listingItem(row);
	});
	const next = payload.next_before_seq;
	if (next !== null && (typeof next !== "number" || next !== items.at(-1)?.removal_seq))
		throw invalid();
	return { items, next_before_seq: next };
}

export function removalListPage(
	rows: unknown[],
	options: Options,
): CoordinatorDeviceRemovalListResult {
	if (rows.length > options.limit + 1) throw new Error("device_removal_incomplete");
	let previous = options.beforeSeq ?? Infinity;
	for (const row of rows) {
		if (
			!validRow(row) ||
			row.removal_seq >= previous ||
			(options.deviceId !== undefined && row.device_id !== options.deviceId) ||
			(!options.includeBlocked && row.revoked !== 0)
		)
			throw new Error("device_removal_incomplete");
		previous = row.removal_seq;
	}
	const items = (rows as ListRow[]).slice(0, options.limit).map(listingItem);
	let next: number | null = null;
	if (rows.length > options.limit) next = items.at(-1)?.removal_seq ?? null;
	return { items, next_before_seq: next };
}
