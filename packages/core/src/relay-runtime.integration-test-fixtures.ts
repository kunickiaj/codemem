import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { Hono } from "hono";
import WebSocket from "ws";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "./admission-budget-schema.js";
import {
	registerCoordinatorRelayAdmissionRoute,
	relayAdmissionNamespaces,
} from "./coordinator-relay-admission-route.js";
import { createRelayCoordinatorClient } from "./relay-coordinator-client.js";
import {
	createSqliteRelayQuota,
	initializeRelayQuotaSchema,
	provisionLocalRelayQuota,
	setRelayQuotaEnabled,
} from "./relay-quota-sqlite.js";
import type { RelayServerOptions } from "./relay-server.js";
import { serverFixture } from "./relay-server-test-fixtures.js";
import { relayRealmId } from "./relay-service-proof.js";
import {
	createRelayWebSocketRuntime,
	type RelayWebSocketRuntimeHandle,
} from "./relay-websocket-runtime.js";
import { peer, registerPeer, runtimeLimits } from "./relay-websocket-runtime-test-fixtures.js";

const bind = (values: readonly (string | number | null)[]) =>
	Object.fromEntries(values.map((value, index) => [index + 1, value]));
const admissionPath = "/trusted/v1/relay/admission-check";
interface IntegrationFixture {
	signed: Awaited<ReturnType<typeof serverFixture>>;
	coordinator: RelayServerOptions["coordinator"];
	quotaDb: Database.Database;
	realmId: string;
	runtime: RelayWebSocketRuntimeHandle;
	register(deviceId?: string): Promise<ReturnType<typeof peer>>;
	dispose(): Promise<void>;
}

function installBudgets(signed: Awaited<ReturnType<typeof serverFixture>>) {
	for (const sql of ADMISSION_BUDGET_SCHEMA_STATEMENTS) signed.db.exec(sql);
	const { authorityId, relayAudienceId, groupId } = signed.options.namespace;
	const allocate = (pool: string, audience = "", group = "", rate = 1, burst = 16) =>
		signed.db
			.prepare(
				"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?1,?2,?3,?4,?5,?6)",
			)
			.run(bind([authorityId, pool, audience, group, rate, burst]));
	allocate("authority", "", "", 4, 64);
	for (const pool of ["relay-route", "relay-registration"]) {
		const burst = pool === "relay-registration" ? 2 : 16;
		allocate(pool, relayAudienceId, "", 1, burst);
		allocate(pool, relayAudienceId, groupId, 1, burst);
	}
	allocate("device");
	allocate("device-registration", "", "", 1, 2);
}

async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing loopback listener");
	return `127.0.0.1:${address.port}`;
}

function admissionServer(signed: Awaited<ReturnType<typeof serverFixture>>) {
	const child = new Hono();
	registerCoordinatorRelayAdmissionRoute(child, {
		namespaces: relayAdmissionNamespaces(signed.options.namespace),
		externalPathname: admissionPath,
		ingressKey: "integration",
		open: () => ({
			database: {
				query: async (sql, values) => signed.db.prepare(sql).all(bind(values)),
				insertReturning: async (sql, values) => signed.db.prepare(sql).get(bind(values)) ?? null,
			},
			close: () => {},
		}),
	});
	const app = new Hono().route("/trusted", child);
	return createServer(async (incoming, outgoing) => {
		try {
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
		} catch {
			outgoing.writeHead(500);
			outgoing.end();
		}
	});
}

function localQuota(realmId: string) {
	const db = new Database(":memory:");
	db.function("strftime", { varargs: true }, (format) => {
		if (format === "%s") return "110";
		if (format === "%f") return "50.000";
		throw new Error("Unexpected quota clock format");
	});
	initializeRelayQuotaSchema(db);
	const control = { ratePerMinute: 16, burst: 16 },
		open = { ratePerMinute: 2, burst: 2 };
	const traffic = { ratePerMinute: 1024 * 1024, burst: 1024 * 1024 };
	provisionLocalRelayQuota(db, {
		realmId,
		profile: {
			upgrade: { service: control, realm: control },
			control: { service: control, realm: control, device: control },
			open: { service: open, realm: open, device: open, pair: open },
			traffic: { service: traffic, realm: traffic, device: traffic, pair: traffic },
		},
	});
	setRelayQuotaEnabled(db, { realmId, enabled: true });
	return { quotaDb: db, quota: createSqliteRelayQuota({ database: db, realmId, enabled: true }) };
}

export async function integrationFixture(): Promise<IntegrationFixture> {
	const signed = await serverFixture();
	installBudgets(signed);
	const http = admissionServer(signed);
	const endpoint = `http://${await listen(http)}${admissionPath}`;
	const coordinator = createRelayCoordinatorClient({ url: endpoint, allowLoopbackHttp: true });
	const { authorityId, groupId } = signed.options.namespace;
	const realmId = relayRealmId(authorityId, groupId);
	const { quotaDb, quota } = localQuota(realmId);
	const runtime = createRelayWebSocketRuntime({
		relay: { ...signed.options, coordinator, quota },
		enabled: true,
		limits: runtimeLimits,
		reserveUpgrade: (signal) => quota.reserveUpgrade(signal),
	});
	const url = `ws://${await listen(runtime.server)}/v1/relay`;
	const peers: ReturnType<typeof peer>[] = [];
	return {
		signed,
		coordinator,
		quotaDb,
		realmId,
		runtime,
		async register(deviceId = "source") {
			const client = peer(new WebSocket(url));
			peers.push(client);
			return registerPeer(client, signed, deviceId);
		},
		async dispose() {
			for (const client of peers) client.ws.terminate();
			await runtime.close();
			await Promise.all(peers.map((client) => client.closed));
			await new Promise<void>((resolve) => {
				http.close(() => resolve());
				http.closeAllConnections();
			});
			quotaDb.close();
			signed.dispose();
		},
	};
}
