// Runs every acceptance stage against one relay host. run.ts starts this process with
// NODE_EXTRA_CA_CERTS set to the run's test CA. Arguments: <host> <run dir> <tls dir>.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	emit,
	type Fixture,
	freePort,
	GROUPS,
	type GroupId,
	isolateProcess,
	newIdentities,
	type PeerInput,
	type RelayHostUnderTest,
	writePrivate,
} from "./common.js";
import type { PeerHandle, StageContext } from "./stages.js";

const [hostName = "", runDir = "", tlsDir = ""] = process.argv.slice(2);
isolateProcess(join(runDir, "source"));
const { relayCoordinatorEndpoint } = await import("../../../core/src/relay-client-config.js");
const device = await import("./device.js");
const { startFront } = await import("./front.js");
const stages = await import("./stages.js");
const faults = await import("./stages-faults.js");

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const cleanups: (() => unknown)[] = [];

async function startHost(fixture: Fixture): Promise<RelayHostUnderTest & { provision?: () => Promise<void> }> {
	if (hostName === "do") return (await import("./host-do.js")).startDurableObjectHost(fixture);
	const mode = hostName === "node-cohosted" ? "cohosted" : "standalone";
	if (hostName !== `node-${mode}`) throw new Error(`unknown host ${hostName}`);
	return (await import("./host-node.js")).startNodeHost(fixture, mode);
}

async function spawnPeer(input: PeerInput): Promise<PeerHandle> {
	const file = writePrivate(runDir, `peer-${input.name}.json`, input);
	const child = spawn(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), "--conditions", "source", join(here, "peer.ts"), file], {
		cwd: repo,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stderr: string[] = [];
	child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
	cleanups.push(() => {
		child.kill("SIGTERM");
		writeFileSync(join(runDir, `peer-${input.name}.stderr`), stderr.join(""));
	});
	await new Promise<void>((resolve, reject) => {
		child.stdout?.on("data", (chunk) => (String(chunk).includes("peer-started") ? resolve() : undefined));
		child.once("exit", (code) => reject(new Error(`peer ${input.name} exited ${code}: ${stderr.join("").slice(-2000)}`)));
	});
	const control = async (action: string, params: Record<string, string> = {}) => {
		const query = new URLSearchParams(params).toString();
		const response = await fetch(`http://127.0.0.1:${input.controlPort}/${action}${query ? `?${query}` : ""}`, {
			method: "POST",
			signal: AbortSignal.timeout(30_000),
		});
		const body = (await response.json()) as Record<string, unknown>;
		if (response.status !== 200) throw new Error(`peer ${input.name} ${action}: ${JSON.stringify(body)}`);
		return body;
	};
	return { deviceId: input.identity.deviceId, control };
}

async function peerInput(fixture: Fixture, name: string, groupId: GroupId, workScope: string): Promise<PeerInput> {
	const identity = name === "b" ? fixture.ids.targetB : fixture.ids.targetC;
	return {
		name,
		home: join(runDir, `peer-${name}`),
		origin: fixture.origin,
		coordinatorId: fixture.coordinatorId,
		identity,
		source: { deviceId: fixture.ids.source.deviceId, publicKey: fixture.ids.source.publicKey },
		servicePublicKey: fixture.ids.service.publicKey,
		groupId,
		otherGroupId: GROUPS.find((group) => group !== groupId) ?? groupId,
		workScope,
		directPort: await freePort(),
		controlPort: await freePort(),
	};
}

async function setUp(): Promise<StageContext> {
	const front = await startFront({
		key: readFileSync(join(tlsDir, "leaf.key")),
		cert: readFileSync(join(tlsDir, "leaf.pem")),
	});
	cleanups.push(() => front.close());
	const origin = `https://127.0.0.1:${front.port}`;
	const endpoint = relayCoordinatorEndpoint(origin);
	if (!endpoint) throw new Error("invalid origin");
	const fixture: Fixture = {
		origin,
		coordinatorId: endpoint.coordinatorId,
		authorityId: endpoint.authorityId,
		runDir,
		adminSecret: randomUUID(),
		ids: newIdentities(),
	};
	const host = await startHost(fixture);
	cleanups.push(() => host.dispose());
	await front.attach(host, fixture.authorityId);
	await host.provision?.();
	emit("host-started", { host: host.name });
	const inputs = [await peerInput(fixture, "b", "team-a", "work-a"), await peerInput(fixture, "c", "team-b", "work-b")];
	const [b, c] = await Promise.all(inputs.map(spawnPeer));
	if (!b || !c) throw new Error("peers did not start");
	const peers = inputs.map((input) => ({
		deviceId: input.identity.deviceId,
		publicKey: input.identity.publicKey,
		address: `http://127.0.0.1:${input.directPort}`,
	}));
	const store = device.deviceStore(join(runDir, "source"), fixture.ids.source, peers);
	cleanups.push(() => store.close());
	await device.refreshMembership(store, fixture, GROUPS);
	const ctx = { host, front, fixture, store, b, c, logs: [] as string[], results: {} } as Omit<StageContext, "relay">;
	const relay = stages.newRelay(ctx);
	const full: StageContext = { ...ctx, relay };
	cleanups.push(() => full.relay.close());
	return full;
}

const STAGES = [
	stages.healthReady,
	stages.directBaseline,
	stages.relayConvergence,
	stages.unauthorizedSpace,
	stages.foreignRealm,
	stages.secondTeam,
	stages.offlineDrop,
	faults.faultCases,
	faults.quotaCounters,
	faults.disableThenDirect,
];

let exitCode = 0;
try {
	const ctx = await setUp();
	for (const stage of STAGES) await stage(ctx);
	writePrivate(runDir, "results.json", { host: ctx.host.name, ...ctx.results, logs: ctx.logs });
	emit("done", { host: ctx.host.name });
} catch (error) {
	console.error(error);
	emit("failed", { host: hostName, error: error instanceof Error ? error.message.slice(0, 2000) : String(error) });
	exitCode = 1;
} finally {
	for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => {});
	process.exit(exitCode);
}
