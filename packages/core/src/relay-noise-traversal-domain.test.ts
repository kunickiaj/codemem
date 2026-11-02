import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acceptRelayNoiseResponder,
	prepareRelayNoiseInitiator,
	type RelayNoiseOptions,
} from "./relay-noise.js";
import type { RelayNoiseContext } from "./relay-noise-identity.js";
import {
	disposableNoiseIdentity,
	orderedNoisePair,
	readNoiseBytes,
	writeNoiseBytes,
} from "./relay-noise-test-fixtures.js";

const dispose: (() => void)[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.spyOn(performance, "now").mockReturnValue(1000);
});

afterEach(async () => {
	for (const cleanup of dispose.splice(0).reverse()) cleanup();
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(
	initiatorLabel: RelayNoiseContext["transportLabel"],
	responderLabel: RelayNoiseContext["transportLabel"],
) {
	const pair = orderedNoisePair();
	const initiator = disposableNoiseIdentity();
	const responder = disposableNoiseIdentity();
	const sessionId = Buffer.alloc(16, 7);
	const options = {
		deadlineMs: 10000,
	} satisfies Partial<RelayNoiseOptions>;
	dispose.push(() => {
		for (const raw of pair.raw) raw.destroy();
	});
	const attempt = prepareRelayNoiseInitiator({
		...options,
		transport: pair.raw[0],
		localIdentity: initiator,
		expectedRemotePin: responder.expectedPin,
		context: { transportLabel: initiatorLabel, sessionId },
	});
	dispose.push(() => attempt.cancel());
	const accept = (verifiedMessageADigest: string) =>
		acceptRelayNoiseResponder({
			...options,
			transport: pair.raw[1],
			localIdentity: responder,
			expectedRemotePin: initiator.expectedPin,
			context: { transportLabel: responderLabel, sessionId },
			verifiedMessageADigest,
			acceptedAtMs: 1000,
		});
	return { pair, initiator, responder, attempt, accept };
}

describe("traversal Noise transport domain", () => {
	it("authenticates matching label 3 peers and exchanges an application request and response", async () => {
		const f = fixture(3, 3);
		const opening = await f.attempt.opening;
		const inbound = f.accept(opening.digest);

		f.attempt.release(1000);
		const [left, right] = await Promise.all([f.attempt.authenticated, inbound]);
		for (const peer of [left, right]) {
			peer.duplex.on("error", () => {});
			dispose.push(() => peer.duplex.destroy());
		}
		const request = readNoiseBytes(right.duplex, 7);
		await writeNoiseBytes(left.duplex, "request");
		const actualRequest = await request;
		const response = readNoiseBytes(left.duplex, 8);
		await writeNoiseBytes(right.duplex, "response");
		const actualResponse = await response;

		expect(left.observedPin).toBe(f.responder.expectedPin);
		expect(right.observedPin).toBe(f.initiator.expectedPin);
		expect(actualRequest.toString()).toBe("request");
		expect(actualResponse.toString()).toBe("response");
	});

	it.each([
		[3, 1],
		[3, 2],
		[1, 3],
		[2, 3],
	] as const)(
		"rejects initiator label %i against responder label %i before application exposure",
		async (initiatorLabel, responderLabel) => {
			const f = fixture(initiatorLabel, responderLabel);
			const opening = await f.attempt.opening;
			// Keep the admission digest correct so only the Noise prologue differs.
			const inbound = f.accept(opening.digest);
			const exposed = vi.fn();
			for (const authenticated of [f.attempt.authenticated, inbound]) {
				void authenticated.then(
					(peer) => {
						peer.duplex.on("error", () => {});
						dispose.push(() => peer.duplex.destroy());
						exposed();
					},
					() => {},
				);
			}

			f.attempt.release(1000);
			const outcomes = await Promise.allSettled([f.attempt.authenticated, inbound]);

			expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
			expect(exposed).not.toHaveBeenCalled();
		},
	);
});
