// Fault, counter and disablement stages. Fault reasons match the Node relay's
// relay-fault-proxy.test.ts values for the same faults.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { encodeRelayControl } from "../../../core/src/relay-control-codec.js";
import type { RelayFaultFrame, RelayFaultRule } from "../../../core/src/relay-fault-proxy-test-fixtures.js";
import { runSyncPass } from "../../../core/src/sync-orchestration.js";
import { emit, GROUPS } from "./common.js";
import { seedMemory, titles } from "./device.js";
import { newRelay, pass, refreshAll, type StageContext, summary } from "./stages.js";

type Match = (frame: RelayFaultFrame, fresh: boolean) => boolean;

interface FaultCase {
	readonly name: string;
	readonly match: Match;
	readonly action: ReturnType<RelayFaultRule>;
	readonly reason: string;
	/** Applies to every matching frame instead of only the first. */
	readonly every?: boolean;
	readonly deadlineMs?: number;
}

const toRejected = {
	type: "substitute",
	bytes: (original: Buffer) => {
		const { session } = JSON.parse(original.toString()) as { session: string };
		return encodeRelayControl({ v: 1, type: "REJECTED", session, body: {} });
	},
} as const;

const CASES: readonly FaultCase[] = [
	{
		name: "handshake dropped",
		match: (frame, fresh) => fresh && frame.direction === "toRelay",
		action: { type: "drop" },
		reason: "relay_unavailable",
		every: true,
	},
	{
		name: "truncated DATA",
		match: (frame, fresh) => fresh && frame.direction === "toPeer" && frame.kind === "data",
		action: { type: "truncate", keep: 40 },
		reason: "relay_frame_invalid",
	},
	{
		name: "ACCEPTED substituted with REJECTED",
		match: (frame, fresh) => fresh && frame.direction === "toPeer" && frame.kind === "control" && frame.type === "ACCEPTED",
		action: toRejected,
		reason: "relay_rejected",
	},
	{
		// The relay's OPEN toward the target is lost, so the source waits out its deadline.
		name: "dropped OPEN",
		match: (frame, fresh) => !fresh && frame.direction === "toPeer" && frame.kind === "control" && frame.type === "OPEN",
		action: { type: "drop" },
		reason: "relay_expired",
		deadlineMs: 10_000,
	},
];

/** A rule for team A's proxy. Sockets opened from `firstFresh` on belong to the new source client. */
function caseRule(fault: FaultCase, firstFresh: number): RelayFaultRule {
	let fired = false;
	return (frame) => {
		if (fired && !fault.every) return undefined;
		if (!fault.match(frame, frame.socket >= firstFresh)) return undefined;
		fired = true;
		return fault.action;
	};
}

async function runCase(ctx: StageContext, fault: FaultCase): Promise<string | undefined> {
	// Every new client registers, and a device may register twice a minute per group.
	await delay(31_000);
	await refreshAll(ctx, ctx.b);
	const proxy = ctx.front.proxy("team-a");
	const firstFresh = proxy.events.reduce((max, event) => Math.max(max, event.socket + 1), 0);
	ctx.front.setFault("team-a", caseRule(fault, firstFresh));
	const relay = newRelay(ctx);
	try {
		await relay.refresh();
		const route = relay.reachability.forPeer(ctx.store.db, ctx.b.deviceId);
		assert(route, `${fault.name}: no relay route`);
		const result = await runSyncPass(ctx.store.db, ctx.b.deviceId, {
			keysDir: process.env.CODEMEM_KEYS_DIR,
			dbPath: ctx.store.dbPath,
			scanner: ctx.store.scanner,
			reachability: { ...route, deadlineMs: performance.now() + (fault.deadlineMs ?? 20_000) },
		});
		assert(!result.ok && result.transport === "relay", `${fault.name}: ${JSON.stringify(summary(result))}`);
		assert.equal(result.error, `scoped channel exchange failed: ${fault.reason}`, fault.name);
		return result.error;
	} finally {
		ctx.front.setFault("team-a", undefined);
		await relay.close();
	}
}

export async function faultCases(ctx: StageContext): Promise<void> {
	await ctx.relay.close();
	seedMemory(ctx.store, ctx.fixture.ids.source.deviceId, ctx.b.deviceId, "fault-pending", "work-a");
	const faults: Record<string, string | undefined> = {};
	for (const fault of CASES) faults[fault.name] = await runCase(ctx, fault);
	assert.equal(ctx.front.proxy("team-a").held(), 0, "proxy still holds frames");
	ctx.relay = newRelay(ctx);
	await delay(31_000);
	const recovered = await pass(ctx, ctx.b);
	assert(recovered.ok && recovered.transport === "relay", JSON.stringify(summary(recovered)));
	assert(((await ctx.b.control("status")) as { work: string[] }).work.includes("fault-pending"));
	ctx.results.faults = faults;
	emit("fault-cases-recovery", { faults });
}

export async function quotaCounters(ctx: StageContext): Promise<void> {
	const counters = Object.fromEntries(
		await Promise.all(GROUPS.map(async (groupId) => [groupId, await ctx.host.counters(groupId)] as const)),
	);
	for (const value of Object.values(counters))
		assert.equal(value?.trafficQuotaAborts, 0, JSON.stringify(counters));
	ctx.results.counters = counters;
	emit("counters", counters);
}

/** The operator switch stops relay for the realm, and direct sync still works without it. */
export async function disableThenDirect(ctx: StageContext): Promise<void> {
	await ctx.host.disableRealm("team-a");
	await delay(6500);
	const disabled = await pass(ctx, ctx.b);
	assert(!disabled.ok, JSON.stringify(summary(disabled)));
	await ctx.b.control("direct-on");
	await ctx.b.control("seed", { title: "kill-direct" });
	const direct = await pass(ctx, ctx.b, { directOnly: true });
	assert(direct.ok && titles(ctx.store, "work-a").includes("kill-direct"), JSON.stringify(summary(direct)));
	ctx.results.disabled = summary(disabled);
	emit("relay-disabled-direct-only", { disabled: ctx.results.disabled });
}
