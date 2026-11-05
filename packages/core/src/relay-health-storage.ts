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
	options: D1RelayHealthPublisherOptions = {},
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
					const realm = [revision, value.state, value.observedAtMs, namespace.authorityId];
					const aggregate = options.authority?.(value) ?? value;
					const authority = [
						revision,
						aggregate.state,
						aggregate.observedAtMs,
						namespace.authorityId,
					];
					// The fixed captured revision deliberately reaches the existing BEFORE
					// UPDATE trigger on a race. A stale WHERE would silently update zero rows.
					if (
						db.prepare(AUTHORITY).run(...authority).changes !== 1 ||
						db.prepare(REALM).run(...realm, namespace.groupId).changes !== 1
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

const SEVERITY: Readonly<Record<RelayHealthPublication["state"], number>> = {
	ready: 0,
	paused: 1,
	tripped: 2,
};

/**
 * The authority value for several realms: the least severe realm state, and among
 * equals the freshest observation. Ready when at least one realm is ready, with that
 * realm's observation time. Admission still requires the checked realm's own row
 * to be ready and fresh, so this never admits a realm that is not.
 */
export function aggregateRelayHealthAuthority(
	realms: readonly RelayHealthPublication[],
): RelayHealthPublication {
	let best: RelayHealthPublication = { state: "tripped", observedAtMs: null };
	for (const realm of realms) {
		const severity = SEVERITY[realm.state] - SEVERITY[best.state];
		const fresher = (realm.observedAtMs ?? -1) > (best.observedAtMs ?? -1);
		if (severity < 0 || (severity === 0 && fresher))
			best = { state: realm.state, observedAtMs: realm.observedAtMs };
	}
	return best;
}

/** Options for the SQLite and D1 readiness publishers. */
export interface D1RelayHealthPublisherOptions {
	/**
	 * The authority row's value for a realm publication. Defaults to the realm's
	 * own value. An owner of several realms passes an aggregate, so one realm's
	 * state does not decide admission for the others. Every realm update still
	 * bumps the authority revision, as the readiness triggers require.
	 */
	readonly authority?: (realm: RelayHealthPublication) => RelayHealthPublication;
}

export function d1RelayHealthPublisher(
	db: D1DatabaseLike,
	namespace: RelayHealthNamespace,
	options: D1RelayHealthPublisherOptions = {},
): RelayHealthPublisher {
	namespace = Object.freeze({ ...namespace });
	return async (value) => {
		try {
			if (!db.batch) return null;
			const rows = (await db.prepare(READ).bind(namespace.authorityId, namespace.groupId).all())
				.results;
			if (!rows) return null;
			const revision = captureRevision(rows, namespace.groupId);
			const authority = options.authority?.(value) ?? value;
			const receipts = await db.batch([
				db
					.prepare(AUTHORITY)
					.bind(revision, authority.state, authority.observedAtMs, namespace.authorityId),
				db
					.prepare(REALM)
					.bind(
						revision,
						value.state,
						value.observedAtMs,
						namespace.authorityId,
						namespace.groupId,
					),
			]);
			if (receipts.length !== 2 || !receipts.every(changedOnce)) return null;
			return revision;
		} catch {
			return null;
		}
	};
}

const AUTHORITY_ROW = `INSERT INTO relay_admission_readiness
 (authority_id, scope, group_id, revision, state, observed_at_ms)
 SELECT ?1, 'authority', '', 1, 'tripped', NULL
 WHERE EXISTS (SELECT 1 FROM relay_admission_authority_policy WHERE authority_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM relay_admission_readiness
   WHERE authority_id = ?1 AND scope = 'authority' AND group_id = '')`;
// A new realm row takes the current authority revision, as the insert trigger requires.
const REALM_ROW = `INSERT INTO relay_admission_readiness
 (authority_id, scope, group_id, revision, state, observed_at_ms)
 SELECT ?1, 'realm', ?2, ha.revision, 'tripped', NULL FROM relay_admission_readiness ha
 WHERE ha.authority_id = ?1 AND ha.scope = 'authority' AND ha.group_id = ''
  AND EXISTS (SELECT 1 FROM relay_admission_realms WHERE authority_id = ?1 AND group_id = ?2)
  AND NOT EXISTS (SELECT 1 FROM relay_admission_readiness
   WHERE authority_id = ?1 AND scope = 'realm' AND group_id = ?2)`;

/**
 * Inserts the tripped startup readiness rows a D1 publisher updates, for every
 * group whose realm row exists. Existing rows are never changed, and a missing
 * policy or realm row inserts nothing, so a later call can finish the job. Run it
 * only from the publication owner, because it reads the authority revision.
 */
export async function ensureD1RelayHealthRows(
	db: D1DatabaseLike,
	authorityId: string,
	groupIds: readonly string[],
): Promise<boolean> {
	try {
		if (!db.batch) return false;
		await db.batch([
			db.prepare(AUTHORITY_ROW).bind(authorityId),
			...groupIds.map((groupId) => db.prepare(REALM_ROW).bind(authorityId, groupId)),
		]);
		return true;
	} catch {
		return false;
	}
}
