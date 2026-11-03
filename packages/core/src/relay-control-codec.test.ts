import { describe, expect, it } from "vitest";
import {
	decodeRelayControl,
	encodeRelayControl,
	type RelayControl,
} from "./relay-control-codec.js";
import { bytes, SESSION } from "./relay-server-test-fixtures.js";

const message = { v: 1, type: "CLOSE", session: SESSION, body: { mode: "end" } } as const;
describe("relay canonical controls", () => {
	it.each(["end", "abort"] as const)("round trips exact CLOSE %s", (mode) => {
		// Arrange
		const value = { ...message, body: { mode } };
		// Act
		const decoded = decodeRelayControl(bytes(encodeRelayControl(value)));
		// Assert
		expect(decoded).toEqual(value);
	});
	it.each(["ACCEPTED", "REJECTED", "SOCKET_CHALLENGE"] as const)(
		"accepts empty %s bodies",
		(type) => {
			// Arrange
			const value = { ...message, type, body: {} };
			// Act
			const decoded = decodeRelayControl(bytes(encodeRelayControl(value)));
			// Assert
			expect(decoded).toEqual(value);
		},
	);
	it.each([
		["version", { ...message, v: 2 }],
		["unknown method", { ...message, type: "PING" }],
		["uppercase session", { ...message, session: "A".repeat(32) }],
		["short session", { ...message, session: "e" }],
		["extra header", { ...message, direction: "source" }],
		["extra close field", { ...message, body: { mode: "end", extra: true } }],
		["missing close mode", { ...message, body: {} }],
		["unknown close mode", { ...message, body: { mode: "eof" } }],
		["accepted data", { ...message, type: "ACCEPTED", body: { ok: true } }],
		["rejected reason", { ...message, type: "REJECTED", body: { reason: "offline" } }],
		["array body", { ...message, body: [] }],
		["null body", { ...message, body: null }],
		[
			"raw realm",
			{
				...message,
				type: "REGISTERED",
				body: {
					deviceId: "source",
					keyId: "a".repeat(64),
					authorityId: "b".repeat(64),
					realmId: "group-A",
					remainingMs: 900000,
				},
			},
		],
	])("rejects %s", (_name, value) => {
		// Arrange
		const wire = bytes(JSON.stringify(value));
		// Act / Assert
		expect(() => decodeRelayControl(wire)).toThrow();
		expect(() => encodeRelayControl(value as RelayControl)).toThrow();
	});
	it.each([
		["whitespace", ` ${JSON.stringify(message)}`],
		["duplicate keys", JSON.stringify(message).replace('"v":1', '"v":1,"v":1')],
		[
			"field order",
			JSON.stringify({ type: message.type, v: 1, session: SESSION, body: message.body }),
		],
		["alternate numeric form", JSON.stringify(message).replace('"v":1', '"v":1.0')],
		["oversize", " ".repeat(4097)],
		["invalid JSON", "{"],
	])("rejects noncanonical %s", (_name, text) => {
		// Arrange
		const wire = bytes(text);
		// Act / Assert
		expect(() => decodeRelayControl(wire)).toThrow();
	});
	it.each([
		new Uint8Array([0xff]),
		new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(JSON.stringify(message))]),
	])("rejects invalid UTF-8 or BOM", (wire) => {
		// Arrange / Act / Assert
		expect(() => decodeRelayControl(wire)).toThrow();
	});
});
