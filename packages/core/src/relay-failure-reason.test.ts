import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeerHttpExecutor } from "./peer-http-client.js";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import { decodeRelayCheckPacket } from "./relay-admission-codec.js";
import {
	asRelayFailure,
	createRelayFailureRecorder,
	RELAY_FAILURE_REASONS,
	RelayFailure,
	relayFailureReason,
} from "./relay-failure-reason.js";
import type { RelayPeerClientOptions } from "./relay-peer-client.js";
import {
	type RelayClientTestOptions,
	relayClientFixture,
	relayDeadline,
} from "./relay-peer-client-test-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("relay failure reason mapping", () => {
	it.each(RELAY_FAILURE_REASONS)("keeps the tagged reason %s", (reason) => {
		// Act.
		const mapped = relayFailureReason(new RelayFailure(reason, "x"), "relay_unavailable");
		// Assert.
		expect(mapped).toBe(reason);
	});

	it.each([
		["deadline", "relay_expired"],
		["cancelled", "relay_expired"],
		["transport", "relay_handshake_failed"],
		["framing", "relay_handshake_failed"],
	] as const)("maps an executor %s error to %s before authentication", (code, reason) => {
		// Act: routes pass the handshake fallback until Noise authenticates.
		const mapped = relayFailureReason(new PeerHttpExchangeError(code), "relay_handshake_failed");
		// Assert: only time-based executor failures override the caller's phase fallback.
		expect(mapped).toBe(reason);
	});

	it.each([new Error("Noise decrypt failed"), "not an error", undefined])(
		"uses the phase fallback for the untagged value %s",
		(value) => {
			// Act.
			const mapped = relayFailureReason(value, "relay_handshake_failed");
			// Assert.
			expect(mapped).toBe("relay_handshake_failed");
		},
	);

	it("tags untagged errors without changing their message and passes tagged errors through", () => {
		// Arrange.
		const tagged = new RelayFailure("relay_rejected", "rejected");
		// Act.
		const fromUntagged = asRelayFailure(new Error("socket closed"), "relay_unavailable");
		// Assert.
		expect(fromUntagged).toMatchObject({ reason: "relay_unavailable", message: "socket closed" });
		expect(asRelayFailure(tagged, "relay_unavailable")).toBe(tagged);
	});

	it("documents every reason code in the relay runtime guide", () => {
		// Arrange.
		const guide = readFileSync(new URL("../../../docs/relay-runtime.md", import.meta.url), "utf8");
		// Assert.
		for (const reason of RELAY_FAILURE_REASONS) expect(guide).toContain(`| \`${reason}\` |`);
	});
});

describe("relay failure recorder", () => {
	it("keeps the first terminal reason across repeated and reordered failures", () => {
		// Arrange.
		const recorder = createRelayFailureRecorder();
		// Act.
		recorder.record("relay_rejected");
		recorder.record("relay_aborted");
		recorder.record("relay_rejected");
		recorder.record("relay_unavailable");
		// Assert.
		expect(recorder.reason()).toBe("relay_rejected");
	});

	it("reports no reason before any failure", () => {
		// Assert.
		expect(createRelayFailureRecorder().reason()).toBeUndefined();
	});
});

/** Opens one source route with client overrides and returns the factory's recorded reason. */
async function openReason(
	overrides: Partial<RelayPeerClientOptions>,
	options: RelayClientTestOptions = {},
) {
	const f = await relayClientFixture(undefined, undefined, options);
	cleanups.push(() => f.dispose());
	await f.client("target").connect(new AbortController().signal, relayDeadline());
	const factory = f.client("source", overrides).factory("target", f.identities.target.expectedPin);
	const opening = factory.open({
		signal: new AbortController().signal,
		deadlineMs: performance.now() + 3000,
	});
	await expect(opening).rejects.toThrow();
	return factory.failureReason();
}

describe("relay malformed authenticated responses", () => {
	it.each([
		["HTTP/1.0", "HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok", "framing"],
		["a status above 599", "HTTP/1.1 600 Odd\r\nContent-Length: 2\r\n\r\nok", "framing"],
		[
			"an oversized Content-Length",
			"HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n",
			"response_too_large",
		],
	])(
		"records %s from a Noise-authenticated target as relay_record_invalid",
		async (_name, raw, code) => {
			// Arrange: the target writes a well-encrypted response that is not valid peer HTTP.
			const f = await relayClientFixture();
			cleanups.push(() => f.dispose());
			const target = f.client("target", {
				onInbound: async (connection) => {
					connection.duplex.resume();
					connection.duplex.end(Buffer.from(raw));
					await connection.completion.catch(() => {});
				},
			});
			await target.connect(new AbortController().signal, relayDeadline());
			const factory = f.client("source").factory("target", f.identities.target.expectedPin);
			const execute = createPeerHttpExecutor({ factory });
			// Act.
			const result = execute("GET", "https://peer.invalid/marker");
			// Assert: the caller still sees the generic executor error, and the route did not expire.
			await expect(result).rejects.toMatchObject({ name: "PeerHttpExchangeError", code });
			await vi.waitFor(() => expect(f.runtime.counters().routes).toBe(0));
			expect(factory.failureReason()).toBe("relay_record_invalid");
		},
		15000,
	);
});

describe("relay client local failure origins", () => {
	it("records relay_unavailable when local route capacity stays full for three seconds", async () => {
		// Arrange: one source route per peer is active, so a second open waits for capacity.
		const f = await relayClientFixture();
		cleanups.push(() => f.dispose());
		const target = f.client("target", { onInbound: async (connection) => connection.completion });
		await target.connect(new AbortController().signal, relayDeadline());
		const source = f.client("source");
		const owner = await source
			.factory("target", f.identities.target.expectedPin)
			.open({ signal: new AbortController().signal, deadlineMs: relayDeadline() });
		const factory = source.factory("target", f.identities.target.expectedPin);
		// Act: the caller's signal stays live and its deadline is later than the 3 s cap.
		const waiting = factory.open({
			signal: new AbortController().signal,
			deadlineMs: performance.now() + 7000,
		});
		// Assert.
		await expect(waiting).rejects.toThrow("Relay capacity exhausted");
		expect(factory.failureReason()).toBe("relay_unavailable");
		await owner.dispose(new Error("Capacity test complete"));
	}, 15000);

	it("records relay_disabled when the operator switch is off", async () => {
		// Act.
		const reason = await openReason({ enabled: false });
		// Assert.
		expect(reason).toBe("relay_disabled");
	}, 15000);

	it("records relay_peer_revoked when the peer pin is no longer current", async () => {
		// Act.
		const reason = await openReason({ resolvePeerPin: () => null });
		// Assert.
		expect(reason).toBe("relay_peer_revoked");
	}, 15000);

	it("records relay_admission_failed when the source coordinator check fails", async () => {
		// Arrange: only the source's own check fails. Registration checks pass.
		const options: RelayClientTestOptions = {
			beforeCheck: async ({ packet }) => {
				const check = decodeRelayCheckPacket(packet);
				if (check.kind === "admission" && check.value.role === "source")
					throw new Error("coordinator unreachable");
			},
		};
		// Act.
		const reason = await openReason({}, options);
		// Assert.
		expect(reason).toBe("relay_admission_failed");
	}, 15000);
});
