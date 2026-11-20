import type { CoordinatorSyncConfig } from "./coordinator-sync-config.js";
import type { Database } from "./db.js";
import { setPeerProjectFilter } from "./sync-discovery.js";
import { effectiveSyncProjectFilters } from "./sync-replication.js";

/*
 * A pairing's Project filters decide which of this device's Projects that
 * pairing receives. Changing them so that more is sent changes another device's
 * access, which only an administrator's device may do (ADR 0007 Decision 4).
 * Sending less is a device withdrawing its own data, which any device may do.
 */

export interface PeerProjectFilters {
	include: string[];
	exclude: string[];
}

/**
 * Whether `next` sends nothing that `current` holds back. It is true when
 * `next` keeps every excluded entry and, where `current` has an include list,
 * `next` has one made only of its entries. That is stricter than necessary: a
 * change that narrows by naming a Project differently is refused too, which
 * errs toward asking an administrator.
 */
export function peerProjectFiltersOnlyNarrow(
	current: PeerProjectFilters,
	next: PeerProjectFilters,
): boolean {
	const excluded = new Set(next.exclude);
	if (!current.exclude.every((entry) => excluded.has(entry))) return false;
	if (current.include.length === 0) return true;
	const included = new Set(current.include);
	return next.include.length > 0 && next.include.every((entry) => included.has(entry));
}

/**
 * Whether this device may make a pairing receive more than it does now. With no
 * coordinator configured, the filters are this device's own choice of what to
 * send, because no administrator's device exists to ask. Once a coordinator is
 * configured, only a device that is set up with its admin secret may widen.
 */
export function deviceMayWidenPeerProjectFilters(
	config: Pick<
		CoordinatorSyncConfig,
		"syncCoordinatorUrl" | "syncCoordinatorGroups" | "syncCoordinatorAdminSecret"
	>,
): boolean {
	if (!config.syncCoordinatorUrl) return true;
	return config.syncCoordinatorGroups.length > 0 && Boolean(config.syncCoordinatorAdminSecret);
}

/**
 * Whether a new pairing may not start with these filters of its own, because
 * they would send it Projects that the shared filters hold back and this device
 * may not widen. A pairing with no filters of its own inherits the shared ones,
 * which is never a change.
 */
export function newPairingFiltersNeedAdmin(
	db: Database,
	own: { include: string[] | null; exclude: string[] | null; mayWiden: boolean },
): boolean {
	if (own.mayWiden || (own.include === null && own.exclude === null)) return false;
	return !peerProjectFiltersOnlyNarrow(effectiveSyncProjectFilters(db, null), {
		include: own.include ?? [],
		exclude: own.exclude ?? [],
	});
}

/** Null for both lists removes the pairing's own filters, so it inherits the shared ones. */
export interface PeerProjectFilterLists {
	include: string[] | null;
	exclude: string[] | null;
}

export interface SetPeerProjectFilterCheckedOptions extends PeerProjectFilterLists {
	/** Whether this device may make a pairing receive more than it does now. */
	mayWiden: boolean;
}

export type SetPeerProjectFilterResult = "saved" | "needs_admin_device";

/** The filters in effect once `lists` is stored: the lists given, or the shared ones. */
function filtersAfter(db: Database, lists: PeerProjectFilterLists): PeerProjectFilters {
	if (lists.include === null && lists.exclude === null) {
		return effectiveSyncProjectFilters(db, null);
	}
	return { include: lists.include ?? [], exclude: lists.exclude ?? [] };
}

/** Whether storing `lists` for a pairing sends it nothing that its filters in effect hold back. */
export function peerProjectFilterChangeOnlyNarrows(
	db: Database,
	peerDeviceId: string,
	lists: PeerProjectFilterLists,
): boolean {
	return peerProjectFiltersOnlyNarrow(
		effectiveSyncProjectFilters(db, peerDeviceId),
		filtersAfter(db, lists),
	);
}

/**
 * Replaces a pairing's Project filters. A device that may not widen is refused
 * when the new filters would send anything the filters in effect hold back.
 * The comparison and the write share one write transaction, so another save
 * cannot land between them.
 */
export function setPeerProjectFilterChecked(
	db: Database,
	peerDeviceId: string,
	options: SetPeerProjectFilterCheckedOptions,
): SetPeerProjectFilterResult {
	return db
		.transaction((): SetPeerProjectFilterResult => {
			if (!options.mayWiden && !peerProjectFilterChangeOnlyNarrows(db, peerDeviceId, options)) {
				return "needs_admin_device";
			}
			setPeerProjectFilter(db, peerDeviceId, {
				include: options.include,
				exclude: options.exclude,
			});
			return "saved";
		})
		.immediate();
}
