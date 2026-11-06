import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createPeerHttpExecutor } from "./peer-http-client.js";
import { RelayAddressAllowances } from "./relay-address-allowance.js";
import { simulatedRelayPairPacing } from "./relay-pair-pacing-test-fixtures.js";
import type { RelayPeerClientOptions } from "./relay-peer-client.js";
import {
	type RelayClientTestOptions,
	relayClientFixture,
	relayDeadline,
} from "./relay-peer-client-test-fixtures.js";
import { createSqliteRelayQuota } from "./relay-quota-sqlite.js";
import { relayRealmId } from "./relay-service-proof.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture(options: RelayClientTestOptions = {}) {
	const clock = options.simulatedPairPacing ?? simulatedRelayPairPacing();
	const f = await relayClientFixture(undefined, undefined, {
		...options,
		simulatedPairPacing: clock,
	});
	cleanups.push(() => f.dispose());
	return { f, clock };
}

async function servingPair(
	f: Awaited<ReturnType<typeof relayClientFixture>>,
	overrides: Partial<RelayPeerClientOptions> = {},
) {
	const completions: Promise<void>[] = [];
	const target = f.client("target", {
		onInbound: async (connection, context) => {
			completions.push(connection.completion);
			await context.serve({
				origin: "https://peer.invalid",
				dispatch: async () => ({ status: 200, bodyBytes: Buffer.from("{}") }),
			});
		},
	});
	const source = f.client("source", overrides);
	await target.connect(new AbortController().signal, relayDeadline());
	const factory = source.factory("target", f.identities.target.expectedPin);
	return { factory, execute: createPeerHttpExecutor({ factory }), completions };
}

