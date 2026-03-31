import {
	BetterSqliteCoordinatorStore,
	DEFAULT_COORDINATOR_DB_PATH,
} from "./better-sqlite-coordinator-store.js";
import {
	type CoordinatorRequestVerifier,
	type CoordinatorRuntimeDeps,
	createCoordinatorApp,
} from "./coordinator-api.js";
import { verifySignature } from "./sync-auth.js";

export interface CreateBetterSqliteCoordinatorAppOptions {
	dbPath?: string;
	runtime?: CoordinatorRuntimeDeps;
}

export function createBetterSqliteCoordinatorApp(
	opts: CreateBetterSqliteCoordinatorAppOptions = {},
): ReturnType<typeof createCoordinatorApp> {
	const runtime: CoordinatorRuntimeDeps = opts.runtime ?? {
		adminSecret: () =>
			String(process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET ?? "").trim() || null,
		now: () => new Date().toISOString(),
	};
	const requestVerifier: CoordinatorRequestVerifier = async (input) =>
		verifySignature({
			...input,
			bodyBytes: Buffer.from(input.bodyBytes),
		});
	return createCoordinatorApp({
		storeFactory: () =>
			new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH),
		runtime,
		requestVerifier,
	});
}
