// A target device process: its own database, direct sync listener, and the
// relay client `codemem serve` builds. The run drives it over a loopback control port.
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closeServer, emit, isolateProcess, listenLoopback, type PeerInput } from "./common.js";

const input = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as PeerInput;
isolateProcess(input.home);
const device = await import("./device.js");
const { createSyncApp } = await import("../../../viewer-server/src/index.js");
const { createRelayPeerClient, createRelayCoordinatorClient, relayCoordinatorEndpoint, relayGroupClientConfig } =
	await import("../../../core/src/internal/relay-runtime.js");
const { serve } = createRequire(
	fileURLToPath(new URL("../../../viewer-server/package.json", import.meta.url)),
)("@hono/node-server") as {
	serve(options: { fetch: (request: Request) => Response | Promise<Response>; hostname: string; port: number }): unknown;
};

const store = device.deviceStore(input.home, input.identity, [{ ...input.source }]);
const coordinator = { origin: input.origin, coordinatorId: input.coordinatorId };
const app = createSyncApp({ storeFactory: () => store });
const logs: string[] = [];
let direct: Server | undefined;
let relay: ReturnType<typeof device.createViewerRelayReachability> = null;

async function directOn() {
	if (direct) return;
	direct = serve({ fetch: app.fetch, port: input.directPort, hostname: "127.0.0.1" }) as Server;
	await new Promise<void>((resolve, reject) => {
		direct?.once("listening", resolve);
		direct?.once("error", reject);
	});
}

async function directOff() {
	if (direct) await closeServer(direct);
	direct = undefined;
}

async function targetOn() {
	if (relay) return;
	await device.refreshMembership(store, coordinator, [input.groupId]);
	relay = device.createViewerRelayReachability({
		store,
		config: device.relayConfig(input.origin, [input.groupId]),
		log: (line) => logs.push(line),
	});
	if (!relay) throw new Error("relay reachability not built");
	await relay.refresh();
	const clients = relay.reachability.clients();
	if (clients.length !== 1) throw new Error(`no relay client: ${logs.join(" | ")}`);
	for (const client of clients) await client.connect(AbortSignal.timeout(15000), performance.now() + 15000);
}

async function targetOff() {
	await relay?.close();
	relay = null;
}

/** Tries to register with the other team's realm, which this device is not enrolled in. */
async function foreignRegister(): Promise<{ registered: boolean; reason?: string }> {
	const endpoint = relayCoordinatorEndpoint(input.origin);
	if (!endpoint) throw new Error("invalid coordinator origin");
	const config = relayGroupClientConfig(endpoint, input.otherGroupId, input.servicePublicKey);
	const client = createRelayPeerClient({
		...config,
		enabled: true,
		deviceId: input.identity.deviceId,
		localIdentity: { key: createPrivateKey(input.identity.privateKey), expectedPin: input.identity.publicKey },
		coordinator: createRelayCoordinatorClient({ url: config.admissionUrl }),
		resolvePeerPin: () => null,
		validateLocal: () => true,
		onInbound: async (connection) => connection.dispose(new Error("unexpected inbound route")),
	});
	try {
		await client.connect(AbortSignal.timeout(15000), performance.now() + 15000);
		return { registered: true };
	} catch (error) {
		return { registered: false, reason: (error as { reason?: string }).reason };
	} finally {
		await client.close();
	}
}

const actions: Record<string, (params: URLSearchParams) => Promise<unknown> | unknown> = {
	status: () => ({ work: device.titles(store, input.workScope), all: device.allRows(store), logs }),
	refresh: () => device.refreshMembership(store, coordinator, [input.groupId]),
	"target-on": targetOn,
	"target-off": targetOff,
	"direct-on": directOn,
	"direct-off": directOff,
	"foreign-register": foreignRegister,
	seed: (params) =>
		device.seedMemory(store, input.identity.deviceId, input.source.deviceId, params.get("title") ?? "", input.workScope),
};

const control = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? "/", "http://control");
		const action = actions[url.pathname.slice(1)];
		if (request.method !== "POST" || !action) throw new Error("unknown control action");
		const result = (await action(url.searchParams)) ?? { ok: true };
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(result));
	} catch (error) {
		// The run reads details from this process's stderr, never from the control reply.
		console.error(error);
		response.writeHead(400, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: false }));
	}
});

await directOn();
await listenLoopback(control, input.controlPort);
emit("peer-started", { name: input.name });
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.once(signal, () => {
		void Promise.allSettled([targetOff(), directOff(), closeServer(control)]).then(() => {
			store.close();
			process.exit(0);
		});
	});
