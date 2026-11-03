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
import { RelayHealthMonitor, type RelayHealthRuntimeOptions } from "./relay-health.js";
import { sqliteRelayHealthPublisher } from "./relay-health-storage.js";
import { verifySignature } from "./sync-auth.js";

export interface CreateBetterSqliteCoordinatorAppOptions {
	dbPath?: string;
	runtime?: CoordinatorRuntimeDeps;
	deviceRevocation?: CoordinatorDeviceRevocationContext;
	relayAdmission?: CoordinatorRelayAdmissionRuntimeOptions;
	relayHealth?: RelayHealthRuntimeOptions;
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
	const relayHealth = createSqliteHealthMonitor(opts.relayHealth, dbPath);
	return createCoordinatorApp({
		relayHealth,
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

function createSqliteHealthMonitor(
	options: RelayHealthRuntimeOptions | undefined,
	dbPath: string,
): RelayHealthMonitor | undefined {
	if (!options?.enabled) return undefined;
	const monitor = new RelayHealthMonitor({
		...options,
		publish: sqliteRelayHealthPublisher(
			() => new BetterSqliteCoordinatorStore(dbPath, { existingOnly: true }),
			options,
		),
	});
	options.onMonitor(monitor);
	return monitor;
}
