import { createPrivateKey } from "node:crypto";
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { vi } from "vitest";
import WebSocket from "ws";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "./admission-budget-schema.js";
import {
	registerCoordinatorRelayAdmissionRoute,
	relayAdmissionNamespaces,
} from "./coordinator-relay-admission-route.js";
import { decisionFixture, decisionSeed } from "./relay-admission-decision-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import { PARTICIPANT_TEST_SCHEMA_SQL } from "./relay-admission-participant-nonce-test-fixtures.js";
import { relayAdmissionStorage } from "./relay-admission-storage-test-fixtures.js";
import { createRelayCoordinatorClient } from "./relay-coordinator-client.js";
import {
	createRelayFaultProxy,
	type RelayFaultProxy,
	type RelayFaultRule,
} from "./relay-fault-proxy-test-fixtures.js";
import {
	installSimulatedRelayBudgetClock,
	type SimulatedRelayPairPacing,
} from "./relay-pair-pacing-test-fixtures.js";
import {
	createRelayPeerClient,
	type RelayPeerClient,
	type RelayPeerClientOptions,
} from "./relay-peer-client.js";
import {
	createSqliteRelayQuota,
	initializeRelayQuotaSchema,
	provisionLocalRelayQuota,
	setRelayQuotaEnabled,
} from "./relay-quota-sqlite.js";
import type { RelayServerOptions } from "./relay-server.js";
import { finiteLimits, testSigner } from "./relay-server-test-fixtures.js";
import { relayAudienceId, relayRealmId } from "./relay-service-proof.js";
import { createRelayWebSocketRuntime } from "./relay-websocket-runtime.js";
import { runtimeLimits } from "./relay-websocket-runtime-test-fixtures.js";

const bind = (values: readonly (string | number | null)[]) =>
	Object.fromEntries(values.map((v, i) => [i + 1, v]));
export const admissionPath = "/trusted/v1/relay/admission-check";
export const relayDeadline = () => performance.now() + 8000;
export function observeRelayWrites() {
	const spy = vi.spyOn(WebSocket.prototype, "send");
	return () => spy.mock.calls.length;
}
export function disposableIdentity(seed: number) {
	return {
		key: createPrivateKey({
			key: Buffer.concat([
				Buffer.from("302e020100300506032b657004220420", "hex"),
				Buffer.alloc(32, seed),
			]),
			format: "der",
			type: "pkcs8",
		}),
		expectedPin: testSigner(seed).publicKey,
	};
}
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing loopback listener");
	return `127.0.0.1:${address.port}`;
}
async function closeServer(server: Server) {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

type Identities = Record<"source" | "target", ReturnType<typeof disposableIdentity>>;
type DeviceIds = Record<"source" | "target", string>;
type Namespace = RelayServerOptions["namespace"];
export interface RelayClientTestOptions {
	readonly monotonicMs?: () => number;
	/** Opt in together: virtual client pacing and real quota SQL with simulated UTC. */
	readonly simulatedPairPacing?: SimulatedRelayPairPacing;
	readonly beforeCheck?: (
		options: Parameters<RelayPeerClientOptions["coordinator"]["check"]>[0],
	) => Promise<void>;
	/** Routes every client socket through a keyless fault proxy in front of the runtime. */
	readonly faultProxy?: { readonly rule?: RelayFaultRule };
	/** Coordinator group the relay serves. Defaults to `group-A`. */
	readonly groupId?: string;
	/** Per-exchange DATA cap, for example the Durable Object host's 2 MiB. */
	readonly routeBytes?: number;
	/** Refill rate for the device and relay-route admission budgets. Defaults to 1 per minute. */
	readonly admissionRatePerMinute?: number;
}

async function admissionDatabase(
	identities: Identities,
	deviceIds: DeviceIds,
	namespace: Namespace,
	options: RelayClientTestOptions,
): Promise<Database.Database> {
	const rate = options.admissionRatePerMinute ?? 1;
	const template = await decisionFixture({
		createdAt: Math.floor(Date.now() / 1000),
		groupId: namespace.groupId,
	});
	template.request.namespace = namespace;
	template.rows = template.rows.map((row) => ({
		...row,
		device_id: deviceIds[row.device_id === "source" ? "source" : "target"],
		public_key: identities[row.device_id === "source" ? "source" : "target"].expectedPin,
	}));
	const db = new Database(":memory:");
	db.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	for (const sql of [
		...RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS,
		...ADMISSION_BUDGET_SCHEMA_STATEMENTS,
	])
		db.exec(sql);
	for (const { sql, values } of decisionSeed(template, Date.now(), {
		audience: namespace.relayAudienceId,
	}))
		db.prepare(sql).run(bind(values));
	const allocate = (pool: string, audience = "", group = "", rate = 1, burst = 16) =>
		db
			.prepare(
				"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?1,?2,?3,?4,?5,?6)",
			)
			.run(bind([namespace.authorityId, pool, audience, group, rate, burst]));
	// The authority row must cover both relay audience parents.
	allocate("authority", "", "", 4 * rate, 64);
	allocate("device", "", "", rate);
	allocate("device-registration", "", "", 1, 2);
	for (const pool of ["relay-route", "relay-registration"]) {
		allocate(pool, namespace.relayAudienceId, "", rate);
		allocate(pool, namespace.relayAudienceId, namespace.groupId, rate);
	}
	return db;
}

function admissionHttp(
	db: Database.Database,
	namespace: Namespace,
	options: RelayClientTestOptions,
) {
	const child = new Hono();
	const storage = relayAdmissionStorage(db, options.simulatedPairPacing);
	registerCoordinatorRelayAdmissionRoute(child, {
		namespaces: relayAdmissionNamespaces(namespace),
		externalPathname: admissionPath,
		ingressKey: "disposable-test",
		open: () => ({
			database: storage.database,
			close() {},
		}),
	});
	const app = new Hono().route("/trusted", child);
	const http = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers))
			if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
		const response = await app.fetch(
			new Request(`http://127.0.0.1${incoming.url}`, {
				method: incoming.method,
				headers,
				body: new Uint8Array(Buffer.concat(chunks)),
			}),
		);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	http.once("close", () => storage.close());
	return http;
}

