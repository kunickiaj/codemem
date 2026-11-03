import type { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import type { D1DatabaseLike } from "./d1-coordinator-store.js";

export interface RelayHealthPublication {
	readonly state: "ready" | "paused" | "tripped";
	readonly observedAtMs: number | null;
}
export type RelayHealthPublisher = (value: RelayHealthPublication) => Promise<number | null>;
export interface RelayHealthNamespace {
	readonly authorityId: string;
	readonly groupId: string;
}
const READ = `SELECT scope, group_id, revision FROM relay_admission_readiness
 WHERE authority_id = ? AND (scope = 'authority' OR (scope = 'realm' AND group_id = ?))`;
const AUTHORITY = `UPDATE relay_admission_readiness SET revision = ?, state = ?, observed_at_ms = ?
 WHERE authority_id = ? AND scope = 'authority' AND group_id = ''`;
const REALM = `UPDATE relay_admission_readiness SET revision = ?, state = ?, observed_at_ms = ?
 WHERE authority_id = ? AND scope = 'realm' AND group_id = ?`;

function captureRevision(rows: unknown[], groupId: string): number {
	if (rows.length !== 2) throw new Error("relay_health_metadata_missing");
	const records = rows as { scope: string; group_id: string; revision: number }[];
	const authority = records.find((row) => row.scope === "authority" && row.group_id === "");
	const realm = records.find((row) => row.scope === "realm" && row.group_id === groupId);
	if (
		!authority ||
		!realm ||
		!Number.isSafeInteger(authority.revision) ||
		authority.revision < 1 ||
		authority.revision >= Number.MAX_SAFE_INTEGER ||
		!Number.isSafeInteger(realm.revision) ||
		realm.revision < 1 ||
		realm.revision > authority.revision
	)
		throw new Error("relay_health_metadata_invalid");
	return authority.revision + 1;
}

export function sqliteRelayHealthPublisher(
	open: () => Pick<BetterSqliteCoordinatorStore, "db" | "close">,
	namespace: RelayHealthNamespace,
): RelayHealthPublisher {
	namespace = Object.freeze({ ...namespace });
	return async (value) => {
		let store: ReturnType<typeof open> | undefined;
		try {
			store = open();
			const db = store.db;
			db.pragma("busy_timeout = 0");
			return db
				.transaction(() => {
					const revision = captureRevision(
						db.prepare(READ).all(namespace.authorityId, namespace.groupId),
						namespace.groupId,
					);
					const values = [revision, value.state, value.observedAtMs, namespace.authorityId];
					// The fixed captured revision deliberately reaches the existing BEFORE
					// UPDATE trigger on a race. A stale WHERE would silently update zero rows.
					if (
						db.prepare(AUTHORITY).run(...values).changes !== 1 ||
						db.prepare(REALM).run(...values, namespace.groupId).changes !== 1
					)
						throw new Error("relay_health_receipt_invalid");
					return revision;
				})
				.immediate();
		} catch {
			return null;
		} finally {
			store?.close();
		}
	};
}

function changedOnce(raw: unknown): boolean {
	if (!raw || typeof raw !== "object") return false;
	const result = raw as { success?: unknown; meta?: { changes?: unknown } };
	return result.success === true && result.meta?.changes === 1;
}

export function d1RelayHealthPublisher(
	db: D1DatabaseLike,
	namespace: RelayHealthNamespace,
): RelayHealthPublisher {
	namespace = Object.freeze({ ...namespace });
	return async (value) => {
		try {
			if (!db.batch) return null;
			const rows = (await db.prepare(READ).bind(namespace.authorityId, namespace.groupId).all())
				.results;
			if (!rows) return null;
			const revision = captureRevision(rows, namespace.groupId);
			const values = [revision, value.state, value.observedAtMs, namespace.authorityId];
			const receipts = await db.batch([
				db.prepare(AUTHORITY).bind(...values),
				db.prepare(REALM).bind(...values, namespace.groupId),
			]);
			if (receipts.length !== 2 || !receipts.every(changedOnce)) return null;
			return revision;
		} catch {
			return null;
		}
	};
}
