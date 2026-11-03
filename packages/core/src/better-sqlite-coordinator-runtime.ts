import {
	BetterSqliteCoordinatorStore,
	DEFAULT_COORDINATOR_DB_PATH,
} from "./better-sqlite-coordinator-store.js";
import {
	type CoordinatorRequestVerifier,
	type CoordinatorRuntimeDeps,
	createCoordinatorApp,
} from "./coordinator-api.js";
import type { CoordinatorDeviceRevocationContext } from "./coordinator-device-revocation-route.js";
import type { CoordinatorRelayAdmissionRuntimeOptions } from "./coordinator-relay-admission-route.js";
import { verifySignature } from "./sync-auth.js";

export interface CreateBetterSqliteCoordinatorAppOptions {
	dbPath?: string;
	runtime?: CoordinatorRuntimeDeps;
	deviceRevocation?: CoordinatorDeviceRevocationContext;
	relayAdmission?: CoordinatorRelayAdmissionRuntimeOptions;
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
	const dbPath = opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH;
	return createCoordinatorApp({
		storeFactory: (options) => new BetterSqliteCoordinatorStore(dbPath, options),
		deviceRevocation: opts.deviceRevocation,
		runtime,
		requestVerifier,
		relayAdmission: opts.relayAdmission
			? {
					...opts.relayAdmission,
					open: () => {
						const store = new BetterSqliteCoordinatorStore(dbPath, { existingOnly: true });
						const bindings = (values: readonly (string | number | null)[]) =>
							Object.fromEntries(values.map((value, index) => [index + 1, value]));
						return {
							database: {
								query: async (sql, values) => store.db.prepare(sql).all(bindings(values)),
								insertReturning: async (sql, values) => store.db.prepare(sql).get(bindings(values)),
							},
							close: () => store.close(),
						};
					},
				}
			: undefined,
	});
}
