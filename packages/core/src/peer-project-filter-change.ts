import { lstatSync } from "node:fs";
import { isCoordinatorAdminDevice, readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import type { Database } from "./db.js";
import { getCodememConfigPath, readCodememConfigFileForMutation } from "./observer-config.js";
import { hasPeerProjectFilterManagement } from "./peer-project-filter-management.js";
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
 * Uses the runtime's configuration, which also supplies inherited filters.
 * Selecting an alternate CLI file must not supply authority over this store.
 * Clearing the URL does not make a previously managed store standalone.
 */
function readRuntimeFilterConfig(): Record<string, unknown> | null {
	try {
		const outcome = readCodememConfigFileForMutation(getCodememConfigPath());
		if (outcome.status === "valid") return outcome.data;
		if (outcome.status !== "missing") return null;
		// A failed existence check can also mean a broken link or inaccessible path.
		lstatSync(outcome.path);
		return null;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		return code === "ENOENT" ? {} : null;
	}
}

function mayWidenWithConfig(
	db: Database,
	raw: Record<string, unknown>,
	readConfig = readCoordinatorSyncConfig,
): boolean {
	try {
		const config = readConfig(raw);
		if (config.syncCoordinatorUrl) return isCoordinatorAdminDevice(config);
		return !hasPeerProjectFilterManagement(db);
	} catch {
		return false;
	}
}

export function readPeerProjectFilterAuthority(db: Database): boolean {
	const config = readRuntimeFilterConfig();
	return config !== null && mayWidenWithConfig(db, config);
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
	},
): boolean {
	const config = readRuntimeFilterConfig();
	if (!config) return true;
	if (own.include === null && own.exclude === null) return false;
	if (mayWidenWithConfig(db, config)) return false;
	return !peerProjectFiltersOnlyNarrow(effectiveSyncProjectFilters(db, own.peerDeviceId, config), {
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
	readConfig?: typeof readCoordinatorSyncConfig;
}

export type SetPeerProjectFilterResult = "saved" | "needs_admin_device";

/** The filters in effect once `lists` is stored: the lists given, or the shared ones. */
function filtersAfter(
	db: Database,
	lists: PeerProjectFilterLists,
	config: Record<string, unknown>,
): PeerProjectFilters {
	if (lists.include === null && lists.exclude === null) {
		return effectiveSyncProjectFilters(db, null, config);
	}
	return { include: lists.include ?? [], exclude: lists.exclude ?? [] };
}

function onlyNarrowsWithConfig(
	db: Database,
	peerDeviceId: string,
	lists: PeerProjectFilterLists,
	config: Record<string, unknown>,
): boolean {
	return peerProjectFiltersOnlyNarrow(
		effectiveSyncProjectFilters(db, peerDeviceId, config),
		filtersAfter(db, lists, config),
	);
}

/** Whether storing `lists` for a pairing sends it nothing that its filters in effect hold back. */
export function peerProjectFilterChangeOnlyNarrows(
	db: Database,
	peerDeviceId: string,
	lists: PeerProjectFilterLists,
): boolean {
	const config = readRuntimeFilterConfig();
	return config !== null && onlyNarrowsWithConfig(db, peerDeviceId, lists, config);
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
			const config = readRuntimeFilterConfig();
			if (!config) return "needs_admin_device";
			const mayWiden = mayWidenWithConfig(db, config, options.readConfig);
			if (!mayWiden && !onlyNarrowsWithConfig(db, peerDeviceId, options, config)) {
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
