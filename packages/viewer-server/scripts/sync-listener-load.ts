/**
 * Load measurement for the direct sync listener with direct Noise on.
 *
 * Run: pnpm run load:sync-listener [-- --config path/to/configs.json]
 *
 * The driver prepares one seed store and many paired peer stores, then for
 * each listener configuration starts the seed in its own process, so its RSS
 * excludes the clients, and runs these scenarios:
 *
 * - idle: one legitimate peer, on ::1, runs sequential sync passes.
 * - flood: authenticated peers on 127.0.0.1 send status requests over Noise
 *   as fast as they can while the legitimate peer syncs.
 * - hold: authenticated peers on 127.0.0.1 open Noise streams and keep them
 *   idle while the legitimate peer syncs.
 * - nat: many authenticated peers behind one address (127.0.0.1) start a
 *   sync pass at the same moment, as devices behind one NAT do after a
 *   network change.
 *
 * It prints one JSON report: peak added RSS, legitimate p50/p95 sync latency
 * and failures for each scenario.
 */
import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	buildDirectPeerAuthHeaders,
	connect,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
	peerTransportExecutor,
	syncOnce,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import { directNoiseConnectionFactory } from "../../core/src/direct-noise-client.js";
import { promotePeerToNoiseRequired } from "../../core/src/sync-transport-policy.js";
import { createSyncApp } from "../src/sync-app.js";
import {
	createGuardedSyncServer,
	createSyncListenerLimiter,
	type SyncListenerLimits,
} from "../src/sync-listener-guard.js";
import type { DirectNoiseGateLimits } from "../src/sync-noise-gate.js";

/** Listener caps default to SYNC_LISTENER_CAPS here, because direct Noise is on. */
type Limits = { listener?: Record<string, number | null>; gate?: Partial<DirectNoiseGateLimits> };
type Message = Record<string, unknown> & { type: string };

const SELF = fileURLToPath(import.meta.url);

// ---- shared fixture layout ----

function peerDir(root: string, index: number) {
	return { dbPath: join(root, `peer-${index}.sqlite`), keysDir: join(root, `peer-${index}-keys`) };
}

function seedPaths(root: string) {
	return { dbPath: join(root, "seed.sqlite"), keysDir: join(root, "seed-keys") };
}

/** One seed and `count` peers, each peer pinned on the seed and the seed pinned on each peer. */
function prepare(root: string, count: number) {
	const seed = seedPaths(root);
	const seedDb = connect(seed.dbPath);
	initTestSchema(seedDb);
	const [seedId] = ensureDeviceIdentity(seedDb, { keysDir: seed.keysDir });
	const seedKey = loadPublicKey(seed.keysDir) ?? "";
	const pin = seedDb.prepare(
		"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')",
	);
	for (let index = 0; index < count; index++) {
		const peer = peerDir(root, index);
		const db = connect(peer.dbPath);
		initTestSchema(db);
		const [peerId] = ensureDeviceIdentity(db, { keysDir: peer.keysDir });
		const peerKey = loadPublicKey(peer.keysDir) ?? "";
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')",
		).run(seedId, fingerprintPublicKey(seedKey), seedKey);
		// Every peer has synced over Noise before, so a refused upgrade fails instead of
		// falling back to plaintext, as it will for activated peers.
		promotePeerToNoiseRequired(db, seedId, "authenticated_exchange");
		db.close();
		pin.run(peerId, fingerprintPublicKey(peerKey), peerKey);
	}
	seedDb.close();
	return seedId;
}

// ---- seed process ----

/** JSON has no undefined, so a plan turns a cap off with null. */
function listenerLimits(limits: Record<string, number | null> | undefined) {
	return Object.fromEntries(
		Object.entries(limits ?? {}).map(([name, value]) => [name, value ?? undefined]),
	) as Partial<SyncListenerLimits>;
}

async function runSeed(root: string, limits: Limits): Promise<void> {
	const seed = seedPaths(root);
	const store = new MemoryStore(seed.dbPath);
	const limiter = createSyncListenerLimiter();
	const storeFactory = () => store;
	const app = createSyncApp({
		storeFactory,
		mode: { kind: "plain-direct", noiseActive: true },
		syncRequestRateLimit: { limiter },
	});
	const createServer = createGuardedSyncServer({
		limits: listenerLimits(limits.listener),
		limiter,
		directNoise: { storeFactory, keysDir: seed.keysDir, limits: limits.gate, active: true },
	});
	let peak = process.memoryUsage().rss;
	const counts = { plainRequests: 0, upgrades: 0 };
	setInterval(() => {
		peak = Math.max(peak, process.memoryUsage().rss);
	}, 10).unref();
	process.on("message", (message: Message) => {
		if (message.type !== "peak") return;
		const rss = process.memoryUsage().rss;
		process.send?.({ type: "peak", peak: Math.max(peak, rss), rss, ...counts });
		peak = rss;
		counts.plainRequests = 0;
		counts.upgrades = 0;
	});
	const server = serve({ fetch: app.fetch, hostname: "::", port: 0, createServer }, (info) =>
		process.send?.({ type: "ready", port: info.port }),
	);
	server.on("request", () => {
		counts.plainRequests += 1;
	});
	server.on("upgrade", () => {
		counts.upgrades += 1;
	});
	process.on("disconnect", () => server.close(() => process.exit(0)));
}

