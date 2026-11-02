import { Buffer } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTraversalSignalCarrier } from "./peer-traversal-carrier.js";
import {
	common,
	signalEnvelope,
	signalPacket,
} from "./peer-traversal-coordinator-client-test-fixtures.js";
import {
	encodeTraversalSignalBody,
	encodeTraversalSignalPacket,
} from "./peer-traversal-signal-codec.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});
const options = () => ({ sessionId: common.sessionId, deadlineMs: 55000 });

it.each(["traversal-offer", "traversal-answer"] as const)(
	"copies and freezes %s, then delivers once",
	(type) => {
		// Arrange
		const carrier = createTraversalSignalCarrier(options(), { now: () => 0 });
		const envelope = signalEnvelope(type);
		const expected = structuredClone(envelope);
		// Act
		const published = carrier?.publish(envelope);
		envelope.packets[0].body = "changed";
		envelope.packets.reverse();
		const taken = carrier?.take(type);
		// Assert
		expect(published).toBe(true);
		expect(taken).toEqual(expected);
		expect(Object.isFrozen(taken)).toBe(true);
		expect(Object.isFrozen(taken?.packets)).toBe(true);
		expect(taken?.packets.every(Object.isFrozen)).toBe(true);
		expect(carrier?.take(type)).toBeNull();
		expect(carrier?.publish(expected)).toBe(false);
		carrier?.close();
	},
);

it("keeps the two slots independent and never reuses either", () => {
	// Arrange
	const carrier = createTraversalSignalCarrier(options(), { now: () => 0 });
	// Act
	const first = carrier?.publish(signalEnvelope());
	const duplicate = carrier?.publish(signalEnvelope());
	const second = carrier?.publish(signalEnvelope("traversal-answer"));
	// Assert
	expect([first, duplicate, second]).toEqual([true, false, true]);
	expect(carrier?.take("traversal-answer")?.type).toBe("traversal-answer");
	expect(carrier?.take("traversal-offer")?.type).toBe("traversal-offer");
	carrier?.close();
});

const badEnvelopes: unknown[] = [
	null,
	"v=0 SDP",
	{},
	{ ...signalEnvelope(), v: 2 },
	{ ...signalEnvelope(), type: "approval" },
	{ ...signalEnvelope(), ok: true },
	{ ...signalEnvelope(), packets: [] },
	{ ...signalEnvelope(), packets: [signalPacket()] },
	{ ...signalEnvelope(), packets: [signalPacket(), signalPacket("offer"), signalPacket("answer")] },
	{ ...signalEnvelope(), packets: [signalPacket("offer"), signalPacket()] },
	{ ...signalEnvelope(), packets: [signalPacket(), signalPacket("answer")] },
	{ ...signalEnvelope(), packets: [{ ...signalPacket(), approval: true }, signalPacket("offer")] },
	{
		...signalEnvelope(),
		packets: [{ ...signalPacket(), signature: "bad" }, signalPacket("offer")],
	},
	{
		...signalEnvelope(),
		packets: [{ ...signalPacket(), body: "A".repeat(40000) }, signalPacket("offer")],
	},
];
it.each(badEnvelopes)("rejects malformed envelope %# without consuming its slot", (bad) => {
	// Arrange
	const carrier = createTraversalSignalCarrier(options(), { now: () => 0 });
	// Act
	const rejected = carrier?.publish(bad);
	const accepted = carrier?.publish(signalEnvelope());
	// Assert
	expect(rejected).toBe(false);
	expect(accepted).toBe(true);
	expect(carrier?.take("traversal-offer")).not.toBeNull();
	carrier?.close();
});

it("rejects both pair types from another session", () => {
	// Arrange
	const carrier = createTraversalSignalCarrier(
		{ ...options(), sessionId: "0".repeat(32) },
		{ now: () => 0 },
	);
	// Act
	const results = [
		carrier?.publish(signalEnvelope()),
		carrier?.publish(signalEnvelope("traversal-answer")),
	];
	// Assert
	expect(results).toEqual([false, false]);
	carrier?.close();
});

it("rejects reversed answer packets without consuming the answer slot", () => {
	// Arrange
	const carrier = createTraversalSignalCarrier(options(), { now: () => 0 });
	const answer = signalEnvelope("traversal-answer");
	answer.packets.reverse();
	// Act
	const results = [carrier?.publish(answer), carrier?.publish(signalEnvelope("traversal-answer"))];
	// Assert
	expect(results).toEqual([false, true]);
	carrier?.close();
});

