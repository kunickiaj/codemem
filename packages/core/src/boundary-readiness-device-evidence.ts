import { readBoundaryFilterEvidence } from "./boundary-filter-evidence.js";
import { buildBoundaryReadinessInventory } from "./boundary-readiness-inventory.js";
import { readBoundaryMigrationMode, readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { connectReadOnly, type Database } from "./db.js";
import { getCodememConfigPath, readCodememConfigFileForMutation } from "./observer-config.js";
import { buildBaseUrl } from "./sync-http-client.js";

export interface GroupReadinessRequest {
	/** The authority and generation received from the coordinator, never a peer. */
	coordinatorUrl: string;
	groupId: string;
	groupGeneration: string;
	/** Revision observed by the caller's successful group refresh for this generation. */
	refreshRevision: number;
	sequence: number;
	dbPath: string;
	configPath?: string;
	keysDir?: string;
}

function reportConfig(path?: string) {
	const config = readCodememConfigFileForMutation(path ?? getCodememConfigPath());
	if (config.status === "valid") return config.data;
	if (config.status === "missing" && !path && !process.env.CODEMEM_CONFIG) return {};
	throw new Error("readiness_config_unavailable");
}

function localIdentity(db: Database) {
	const rows = db.prepare("SELECT device_id, public_key FROM sync_device LIMIT 2").all() as {
		device_id: string;
		public_key: string;
	}[];
	const identity = rows[0];
	if (rows.length !== 1 || !identity?.device_id?.trim() || !identity.public_key?.trim())
		return null;
	return identity;
}

type GroupRefresh = Pick<
	GroupReadinessRequest,
	"coordinatorUrl" | "groupId" | "refreshRevision" | "groupGeneration"
>;

function matchingGeneration(db: Database, refresh: GroupRefresh) {
	// A newly configured or never-refreshed group can look like a group with
	// zero Projects. Only an inventory built after a successful refresh counts.
	return db
		.prepare(`SELECT observed_group_generation FROM scope_membership_cache_state WHERE coordinator_id = ?
		AND group_id = ? AND refresh_revision = ? AND observed_group_generation = ? AND last_success_at = last_refresh_at
		AND length(last_success_at) > 0 AND last_error IS NULL`)
		.pluck()
		.get(refresh.coordinatorUrl, refresh.groupId, refresh.refreshRevision, refresh.groupGeneration);
}

export function isCurrentGroupRefresh(dbPath: string, refresh: GroupRefresh): boolean {
	const db = connectReadOnly(dbPath);
	try {
		return typeof matchingGeneration(db, refresh) === "string";
	} finally {
		db.close();
	}
}

function snapshot(db: Database, config: Record<string, unknown>, refresh: GroupRefresh) {
	const identity = localIdentity(db);
	if (!identity) return null;
	const cache = matchingGeneration(db, refresh);
	if (typeof cache !== "string") return null;
	const inventory = buildBoundaryReadinessInventory(db, {
		coordinatorId: refresh.coordinatorUrl,
		groupId: refresh.groupId,
		deviceId: identity.device_id,
	});
	return {
		...inventory,
		groupGeneration: cache,
		deviceId: identity.device_id,
		publicKey: identity.public_key,
		filterEvidence: readBoundaryFilterEvidence(db, config),
	};
}

/** Does not initialize a store, a key, or a membership. An unavailable inventory
 * must never be signed as an empty one, including for a receive-only device. */
export function collectGroupReadiness(input: GroupReadinessRequest) {
	const config = reportConfig(input.configPath);
	const settings = readCoordinatorSyncConfig(config);
	const coordinatorUrl = buildBaseUrl(settings.syncCoordinatorUrl);
	if (
		readBoundaryMigrationMode(config) !== "on" ||
		!settings.syncEnabled ||
		!coordinatorUrl ||
		coordinatorUrl !== input.coordinatorUrl ||
		!settings.syncCoordinatorGroups.includes(input.groupId)
	)
		return null;
	const db = connectReadOnly(input.dbPath);
	try {
		const evidence = db.transaction(() => snapshot(db, config, input)).deferred();
		if (!evidence) return null;
		return {
			...evidence,
			coordinatorUrl,
			groupId: input.groupId,
			refreshRevision: input.refreshRevision,
			sequence: input.sequence,
			dbPath: input.dbPath,
			keysDir: input.keysDir,
			timeoutS: settings.syncCoordinatorTimeoutS,
		};
	} finally {
		db.close();
	}
}
