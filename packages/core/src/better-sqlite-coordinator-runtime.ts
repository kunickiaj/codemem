import {
	BetterSqliteCoordinatorStore,
	DEFAULT_COORDINATOR_DB_PATH,
} from "./better-sqlite-coordinator-store.js";
import { type CoordinatorRuntimeDeps, createCoordinatorApp } from "./coordinator-api.js";

export interface CreateBetterSqliteCoordinatorAppOptions {
	dbPath?: string;
	runtime?: CoordinatorRuntimeDeps;
}

export function createBetterSqliteCoordinatorApp(
	opts: CreateBetterSqliteCoordinatorAppOptions = {},
): ReturnType<typeof createCoordinatorApp> {
	return createCoordinatorApp({
		storeFactory: () =>
			new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH),
		runtime: opts.runtime,
	});
}