// ---- client roles ----

interface Peer {
	dbPath: string;
	keysDir: string;
	db: ReturnType<typeof connect>;
	deviceId: string;
}

function openPeer(root: string, index: number): Peer {
	const paths = peerDir(root, index);
	const db = connect(paths.dbPath);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir: paths.keysDir });
	return { ...paths, db, deviceId };
}

/** One sync pass from a peer, timed. Fails rather than throws. */
async function timedSync(peer: Peer, seedId: string, address: string) {
	const started = performance.now();
	const result = await syncOnce(peer.db, seedId, [address], {
		keysDir: peer.keysDir,
		dbPath: peer.dbPath,
		directNoise: { active: true },
	}).catch((error: unknown) => ({ ok: false, error: String(error) }));
	return { ms: performance.now() - started, ok: result.ok, error: result.ok ? null : result.error };
}

/** Set when the driver says the measured passes are done. */
const stop = { requested: false };

/** Status requests over Noise, back to back, until the driver says stop. */
async function floodWorker(peer: Peer, seedId: string, address: string) {
	const counts = { ok: 0, failed: 0, errors: new Map<string, number>() };
	const execute = peerTransportExecutor({
		db: peer.db,
		peerDeviceId: seedId,
		localDeviceId: peer.deviceId,
		keysDir: peer.keysDir,
		dbPath: peer.dbPath,
		active: true,
	});
	const url = `http://${address}/v1/status`;
	while (!stop.requested) {
		const headers = buildDirectPeerAuthHeaders({
			deviceId: peer.deviceId,
			recipientId: seedId,
			method: "GET",
			url,
			bodyBytes: Buffer.alloc(0),
			keysDir: peer.keysDir,
			dbPath: peer.dbPath,
		});
		const outcome = await execute("GET", url, { operation: "status", headers }).then(
			([status]) => (status === 200 ? null : `status ${status}`),
			(error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 120),
		);
		if (outcome === null) counts.ok += 1;
		else {
			counts.failed += 1;
			counts.errors.set(outcome, (counts.errors.get(outcome) ?? 0) + 1);
		}
	}
	return counts;
}

/** Opens up to `streams` idle Noise streams and keeps them open. */
async function holdStreams(peer: Peer, seedId: string, port: number, streams: number) {
	const pin = connectPin(peer, seedId);
	const factory = directNoiseConnectionFactory({
		db: peer.db,
		host: "127.0.0.1",
		port,
		localDeviceId: peer.deviceId,
		peerDeviceId: seedId,
		keysDir: peer.keysDir,
		dbPath: peer.dbPath,
		expectedPin: pin,
	});
	let opened = 0;
	// One at a time, so the per-address pending cap doesn't refuse them.
	for (let stream = 0; stream < streams; stream++) {
		const options = {
			signal: new AbortController().signal,
			deadlineMs: performance.now() + 15_000,
		};
		if (
			await factory.open(options).then(
				() => true,
				() => false,
			)
		)
			opened += 1;
	}
	return opened;
}

function connectPin(peer: Peer, seedId: string): string {
	const row = peer.db
		.prepare("SELECT public_key FROM sync_peers WHERE peer_device_id = ?")
		.pluck()
		.get(seedId);
	return String(row ?? "");
}

async function runClient(root: string, role: Message): Promise<void> {
	const seedId = String(role.seedId);
	const indexes = role.peers as number[];
	const peers = indexes.map((index) => openPeer(root, index));
	const address = `127.0.0.1:${role.port}`;
	if (role.mode === "flood") {
		process.on("message", (message: Message) => {
			if (message.type === "stop") stop.requested = true;
		});
		const workers = peers.flatMap((peer) =>
			Array.from({ length: Number(role.workers) }, () => floodWorker(peer, seedId, address)),
		);
		const counts = await Promise.all(workers);
		process.send?.({
			type: "done",
			ok: sum(counts, "ok"),
			failed: sum(counts, "failed"),
			errors: mergedErrors(counts),
		});
		return;
	}
	if (role.mode === "hold") {
		let streams = 0;
		for (const peer of peers)
			streams += await holdStreams(peer, seedId, Number(role.port), Number(role.workers));
		process.send?.({ type: "held", streams });
		return;
	}
	const spreadMs = Number(role.spreadMs ?? 0);
	const passes = await Promise.all(
		peers.map(async (peer, index) => {
			await new Promise((resolve) => setTimeout(resolve, (index * spreadMs) / peers.length));
			return timedSync(peer, seedId, address);
		}),
	);
	process.send?.({ type: "done", passes });
}

