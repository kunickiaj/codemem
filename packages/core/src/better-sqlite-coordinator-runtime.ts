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
import {
	RelayHealthMonitor,
	type RelayHealthRuntimeOptions,
	type RelayHealthServerHook,
} from "./relay-health.js";
import {
	aggregateRelayHealthAuthority,
	type RelayHealthPublication,
	sqliteRelayHealthPublisher,
} from "./relay-health-storage.js";
import { verifySignature } from "./sync-auth.js";

export interface CreateBetterSqliteCoordinatorAppOptions {
	dbPath?: string;
	runtime?: CoordinatorRuntimeDeps;
	deviceRevocation?: CoordinatorDeviceRevocationContext;
	relayAdmission?: CoordinatorRelayAdmissionRuntimeOptions;
	/**
	 * Health for one relay group, or a list with one entry per served group. Every
	 * entry must share one authority. Each group gets its own monitor and realm
	 * row, and the authority row carries the aggregate of every group.
	 */
	relayHealth?: RelayHealthRuntimeOptions | readonly RelayHealthRuntimeOptions[];
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

function healthGroups(
	options: CreateBetterSqliteCoordinatorAppOptions["relayHealth"],
): readonly RelayHealthRuntimeOptions[] {
	if (!options) return [];
	return Array.isArray(options) ? options : [options as RelayHealthRuntimeOptions];
}

function createSqliteHealthMonitor(
	options: CreateBetterSqliteCoordinatorAppOptions["relayHealth"],
	dbPath: string,
): RelayHealthServerHook | undefined {
	const groups = healthGroups(options).filter((group) => group.enabled);
	if (groups.length === 0) return undefined;
	if (new Set(groups.map((group) => group.authorityId)).size !== 1)
		throw new Error("relay health groups must share one authority");
	if (new Set(groups.map((group) => group.groupId)).size !== groups.length)
		throw new Error("relay health groups must be distinct");
	const open = () => new BetterSqliteCoordinatorStore(dbPath, { existingOnly: true });
	const monitors = new Map<string, RelayHealthMonitor>();
	// Every realm publication also bumps the authority row, which carries the
	// aggregate of every group, so one group's trip never denies the others.
	const authority = (groupId: string, value: RelayHealthPublication) =>
		aggregateRelayHealthAuthority(
			[...monitors].map(([other, monitor]) => (other === groupId ? value : monitor.snapshot())),
		);
	for (const group of groups) {
		const publish = sqliteRelayHealthPublisher(open, group, {
			authority: (value) => authority(group.groupId, value),
		});
		monitors.set(group.groupId, new RelayHealthMonitor({ ...group, publish }));
	}
	for (const group of groups) {
		const monitor = monitors.get(group.groupId);
		if (monitor) group.onMonitor(monitor);
	}
	const all = [...monitors.values()];
	return {
		verifiedGroupMember: (request, deviceId, groupId) => {
			for (const monitor of all) monitor.verifiedGroupMember(request, deviceId, groupId);
		},
		install: (app) => {
			for (const monitor of all) monitor.install(app);
		},
	};
}