async function coordinatorFixture(http: Server, options: RelayClientTestOptions) {
	const admissionUrl = `http://${await listen(http)}${admissionPath}`;
	const coordinatorBase = createRelayCoordinatorClient({
		url: admissionUrl,
		allowLoopbackHttp: true,
	});
	const checks: Parameters<RelayPeerClientOptions["coordinator"]["check"]>[0][] = [];
	const checkTimes: number[] = [];
	const coordinator = {
		check: async (request: Parameters<typeof coordinatorBase.check>[0]) => {
			checks.push(request);
			checkTimes.push(performance.now());
			await options.beforeCheck?.(request);
			return coordinatorBase.check(request);
		},
	};
	return { coordinator, checks, checkTimes, admissionUrl };
}

function quotaFixture(namespace: Namespace, options: RelayClientTestOptions) {
	const quotaDb = new Database(":memory:");
	if (options.simulatedPairPacing)
		installSimulatedRelayBudgetClock(quotaDb, options.simulatedPairPacing);
	initializeRelayQuotaSchema(quotaDb);
	const realmId = relayRealmId(namespace.authorityId, namespace.groupId);
	const control = { ratePerMinute: 120, burst: 16 },
		traffic = { ratePerMinute: 16 * 1024 * 1024, burst: 16 * 1024 * 1024 };
	provisionLocalRelayQuota(quotaDb, {
		realmId,
		profile: {
			upgrade: { service: control, realm: control },
			control: { service: control, realm: control, device: control },
			open: {
				service: { ratePerMinute: 30, burst: 4 },
				realm: { ratePerMinute: 30, burst: 4 },
				device: { ratePerMinute: 30, burst: 4 },
				pair: { ratePerMinute: 20, burst: 2 },
			},
			traffic: { service: traffic, realm: traffic, device: traffic, pair: traffic },
		},
	});
	setRelayQuotaEnabled(quotaDb, { realmId, enabled: true });
	const quota = createSqliteRelayQuota({ database: quotaDb, realmId, enabled: true });
	return {
		quotaDb: quotaDb as Database.Database,
		quota,
	};
}

