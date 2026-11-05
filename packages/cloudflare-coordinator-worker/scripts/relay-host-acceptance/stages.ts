// The acceptance stages every relay host must pass, unchanged between hosts.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { getSyncChannelProgress } from "../../../core/src/sync-channel-progress.js";
import { runSyncPass } from "../../../core/src/sync-pass.js";
import { emit, type Fixture, GROUPS, type RelayHostUnderTest } from "./common.js";
import { core, createViewerRelayReachability, relayConfig, seedMemory, type Store, titles } from "./device.js";
import type { Front } from "./front.js";

type Relay = NonNullable<ReturnType<typeof createViewerRelayReachability>>;
type PassResult = Awaited<ReturnType<typeof runSyncPass>>;

export interface PeerHandle {
	readonly deviceId: string;
	control(action: string, params?: Record<string, string>): Promise<Record<string, unknown>>;
}

export interface StageContext {
	readonly host: RelayHostUnderTest;
	readonly front: Front;
	readonly fixture: Fixture;
	readonly store: Store;
	readonly b: PeerHandle;
	readonly c: PeerHandle;
	readonly logs: string[];
	relay: Relay;
	readonly results: Record<string, unknown>;
}

type RemoteStatus = { work: string[]; all: { scope_id: string; title: string }[] };

export function newRelay(ctx: Pick<StageContext, "store" | "fixture" | "logs">): Relay {
	const relay = createViewerRelayReachability({
		store: ctx.store,
		config: relayConfig(ctx.fixture.origin, GROUPS),
		log: (line) => ctx.logs.push(line),
	});
	assert(relay, "relay reachability not built");
	return relay;
}

export function summary(result: PassResult) {
	return { ok: result.ok, transport: result.transport, error: result.error, opsIn: result.opsIn, opsOut: result.opsOut };
}

export async function refreshAll(ctx: StageContext, peer: PeerHandle): Promise<void> {
	const { refreshMembership } = await import("./device.js");
	await refreshMembership(ctx.store, ctx.fixture, GROUPS);
	await peer.control("refresh");
}

/** One daemon-style pass: refresh membership, re-resolve relay, then direct with relay fallback. */
export async function pass(ctx: StageContext, peer: PeerHandle, options: { directOnly?: boolean; scope?: string; deadlineMs?: number } = {}) {
	await refreshAll(ctx, peer);
	await ctx.relay.refresh();
	const route = options.directOnly ? undefined : ctx.relay.reachability.forPeer(ctx.store.db, peer.deviceId);
	return runSyncPass(ctx.store.db, peer.deviceId, {
		keysDir: process.env.CODEMEM_KEYS_DIR,
		dbPath: ctx.store.dbPath,
		scanner: ctx.store.scanner,
		reachability: route && {
			...route,
			scopeId: options.scope ?? route.scopeId,
			deadlineMs: performance.now() + (options.deadlineMs ?? 30000),
		},
	});
}

const seedLocal = (ctx: StageContext, receiver: string, title: string, scope: string) =>
	seedMemory(ctx.store, ctx.fixture.ids.source.deviceId, receiver, title, scope);

function expectOk(result: PassResult, transport: string, label: string) {
	assert(result.ok && result.transport === transport, `${label}: ${JSON.stringify(summary(result))}`);
}

export async function healthReady(ctx: StageContext): Promise<void> {
	const deadline = performance.now() + 9 * 60_000;
	for (;;) {
		const rows = await ctx.host.readiness();
		if (rows.length === GROUPS.length + 1 && rows.every((row) => row.state === "ready")) break;
		assert(performance.now() < deadline, `health deadline: ${JSON.stringify(rows)}`);
		await delay(10_000);
	}
	await ctx.relay.refresh();
	assert.deepEqual(Object.fromEntries(ctx.relay.status()), { "team-a": "ready", "team-b": "ready" }, ctx.logs.join(" | "));
	emit("health-ready");
}

export async function directBaseline(ctx: StageContext): Promise<void> {
	await ctx.b.control("target-on");
	await ctx.b.control("seed", { title: "baseline" });
	expectOk(await pass(ctx, ctx.b), "direct", "direct baseline");
	assert(titles(ctx.store, "work-a").includes("baseline"));
	emit("direct-baseline");
}