function sum(counts: { ok: number; failed: number }[], field: "ok" | "failed"): number {
	return counts.reduce((total, count) => total + count[field], 0);
}

function mergedErrors(counts: { errors: Map<string, number> }[]): Record<string, number> {
	const merged: Record<string, number> = {};
	for (const count of counts)
		for (const [error, n] of count.errors) merged[error] = (merged[error] ?? 0) + n;
	return merged;
}

// ---- driver ----

function child(args: string[], env: Record<string, string> = {}): ChildProcess {
	return fork(SELF, args, {
		env: { ...process.env, ...env },
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
}

function next(processRef: ChildProcess, type: string): Promise<Message> {
	return new Promise((resolve, reject) => {
		const onMessage = (message: Message) => {
			if (message.type !== type) return;
			processRef.off("message", onMessage);
			resolve(message);
		};
		processRef.on("message", onMessage);
		processRef.once("exit", (code) => reject(new Error(`child exited ${code} before ${type}`)));
	});
}

function percentile(values: number[], fraction: number): number {
	if (!values.length) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0);
}

/** Sequential passes from the legitimate peer, which syncs from ::1, another address. */
/** Each scenario uses its own legitimate peer, so the per-device route limit isn't shared. */
async function legitimatePasses(
	root: string,
	seedId: string,
	port: number,
	count: number,
	index: number,
) {
	const peer = openPeer(root, index);
	const results = [];
	for (let pass = 0; pass < count; pass++)
		results.push(await timedSync(peer, seedId, `[::1]:${port}`));
	peer.db.close();
	const times = results.filter((result) => result.ok).map((result) => result.ms);
	const errors = [...new Set(results.flatMap((result) => (result.error ? [result.error] : [])))];
	return {
		p50: percentile(times, 0.5),
		p95: percentile(times, 0.95),
		failed: results.length - times.length,
		errors,
	};
}

const MiB = 1024 * 1024;
/** Warm-up, idle, flood and hold each get their own legitimate peer. */
const LEGITIMATE_PEERS = 4;

async function measured<T>(seed: ChildProcess, run: () => Promise<T>) {
	seed.send({ type: "peak" });
	const before = await next(seed, "peak");
	const result = await run();
	seed.send({ type: "peak" });
	const after = await next(seed, "peak");
	return {
		...result,
		addedPeakMiB: Math.round((Number(after.peak) - Number(before.rss)) / MiB),
		seedUpgrades: after.upgrades,
		seedPlainRequests: after.plainRequests,
	};
}

interface Plan {
	name: string;
	limits: Limits;
	attackers: number;
	workers: number;
	holdStreams: number;
	natPeers: number;
	passes: number;
	/** Ramp time before the measured passes, while the flood runs. */
	floodMs: number;
	/** Window over which the spread NAT scenario starts its passes. */
	natSpreadMs: number;
}

type Scenario = {
	port: number;
	seed: ChildProcess;
	role: (mode: string, peers: number[], extra?: Record<string, unknown>) => string;
};

/** Runs one scenario against a fresh seed, so no scenario inherits another's rate-limit state. */
async function scenario<T>(
	root: string,
	seedId: string,
	plan: Plan,
	run: (context: Scenario) => Promise<T>,
) {
	const env = {
		LOAD_LIMITS: JSON.stringify(plan.limits),
		CODEMEM_KEYS_DIR: seedPaths(root).keysDir,
	};
	const seed = child(["--seed", root], env);
	try {
		const port = Number((await next(seed, "ready")).port);
		const role = (mode: string, peers: number[], extra: Record<string, unknown> = {}) =>
			JSON.stringify({ mode, peers, seedId, port, workers: plan.workers, ...extra });
		// Warm up the seed's code paths so the peak measures load, not first use.
		await legitimatePasses(root, seedId, port, 5, 0);
		return await measured(seed, () => run({ port, seed, role }));
	} finally {
		seed.disconnect();
	}
}

async function floodScenario(root: string, seedId: string, plan: Plan, attackers: number[]) {
	return scenario(root, seedId, plan, async ({ port, role }) => {
		const flood = child(["--client", root, role("flood", attackers)]);
		// Let the flood reach full speed before the measured passes start.
		await new Promise((resolve) => setTimeout(resolve, plan.floodMs));
		const legit = await legitimatePasses(root, seedId, port, plan.passes, 2);
		const done = next(flood, "done");
		flood.send({ type: "stop" });
		const counts = await done;
		return {
			...legit,
			attackerOk: counts.ok,
			attackerFailed: counts.failed,
			attackerErrors: counts.errors,
		};
	});
}

async function holdScenario(root: string, seedId: string, plan: Plan, attackers: number[]) {
	return scenario(root, seedId, plan, async ({ port, role }) => {
		const holder = child([
			"--client",
			root,
			role("hold", attackers, { workers: plan.holdStreams }),
		]);
		const held = await next(holder, "held");
		const legit = await legitimatePasses(root, seedId, port, plan.passes, 3);
		holder.kill();
		return { ...legit, heldStreams: held.streams };
	});
}

/** Peers behind one address start their passes together, or spread over spreadMs. */
async function natScenario(
	root: string,
	seedId: string,
	plan: Plan,
	peers: number[],
	spreadMs: number,
) {
	return scenario(root, seedId, plan, async ({ role }) => {
		const nat = child(["--client", root, role("sync", peers, { spreadMs })]);
		const passes = (await next(nat, "done")).passes as {
			ms: number;
			ok: boolean;
			error: string | null;
		}[];
		const times = passes.filter((pass) => pass.ok).map((pass) => pass.ms);
		const errors = [...new Set(passes.flatMap((pass) => (pass.error ? [pass.error] : [])))];
		return {
			peers: passes.length,
			failed: passes.length - times.length,
			p95: percentile(times, 0.95),
			errors,
		};
	});
}

async function runPlan(root: string, seedId: string, plan: Plan) {
	const attackers = Array.from({ length: plan.attackers }, (_, i) => i + LEGITIMATE_PEERS);
	const natPeers = Array.from(
		{ length: plan.natPeers },
		(_, i) => i + LEGITIMATE_PEERS + plan.attackers,
	);
	return {
		name: plan.name,
		limits: plan.limits,
		idle: await scenario(root, seedId, plan, ({ port }) =>
			legitimatePasses(root, seedId, port, plan.passes, 1),
		),
		flood: await floodScenario(root, seedId, plan, attackers),
		hold: await holdScenario(root, seedId, plan, attackers),
		natBurst: await natScenario(root, seedId, plan, natPeers, 0),
		natSpread: await natScenario(root, seedId, plan, natPeers, plan.natSpreadMs),
	};
}

const DEFAULT_PLANS: Plan[] = [
	{
		name: "caps off",
		limits: { listener: { maxSockets: null, maxSocketsPerIp: null, requestsPerIpPerMinute: null } },
		attackers: 8,
		workers: 8,
		holdStreams: 8,
		natPeers: 32,
		passes: 40,
		floodMs: 2_000,
		natSpreadMs: 10_000,
	},
	{
		name: "default caps",
		limits: {},
		attackers: 8,
		workers: 8,
		holdStreams: 8,
		natPeers: 32,
		passes: 40,
		floodMs: 2_000,
		natSpreadMs: 10_000,
	},
];

async function runDriver(configPath: string | undefined): Promise<void> {
	const plans: Plan[] = configPath
		? (JSON.parse(readFileSync(configPath, "utf8")) as Plan[])
		: DEFAULT_PLANS;
	const peerCount =
		LEGITIMATE_PEERS + Math.max(...plans.map((plan) => plan.attackers + plan.natPeers));
	const root = mkdtempSync(join(tmpdir(), "codemem-sync-load-"));
	try {
		const seedId = prepare(root, peerCount);
		const reports = [];
		for (const plan of plans) reports.push(await runPlan(root, seedId, plan));
		process.stdout.write(`${JSON.stringify({ node: process.version, reports }, null, 2)}\n`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ---- entry ----

const [role, root, extra] = process.argv.slice(2);
if (role === "--seed" && root) {
	await runSeed(root, JSON.parse(process.env.LOAD_LIMITS ?? "{}") as Limits);
} else if (role === "--client" && root && extra) {
	await runClient(root, JSON.parse(extra) as Message);
	// A holder stays until the driver kills it. Other roles are done.
	if (!String(extra).includes('"mode":"hold"')) process.exit(0);
} else {
	const configIndex = process.argv.indexOf("--config");
	await runDriver(configIndex > 0 ? process.argv[configIndex + 1] : undefined);
}
