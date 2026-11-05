// The Node relay host with a self-hosted SQLite coordinator. "cohosted" serves each
// realm's relay on the coordinator's own HTTP server. "standalone" runs each realm's
// relay on its own listener, as a separate process behind the same hostname would.
import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "../../../core/src/admission-budget-schema.js";
import { createBetterSqliteCoordinatorApp } from "../../../core/src/better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "../../../core/src/better-sqlite-coordinator-store.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "../../../core/src/relay-admission-metadata-schema.js";
import { createRelayCoordinatorClient } from "../../../core/src/relay-coordinator-client.js";
import { parseRelayEd25519PublicKey } from "../../../core/src/relay-ed25519.js";
import type { RelayHealthMonitor } from "../../../core/src/relay-health.js";
import {
	createSqliteRelayQuota,
	initializeRelayQuotaSchema,
	provisionLocalRelayQuota,
	relayQuotaShardProfile,
	setRelayQuotaEnabled,
} from "../../../core/src/relay-quota-sqlite.js";
import { relayAudienceId, relayBodyDigest, relayRealmId } from "../../../core/src/relay-service-proof.js";
import {
	createRelayWebSocketRuntime,
	type RelayWebSocketRuntimeHandle,
} from "../../../core/src/relay-websocket-runtime.js";
import {
	closeServer,
	type Fixture,
	GROUPS,
	type GroupId,
	listenLoopback,
	PROBE_SCOPES,
	type ReadinessRow,
	type RelayHostUnderTest,
	seedDirectory,
} from "./common.js";
import { core } from "./device.js";

const { serve } = createRequire(
	fileURLToPath(new URL("../../../viewer-server/package.json", import.meta.url)),
)("@hono/node-server") as {
	serve(options: { fetch: (request: Request) => Response | Promise<Response>; hostname: string; port: number }): unknown;
};

const ADMISSION_PATH = "/v1/relay/admission-check";
const MiB = 1024 * 1024;
/** The Durable Object host's limits, so both hosts run the same profile. */
const RELAY_LIMITS = {
	sockets: 128,
	pendingSockets: 16,
	routes: 8,
	deviceRoutes: 4,
	queuedBytes: 4 * MiB,
	deviceQueuedBytes: 2 * MiB,
	coordinatorTimeoutMs: 10_000,
	quotaTimeoutMs: 3000,
	routeBytes: 2 * MiB,
};

function relayNamespace(fixture: Fixture, groupId: GroupId) {
	const keyId = relayBodyDigest(parseRelayEd25519PublicKey(fixture.ids.service.publicKey).wireKey);
	const audience = relayAudienceId(`wss://${new URL(fixture.origin).host}`, keyId);
	return { keyId, namespace: { authorityId: fixture.authorityId, groupId, relayAudienceId: audience } };
}

/** The admission policy, audience, realm, tripped readiness and budget rows the admin route writes on Workers. */
function seedRelayRows(db: BetterSqliteCoordinatorStore["db"], fixture: Fixture): void {
	for (const sql of [...RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS, ...ADMISSION_BUDGET_SCHEMA_STATEMENTS]) db.exec(sql);
	const { authorityId } = fixture;
	const audience = relayNamespace(fixture, "team-a").namespace.relayAudienceId;
	const n = GROUPS.length;
	db.prepare("INSERT INTO relay_admission_authority_policy VALUES (?, 1, 'enabled')").run(authorityId);
	db.prepare("INSERT INTO relay_admission_audiences VALUES (?, ?, 'enabled', 1)").run(authorityId, audience);
	db.prepare("INSERT INTO relay_admission_readiness VALUES (?, 'authority', '', 1, 'tripped', NULL)").run(authorityId);
	const allocate = db.prepare(
		"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?,?,?,?,?,?)",
	);
	allocate.run(authorityId, "authority", "", "", 240 * n, 128 * n);
	allocate.run(authorityId, "device", "", "", 96, 16);
	allocate.run(authorityId, "device-registration", "", "", 2, 2);
	for (const pool of ["relay-route", "relay-registration"]) allocate.run(authorityId, pool, audience, "", 120 * n, 64 * n);
	for (const groupId of GROUPS) {
		db.prepare("INSERT INTO relay_admission_realms VALUES (?, ?, 'enabled', 1)").run(authorityId, groupId);
		db.prepare("INSERT INTO relay_admission_readiness VALUES (?, 'realm', ?, 1, 'tripped', NULL)").run(authorityId, groupId);
		for (const pool of ["relay-route", "relay-registration"]) allocate.run(authorityId, pool, audience, groupId, 120, 64);
	}
}