/** Direct fails, so relay carries pull and push; the ACK completes and other scopes stay home. */
export async function relayConvergence(ctx: StageContext): Promise<void> {
	await ctx.b.control("direct-off");
	await ctx.b.control("seed", { title: "relay-remote" });
	seedLocal(ctx, ctx.b.deviceId, "relay-local", "work-a");
	seedLocal(ctx, ctx.b.deviceId, "personal-only", "personal-a");
	seedLocal(ctx, ctx.b.deviceId, "local-only", "local-default");
	const relayed = await pass(ctx, ctx.b);
	expectOk(relayed, "relay", "relay convergence");
	assert(relayed.opsIn >= 1 && relayed.opsOut >= 1, JSON.stringify(summary(relayed)));
	const ack = getSyncChannelProgress(ctx.store.db, ctx.b.deviceId, "work-a")?.last_acked_cursor;
	assert(ack?.includes("relay-local-op"), "outbound ACK");
	const remote = (await ctx.b.control("status")) as RemoteStatus;
	assert.deepEqual(titles(ctx.store, "work-a"), remote.work);
	assert.deepEqual(remote.all.filter((row) => row.scope_id !== "work-a"), []);
	emit("relay-convergence-isolation-ack", summary(relayed));
}

/** A Space the target is not a member of is refused over relay, with nothing applied. */
export async function unauthorizedSpace(ctx: StageContext): Promise<void> {
	const before = (await ctx.b.control("status")) as RemoteStatus;
	await delay(6500);
	const denied = await pass(ctx, ctx.b, { scope: "personal-a" });
	assert(!denied.ok && denied.transport === "relay", JSON.stringify(summary(denied)));
	const after = (await ctx.b.control("status")) as RemoteStatus;
	assert.deepEqual([after.work, after.all], [before.work, before.all], "denied pass changed the target");
	await delay(6500);
	expectOk(await pass(ctx, ctx.b), "relay", "authorized pass after denial");
	ctx.results.unauthorized = summary(denied);
	emit("unauthorized-space", { denied: ctx.results.unauthorized });
}

/** A device enrolled only in team B cannot register with team A's realm. */
export async function foreignRealm(ctx: StageContext): Promise<void> {
	const attempt = (await ctx.c.control("foreign-register")) as { registered: boolean; reason?: string };
	assert.equal(attempt.registered, false, JSON.stringify(attempt));
	ctx.results.foreignRealm = attempt.reason;
	emit("foreign-realm-denied", { reason: attempt.reason });
}

/** Team B relays through its own realm, and team A's realm carries none of it. */
export async function secondTeam(ctx: StageContext): Promise<void> {
	await ctx.c.control("target-on");
	await ctx.c.control("direct-off");
	await ctx.c.control("seed", { title: "team-b-remote" });
	seedLocal(ctx, ctx.c.deviceId, "team-b-local", "work-b");
	const proxyA = ctx.front.proxy("team-a").events.length;
	const result = await pass(ctx, ctx.c);
	expectOk(result, "relay", "second team");
	const remote = (await ctx.c.control("status")) as RemoteStatus;
	assert.deepEqual(remote.all.filter((row) => row.scope_id !== "work-b"), []);
	assert(remote.work.includes("team-b-local") && titles(ctx.store, "work-b").includes("team-b-remote"));
	assert.equal(ctx.front.proxy("team-a").events.length, proxyA, "team A's realm saw team B traffic");
	emit("second-team-realm", summary(result));
}

/** An offline target gets nothing queued; cursor and ACK hold; reconnect repairs. */
export async function offlineDrop(ctx: StageContext): Promise<void> {
	await ctx.b.control("target-off");
	await delay(6500);
	seedLocal(ctx, ctx.b.deviceId, "offline-pending", "work-a");
	const ack = getSyncChannelProgress(ctx.store.db, ctx.b.deviceId, "work-a")?.last_acked_cursor;
	const cursor = core.getReplicationCursor(ctx.store.db, ctx.b.deviceId, "work-a");
	const offline = await pass(ctx, ctx.b);
	assert(!offline.ok, JSON.stringify(summary(offline)));
	assert.deepEqual(core.getReplicationCursor(ctx.store.db, ctx.b.deviceId, "work-a"), cursor);
	assert.equal(getSyncChannelProgress(ctx.store.db, ctx.b.deviceId, "work-a")?.last_acked_cursor, ack);
	const idle = await ctx.host.counters("team-a");
	assert(idle && idle.routes === 0 && idle.queuedBytes === 0, JSON.stringify(idle));
	await ctx.b.control("target-on");
	await delay(1500);
	assert(!((await ctx.b.control("status")) as RemoteStatus).work.includes("offline-pending"), "queued delivery");
	await delay(5000);
	expectOk(await pass(ctx, ctx.b), "relay", "reconnect repair");
	assert(((await ctx.b.control("status")) as RemoteStatus).work.includes("offline-pending"));
	ctx.results.offline = summary(offline);
	emit("offline-drop-no-queue-recovery", { offline: ctx.results.offline });
}