it.each([16384, 16385])("enforces the description cap at %i bytes", (size) => {
	// Arrange: encode the valid boundary, then alter only the portable body for oversize input.
	const carrier = createTraversalSignalCarrier(options(), { now: () => 0 });
	const bodyBytes = encodeTraversalSignalBody({
		...common,
		phase: "offer",
		prepareDigest: "f".repeat(64),
		descriptionBytes: new Uint8Array(16384).fill(120),
	});
	const packet = encodeTraversalSignalPacket({
		bodyBytes,
		timestamp: "100",
		nonce: "3".repeat(32),
		signatureBytes: new Uint8Array(64),
	});
	const fields: unknown[] = JSON.parse(new TextDecoder().decode(bodyBytes));
	fields[13] = Buffer.alloc(size, 120).toString("base64url");
	packet.body = Buffer.from(JSON.stringify(fields)).toString("base64url");
	// Act
	const accepted = carrier?.publish({ ...signalEnvelope(), packets: [signalPacket(), packet] });
	// Assert
	expect(accepted).toBe(size === 16384);
	carrier?.close();
});

it("closes and releases its timer when the clock throws", () => {
	// Arrange
	const now = vi
		.fn()
		.mockReturnValueOnce(0)
		.mockImplementation(() => {
			throw new Error("clock unavailable");
		});
	const carrier = createTraversalSignalCarrier(options(), { now });
	// Act
	const accepted = carrier?.publish(signalEnvelope());
	// Assert
	expect(accepted).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
});

it.each([
	{ sessionId: "D".repeat(32) },
	{ sessionId: "d".repeat(31) },
	{ deadlineMs: 0 },
	{ deadlineMs: 55001 },
	{ deadlineMs: Number.NaN },
])("rejects invalid constructor options %# without timer", (patch) => {
	// Arrange
	const input = { ...options(), ...patch };
	// Act
	const carrier = createTraversalSignalCarrier(input, { now: () => 0 });
	// Assert
	expect(carrier).toBeNull();
	expect(vi.getTimerCount()).toBe(0);
});

it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("rejects invalid initial clock %s", (value) => {
	// Arrange
	const now = () => value;
	// Act
	const carrier = createTraversalSignalCarrier(options(), { now });
	// Assert
	expect(carrier).toBeNull();
	expect(vi.getTimerCount()).toBe(0);
});

it("automatically releases its timer and closes at the local deadline", () => {
	// Arrange: a constant injected clock cannot prolong the owned timer.
	const carrier = createTraversalSignalCarrier({ ...options(), deadlineMs: 10 }, { now: () => 0 });
	carrier?.publish(signalEnvelope());
	// Act
	vi.advanceTimersByTime(10);
	// Assert
	expect(vi.getTimerCount()).toBe(0);
	expect(carrier?.take("traversal-offer")).toBeNull();
	expect(carrier?.publish(signalEnvelope("traversal-answer"))).toBe(false);
});

it.each([55000, Number.NaN, -1, Number.POSITIVE_INFINITY])(
	"closes on expiry or unknown clock %s during access",
	(later) => {
		// Arrange
		let mono = 0;
		const carrier = createTraversalSignalCarrier(options(), { now: () => mono });
		carrier?.publish(signalEnvelope());
		// Act
		mono = later;
		const taken = carrier?.take("traversal-offer");
		mono = 0;
		// Assert
		expect(taken).toBeNull();
		expect(carrier?.publish(signalEnvelope("traversal-answer"))).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	},
);

it("closes permanently on clock rollback during publish", () => {
	// Arrange
	let mono = 100;
	const carrier = createTraversalSignalCarrier(options(), { now: () => mono });
	carrier?.publish(signalEnvelope());
	// Act
	mono = 99;
	const published = carrier?.publish(signalEnvelope("traversal-answer"));
	// Assert
	expect(published).toBe(false);
	expect(carrier?.take("traversal-offer")).toBeNull();
	expect(vi.getTimerCount()).toBe(0);
});

it("owns constructor options and closes idempotently, dropping both pending slots", () => {
	// Arrange
	const input = options();
	const carrier = createTraversalSignalCarrier(input, { now: () => 0 });
	input.sessionId = "0".repeat(32);
	input.deadlineMs = 999999;
	const published = [
		carrier?.publish(signalEnvelope()),
		carrier?.publish(signalEnvelope("traversal-answer")),
	];
	// Act
	carrier?.close();
	carrier?.close();
	// Assert
	expect(published).toEqual([true, true]);
	expect(carrier?.take("traversal-offer")).toBeNull();
	expect(carrier?.take("traversal-answer")).toBeNull();
	expect(carrier?.publish(signalEnvelope())).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
});
