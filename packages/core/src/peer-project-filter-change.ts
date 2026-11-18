import {
	type CoordinatorSyncConfig,
	readCoordinatorSyncConfig,
} from "./coordinator-sync-config.js";
import type { Database } from "./db.js";
import { getCodememConfigPath, readCodememConfigFileForMutation } from "./observer-config.js";
import {
	type PeerProjectFilters,
	peerProjectFiltersOnlyNarrow,
} from "./project-filters-narrowing.js";
import { setPeerProjectFilter } from "./sync-discovery.js";
import { effectiveSyncProjectFilters } from "./sync-replication.js";

export {
	type PeerProjectFilters,
	peerProjectFiltersOnlyNarrow,
} from "./project-filters-narrowing.js";

/*
 * A pairing's Project filters decide which of this device's Projects that
 * pairing receives. Changing them so that more is sent changes another device's
 * access, which only an administrator's device may do (ADR 0007 Decision 4).
 * Sending less is a device withdrawing its own data, which any device may do.
 */

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
 * Uses the runtime's configuration, which also supplies inherited filters.
 * Selecting an alternate CLI file must not supply authority over this store.
 * Damaged or unreadable configuration supplies no authority.
 */
export function readPeerProjectFilterAuthority(
	readConfig: typeof readCoordinatorSyncConfig = readCoordinatorSyncConfig,
): boolean {
	try {
		const outcome = readCodememConfigFileForMutation(getCodememConfigPath());
		if (outcome.status !== "valid" && outcome.status !== "missing") return false;
		return deviceMayWidenPeerProjectFilters(
			readConfig(outcome.status === "valid" ? outcome.data : {}),
		);
	} catch {
		return false;
	}
}

function runtimeFilterConfigReadable(): boolean {
	try {
		const outcome = readCodememConfigFileForMutation(getCodememConfigPath());
		return outcome.status === "valid" || outcome.status === "missing";
	} catch {
		return false;
	}
}

/**
 * Whether replacement lists would exceed a removed pairing's retained filters,
 * or the shared defaults when none were retained. NULL lists restore retained
 * restrictions through the insert trigger, or inherit the shared defaults.
 */
export function newPairingFiltersNeedAdmin(
	db: Database,
	own: {
		peerDeviceId: string;
		include: string[] | null;
		exclude: string[] | null;
		mayWiden: boolean;
	},
): boolean {
	if (!runtimeFilterConfigReadable()) return true;
	if (own.mayWiden || (own.include === null && own.exclude === null)) return false;
	return !peerProjectFiltersOnlyNarrow(effectiveSyncProjectFilters(db, own.peerDeviceId), {
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
	if (!runtimeFilterConfigReadable()) return false;
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
			if (!runtimeFilterConfigReadable()) return "needs_admin_device";
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