/** One health monitor per group, probing through the public origin with the probe device's key. */
function healthGroups(fixture: Fixture, monitors: RelayHealthMonitor[]) {
	const keysDir = join(fixture.runDir, "probe-keys");
	mkdirSync(keysDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(keysDir, "device.key"), fixture.ids.probe.privateKey, { mode: 0o600 });
	writeFileSync(join(keysDir, "device.key.pub"), fixture.ids.probe.publicKey, { mode: 0o600 });
	return GROUPS.map((groupId) => ({
		enabled: true,
		authorityId: fixture.authorityId,
		coordinatorOrigin: fixture.origin,
		groupId,
		syntheticScopeId: PROBE_SCOPES[groupId],
		probeDeviceId: fixture.ids.probe.deviceId,
		// The same declared bound the Worker uses for its host clock.
		clock: () => ({ utcMs: Date.now(), verified: true, maxErrorMs: 1000, resolutionMs: 1 }),
		sign: async ({ url }: { url: string }) =>
			core.buildAuthHeaders({ deviceId: fixture.ids.probe.deviceId, keysDir, url, method: "GET", bodyBytes: Buffer.alloc(0) }),
		onMonitor: (monitor: RelayHealthMonitor) => monitors.push(monitor),
	}));
}

async function startCoordinator(fixture: Fixture, dbPath: string, monitors: RelayHealthMonitor[]) {
	const namespaces = new Map(GROUPS.map((groupId) => [groupId, relayNamespace(fixture, groupId).namespace]));
	const app = createBetterSqliteCoordinatorApp({
		dbPath,
		runtime: { now: () => new Date().toISOString(), adminSecret: () => null },
		relayAdmission: {
			namespaces,
			externalPathname: ADMISSION_PATH,
			ingressKey: "relay-host-acceptance",
			servicePublicKey: fixture.ids.service.publicKey,
		},
		relayHealth: healthGroups(fixture, monitors),
	});
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	return server;
}

function startRelay(fixture: Fixture, groupId: GroupId, server: Server | undefined) {
	const { keyId, namespace } = relayNamespace(fixture, groupId);
	const realmId = relayRealmId(fixture.authorityId, groupId);
	const db = core.connect(join(fixture.runDir, `quota-${groupId}.sqlite`));
	initializeRelayQuotaSchema(db);
	provisionLocalRelayQuota(db, { realmId, profile: relayQuotaShardProfile(GROUPS.length) });
	setRelayQuotaEnabled(db, { realmId, enabled: true });
	const quota = createSqliteRelayQuota({ database: db, realmId, enabled: true });
	const key = createPrivateKey(fixture.ids.service.privateKey);
	const runtime = createRelayWebSocketRuntime({
		server,
		path: `/v1/relay/${realmId}`,
		enabled: true,
		relay: {
			namespace,
			signer: { keyId, sign: async (bytes) => new Uint8Array(sign(null, bytes, key)) },
			coordinator: createRelayCoordinatorClient({ url: `${fixture.origin}${ADMISSION_PATH}` }),
			quota,
			clock: { monotonicMs: () => performance.now(), utcMs: () => Date.now() },
			limits: RELAY_LIMITS,
		},
		limits: { sockets: 128, pendingSockets: 16, writeBytes: 2 * MiB },
		reserveUpgrade: (signal) => quota.reserveUpgrade(signal),
	});
	return { runtime, close: () => db.close() };
}

export async function startNodeHost(fixture: Fixture, mode: "cohosted" | "standalone"): Promise<RelayHostUnderTest> {
	const dbPath = join(fixture.runDir, "coordinator.sqlite");
	const store = new BetterSqliteCoordinatorStore(dbPath);
	await seedDirectory(store as never, fixture, core.fingerprintPublicKey);
	seedRelayRows(store.db, fixture);
	store.close();
	const monitors: RelayHealthMonitor[] = [];
	const coordinator = await startCoordinator(fixture, dbPath, monitors);
	const relays = new Map<GroupId, { runtime: RelayWebSocketRuntimeHandle; close: () => void; port: number }>();
	const coordinatorPort = (coordinator.address() as { port: number }).port;
	for (const groupId of GROUPS) {
		const relay = startRelay(fixture, groupId, mode === "cohosted" ? coordinator : undefined);
		const port = mode === "cohosted" ? coordinatorPort : await listenLoopback(relay.runtime.server);
		relays.set(groupId, { ...relay, port });
	}
	for (const monitor of monitors) monitor.start();
	const relayFor = (groupId: GroupId) => {
		const relay = relays.get(groupId);
		if (!relay) throw new Error(`no relay for ${groupId}`);
		return relay;
	};
	return {
		name: `node-${mode}`,
		httpPort: coordinatorPort,
		relayUpstream: (groupId) => `ws://127.0.0.1:${relayFor(groupId).port}`,
		readiness: async () => {
			const read = new BetterSqliteCoordinatorStore(dbPath, { existingOnly: true });
			try {
				return read.db
					.prepare("SELECT scope, group_id, state FROM relay_admission_readiness ORDER BY scope, group_id")
					.all() as ReadinessRow[];
			} finally {
				read.close();
			}
		},
		counters: async (groupId) => relayFor(groupId).runtime.counters(),
		// The Node host's operator switch for one realm.
		disableRealm: async (groupId) => relayFor(groupId).runtime.disable(),
		dispose: async () => {
			for (const monitor of monitors) monitor.stop();
			for (const relay of relays.values()) {
				await relay.runtime.close();
				relay.close();
			}
			await closeServer(coordinator);
		},
	};
}