function clientFactory(
	base: Omit<RelayPeerClientOptions, "deviceId" | "localIdentity">,
	identities: Identities,
	deviceIds: DeviceIds,
) {
	const clients: RelayPeerClient[] = [];
	function client(deviceId: "source" | "target", overrides: Partial<RelayPeerClientOptions> = {}) {
		const options: RelayPeerClientOptions = {
			enabled: true,
			...base,
			deviceId: deviceIds[deviceId],
			localIdentity: identities[deviceId],
			resolvePeerPin: (id) => {
				if (id === deviceIds.source) return identities.source.expectedPin;
				if (id === deviceIds.target) return identities.target.expectedPin;
				return null;
			},
			...overrides,
		};
		const result = createRelayPeerClient(options);
		clients.push(result);
		return result;
	}
	return { clients, client };
}

function runtimeFixture(
	server: Server,
	namespace: Namespace,
	coordinator: RelayServerOptions["coordinator"],
	quota: ReturnType<typeof createSqliteRelayQuota>,
	options: RelayClientTestOptions,
) {
	return createRelayWebSocketRuntime({
		server,
		enabled: true,
		relay: {
			namespace,
			signer: testSigner(3),
			coordinator,
			quota,
			limits: { ...finiteLimits, routeBytes: options.routeBytes ?? finiteLimits.routeBytes },
			clock: {
				monotonicMs: options.monotonicMs ?? (() => performance.now()),
				utcMs: () => Date.now(),
			},
		},
		limits: runtimeLimits,
		addressMonotonicMs: options.simulatedPairPacing?.pairPacing.monotonicMs,
		reserveUpgrade: (signal) => quota.reserveUpgrade(signal),
	});
}

/** Clients bind the relay audience to the origin they dial, so a proxy owns the public origin. */
async function faultProxyFixture(
	relayHost: string,
	options: RelayClientTestOptions,
): Promise<RelayFaultProxy | undefined> {
	if (!options.faultProxy) return undefined;
	return createRelayFaultProxy({
		upstreamUrl: `ws://${relayHost}/v1/relay`,
		rule: options.faultProxy.rule,
	});
}

/** Real local protocol participants with disposable identities and separate quota/admission databases. */
export async function relayClientFixture(
	identities: Identities = { source: disposableIdentity(1), target: disposableIdentity(2) },
	deviceIds: DeviceIds = { source: "source", target: "target" },
	options: RelayClientTestOptions = {},
) {
	const service = testSigner(3);
	const socketServer = createServer();
	const relayHost = await listen(socketServer);
	const proxy = await faultProxyFixture(relayHost, options);
	const host = proxy?.host ?? relayHost;
	const namespace = {
		authorityId: "a".repeat(64),
		groupId: options.groupId ?? "group-A",
		relayAudienceId: relayAudienceId(`wss://${host}`, service.keyId),
	};
	const db = await admissionDatabase(identities, deviceIds, namespace, options);
	const http = admissionHttp(db, namespace, options);
	const { coordinator, checks, checkTimes, admissionUrl } = await coordinatorFixture(http, options);
	const { quotaDb, quota } = quotaFixture(namespace, options);
	const runtime = runtimeFixture(socketServer, namespace, coordinator, quota, options);
	const { clients, client } = clientFactory(
		{
			url: `ws://${host}/v1/relay`,
			allowLoopbackWs: true,
			servicePublicKey: service.publicKey,
			...namespace,
			externalPathname: admissionPath,
			coordinator,
			pairPacing: options.simulatedPairPacing?.pairPacing,
			resolvePeerPin: () => null,
			validateLocal: () => true,
			onInbound: async (connection) => {
				await connection.dispose(new Error("No inbound handler"));
			},
		},
		identities,
		deviceIds,
	);
	return {
		client,
		identities,
		db: db as Database.Database,
		quotaDb: quotaDb as Database.Database,
		runtime,
		checks,
		checkTimes,
		namespace,
		proxy,
		url: `ws://${host}/v1/relay`,
		admissionUrl,
		servicePublicKey: service.publicKey,
		async dispose() {
			await Promise.all(clients.map((client) => client.close()));
			await proxy?.close();
			await runtime.close();
			await closeServer(socketServer);
			await closeServer(http);
			quotaDb.close();
			db.close();
		},
	};
}