describe("simulated pair pacing clock", () => {
	it("advances pacing and quota UTC together without replacing native timers", async () => {
		// One bundle owns both elapsed-time readings.
		const clock = simulatedRelayPairPacing();
		const utc = clock.quotaUtcMs();
		await clock.pairPacing.delay(6000, new AbortController().signal);
		// Time advances rather than bypassing the pacing interval.
		expect(clock.pairPacing.monotonicMs()).toBe(6000);
		expect(clock.quotaUtcMs() - utc).toBe(6000);
	});

	it("does not advance either clock for an already aborted wait", async () => {
		const clock = simulatedRelayPairPacing();
		const utc = clock.quotaUtcMs();
		const abort = new AbortController();
		abort.abort();
		const waiting = clock.pairPacing.delay(6000, abort.signal);
		await expect(waiting).rejects.toThrow();
		expect(clock.pairPacing.monotonicMs()).toBe(0);
		expect(clock.quotaUtcMs()).toBe(utc);
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects an invalid elapsed interval %s without moving quota time",
		(milliseconds) => {
			const clock = simulatedRelayPairPacing();
			const utc = clock.quotaUtcMs();
			const advance = () => clock.advance(milliseconds);
			expect(advance).toThrow("Invalid simulated pacing interval");
			expect(clock.pairPacing.monotonicMs()).toBe(0);
			expect(clock.quotaUtcMs()).toBe(utc);
		},
	);
});

it("refills the real SQLite pair quota only after enough simulated time elapses", async () => {
	// Use the fixture's unchanged 20/minute, burst-two pair allocation.
	const { f, clock } = await fixture();
	const realmId = relayRealmId(f.namespace.authorityId, f.namespace.groupId);
	const quota = createSqliteRelayQuota({ database: f.quotaDb, realmId, enabled: true });
	const request = {
		purpose: "open" as const,
		realmId,
		deviceId: "source",
		peerDeviceId: "target",
		units: 1,
	};
	const reserve = () => quota.reserve(request, new AbortController().signal);
	// Consume the burst, stop one millisecond short, then reach the refill boundary.
	const burst = [await reserve(), await reserve()];
	const exhausted = await reserve();
	clock.advance(2999);
	const tooEarly = await reserve();
	clock.advance(1);
	const refilled = await reserve();
	const exhaustedAgain = await reserve();
	// Simulated time runs the actual transactional quota checks.
	expect(burst).toEqual(["reserved", "reserved"]);
	expect(exhausted).toBe("denied");
	expect(tooEarly).toBe("denied");
	expect(refilled).toBe("reserved");
	expect(exhaustedAgain).toBe("denied");
});

it("refills exactly one real address allowance after a simulated pair interval", async () => {
	// Consume this address's unchanged two-attempt burst.
	const clock = simulatedRelayPairPacing();
	const allowances = new RelayAddressAllowances(clock.pairPacing.monotonicMs);
	const burst = [allowances.take("192.0.2.1"), allowances.take("192.0.2.1")];
	// Attempts consume no virtual time until the pacing scheduler advances it.
	const exhausted = allowances.take("192.0.2.1");
	await clock.pairPacing.delay(6000, new AbortController().signal);
	const refilled = [allowances.take("192.0.2.1"), allowances.take("192.0.2.1")];
	const independent = [
		allowances.take("192.0.2.2"),
		allowances.take("192.0.2.2"),
		allowances.take("192.0.2.2"),
	];
	// Simulation preserves the rate, burst and separation between addresses.
	expect(burst).toEqual([true, true]);
	expect(exhausted).toBe(false);
	expect(refilled).toEqual([true, false]);
	expect(independent).toEqual([true, true, false]);
});

it("reanchors a full simulated interval when ACCEPTED arrives after OPEN", async () => {
	// Time advances in transit, without delaying the real socket scheduler.
	const clock = simulatedRelayPairPacing();
	const delay = vi.spyOn(clock.pairPacing, "delay");
	let accepted = false;
	const { f } = await fixture({
		simulatedPairPacing: clock,
		faultProxy: {
			rule: (frame) => {
				if (accepted || frame.socket !== 1 || frame.direction !== "toPeer") return;
				if (frame.kind !== "control" || frame.type !== "ACCEPTED") return;
				accepted = true;
				clock.advance(2000);
			},
		},
	});
	const pair = await servingPair(f);
	// The same client retains its pacing state across completed exchanges.
	const first = await pair.execute("GET", "https://peer.invalid/first");
	const second = await pair.execute("GET", "https://peer.invalid/second");
	await Promise.all(pair.completions);
	// Acceptance requires 6000 ms rather than the 4000 ms left from OPEN.
	expect([first, second]).toEqual([
		[200, {}],
		[200, {}],
	]);
	expect(accepted).toBe(true);
	expect(delay).toHaveBeenCalledExactlyOnceWith(6000, expect.any(AbortSignal));
	expect(clock.pairPacing.monotonicMs()).toBe(8000);
	expect(f.runtime.counters().routes).toBe(0);
});

it("keeps real signed admission and nonce receipts on native UTC after virtual time advances", async () => {
	// Refill budgets by ten simulated minutes without aging any proof or lease.
	const { f, clock } = await fixture();
	clock.advance(600_000);
	const before = Date.now();
	const pair = await servingPair(f);
	// Real registration and all three independent signed admission roles still run.
	const result = await pair.execute("GET", "https://peer.invalid/native-auth-time");
	await Promise.all(pair.completions);
	const after = Date.now();
	// Nonce creation stays inside the native operation's time range.
	expect(result).toEqual([200, {}]);
	const receipts = f.db.prepare("SELECT created_at FROM request_nonces").all() as {
		created_at: string;
	}[];
	expect(receipts).toHaveLength(5);
	for (const receipt of receipts) {
		const created = Date.parse(receipt.created_at);
		expect(created).toBeGreaterThanOrEqual(before);
		expect(created).toBeLessThanOrEqual(after);
		expect(created).toBeLessThan(clock.quotaUtcMs());
	}
});

it.each(["cancel", "deadline", "trust change"])(
	"blocks admission, OPEN and DATA after a %s during simulated pacing",
	async (mode) => {
		// Hold only the pacing delay, leaving socket and deadline timers native.
		const { f, clock } = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(async () => release.resolve());
		const delay = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
			entered.resolve();
			await release.promise;
			signal.throwIfAborted();
			clock.advance(milliseconds);
		});
		let trusted = true;
		const pair = await servingPair(f, {
			pairPacing: { monotonicMs: clock.pairPacing.monotonicMs, delay },
			validateLocal: () => trusted,
		});
		await pair.execute("GET", "https://peer.invalid/first");
		await Promise.all(pair.completions);
		const checks = f.checks.length;
		const wire = vi.spyOn(WebSocket.prototype, "send");
		const abort = new AbortController();
		// Enter pacing before cancelling, expiring, or revoking local trust.
		const opening = pair.factory.open({
			signal: abort.signal,
			deadlineMs: mode === "deadline" ? performance.now() + 500 : relayDeadline(),
		});
		const rejected = expect(opening).rejects.toThrow();
		await entered.promise;
		if (mode === "cancel") abort.abort();
		if (mode === "trust change") {
			trusted = false;
			release.resolve();
		}
		await rejected;
		// Native cancellation still fences an injected scheduler's pending promise.
		expect(f.checks).toHaveLength(checks);
		expect(delay.mock.calls[0]?.[1].aborted).toBe(true);
		for (const [message] of wire.mock.calls) {
			expect(message).not.toBeInstanceOf(Uint8Array);
			if (typeof message === "string") expect(JSON.parse(message).type).not.toBe("OPEN");
		}
		expect(f.runtime.counters().routes).toBe(0);
	},
);
