import { describe, expect, it } from "vitest";
import {
	isFreshDeviceRejoinStart,
	parseDeviceRejoinStartBody,
} from "./coordinator-device-rejoin-start-input.js";

const NOW = 1_791_028_800_000;
const WINDOW = 5 * 60 * 1000;
const request = {
	device_id: "fixture-device",
	public_key: "ssh-ed25519 fixture-key exact-text",
	attempt_id: "fixture-attempt",
	browser_start_hash: "1".repeat(64),
	loopback_redirect: "http://127.0.0.1:45765/codemem/auth/complete",
	timestamp_ms: NOW,
	signature: "synthetic-signature",
};
const encoder = new TextEncoder();
const parse = (body: unknown) => parseDeviceRejoinStartBody(encoder.encode(JSON.stringify(body)));
const invalid = { ok: false, error: "device_rejoin_invalid_input" };

describe("rejoin start body", () => {
	it.each(["127.0.0.1", "[::1]"])("preserves the exact signed fields for %s", (host) => {
		const loopback = `http://${host}:45765/codemem/auth/complete`;
		expect(parse({ ...request, loopback_redirect: loopback })).toEqual({
			ok: true,
			input: {
				deviceId: request.device_id,
				publicKey: request.public_key,
				attemptId: request.attempt_id,
				browserStartHash: request.browser_start_hash,
				loopbackRedirect: loopback,
				timestampMs: NOW,
				signature: request.signature,
			},
		});
	});

	it("applies the 4 KiB limit to bytes, including the exact boundary", () => {
		const json = JSON.stringify({ ...request, public_key: "clé 🔑" });
		const bytes = encoder.encode(json).byteLength;
		const atLimit = json.padEnd(json.length + 4096 - bytes, " ");
		expect(parseDeviceRejoinStartBody(encoder.encode(atLimit))).toMatchObject({ ok: true });
		expect(parseDeviceRejoinStartBody(encoder.encode(`${atLimit} `))).toEqual({
			ok: false,
			error: "body_too_large",
		});
	});

	it("rejects invalid UTF-8, invalid JSON, empty input, and non-object JSON", () => {
		expect(parseDeviceRejoinStartBody(Uint8Array.of(0xc3, 0x28))).toEqual(invalid);
		expect(parseDeviceRejoinStartBody(encoder.encode("{"))).toEqual(invalid);
		expect(parseDeviceRejoinStartBody(new Uint8Array())).toEqual(invalid);
		expect(parse(null)).toEqual(invalid);
		expect(parse([request])).toEqual(invalid);
	});

	it("rejects missing fields, extra fields, and client-supplied authority pins", () => {
		for (const name of Object.keys(request)) {
			const { [name as keyof typeof request]: _, ...incomplete } = request;
			expect(parse(incomplete)).toEqual(invalid);
		}
		for (const name of ["key_id", "origin", "coordinator_id", "identity_id", "operation"])
			expect(parse({ ...request, [name]: "untrusted" })).toEqual(invalid);
	});

	it.each([
		{ device_id: "" },
		{ device_id: " device" },
		{ attempt_id: "\u0000attempt" },
		{ public_key: [] },
		{ signature: {} },
		{ timestamp_ms: `${NOW}` },
		{ timestamp_ms: NOW + 0.5 },
		{ timestamp_ms: -1 },
		{ timestamp_ms: Number.MAX_SAFE_INTEGER + 1 },
		{ browser_start_hash: "G".repeat(64) },
		{ browser_start_hash: "A".repeat(64) },
		{ browser_start_hash: `${request.browser_start_hash}\n` },
	])("rejects malformed field %j", (patch) => {
		expect(parse({ ...request, ...patch })).toEqual(invalid);
	});

	it.each([
		"http://localhost:45765/codemem/auth/complete",
		"http://127.1:45765/codemem/auth/complete",
		"http://127.0.0.1:0/codemem/auth/complete",
		"http://127.0.0.1:65536/codemem/auth/complete",
		"http://127.0.0.1:45765/codemem/auth/complete?next=elsewhere",
		"http://127.0.0.1:45765/another/path",
	])("rejects redirects outside the established loopback shape: %s", (loopback_redirect) => {
		expect(parse({ ...request, loopback_redirect })).toEqual(invalid);
	});
});

describe("start signature freshness", () => {
	it("accepts start timestamps within five minutes in either direction", () => {
		expect(isFreshDeviceRejoinStart(NOW, NOW)).toBe(true);
		expect(isFreshDeviceRejoinStart(NOW - WINDOW, NOW)).toBe(true);
		expect(isFreshDeviceRejoinStart(NOW + WINDOW, NOW)).toBe(true);
		expect(isFreshDeviceRejoinStart(NOW - WINDOW - 1, NOW)).toBe(false);
		expect(isFreshDeviceRejoinStart(NOW + WINDOW + 1, NOW)).toBe(false);
	});

	it.each([-1, 0.2, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects an invalid timestamp or clock: %s",
		(value) => {
			expect(isFreshDeviceRejoinStart(value, NOW)).toBe(false);
			expect(isFreshDeviceRejoinStart(NOW, value)).toBe(false);
		},
	);
});
