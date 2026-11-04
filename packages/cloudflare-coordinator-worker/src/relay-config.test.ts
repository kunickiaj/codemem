import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { relayEd25519KeyId } from "../../core/src/relay-ed25519.js";
import {
	captureRelayEnv,
	importRelayServiceSigner,
	RELAY_ENV_KEYS,
	readRelayConfig,
} from "./relay-config.js";

const admission = { fetch: async () => new Response(null) };
const valid = {
	CODEMEM_RELAY_ENABLED: "true",
	CODEMEM_RELAY_AUTHORITY_URL: "https://coordinator.example.test/sync",
	CODEMEM_RELAY_GROUPS: JSON.stringify(["group-a"]),
	CODEMEM_RELAY_SERVICE_KEY: "unused-by-config",
	CODEMEM_RELAY_ADMISSION_BINDING: "RELAY_ADMISSION",
	RELAY_ADMISSION: admission,
};
const config = (overrides: Record<string, unknown>) =>
	readRelayConfig(captureRelayEnv({ ...valid, ...overrides }));

describe("relay env capture", () => {
	it("copies only allowlisted keys and the named admission fetcher", () => {
		// Arrange
		const env = { ...valid, COORDINATOR_DB: { prepare: () => null }, OTHER_SECRET: "x" };
		// Act
		const snapshot = captureRelayEnv(env);
		// Assert
		expect(Object.keys(snapshot.values).toSorted()).toEqual([...RELAY_ENV_KEYS].toSorted());
		expect(JSON.stringify(snapshot)).not.toContain("OTHER_SECRET");
		expect(typeof snapshot.admission?.fetch).toBe("function");
	});

	it.each(["COORDINATOR_DB", "ADMISSION", "relay_admission", `RELAY_${"X".repeat(59)}`])(
		"reads no fetcher from binding name %s",
		(name) => {
			// Arrange
			const fetcher = { fetch: async () => new Response(null) };
			const env = { ...valid, CODEMEM_RELAY_ADMISSION_BINDING: name, [name]: fetcher };
			// Act
			const snapshot = captureRelayEnv(env);
			// Assert
			expect(snapshot.admission).toBeUndefined();
			expect(readRelayConfig(snapshot)).toBeNull();
		},
	);
});

describe("relay config", () => {
	it("accepts a complete configuration", () => {
		// Act
		const result = config({});
		// Assert
		expect(result).toMatchObject({
			admissionUrl: "https://coordinator.example.test/sync/v1/relay/admission-check",
			audienceOrigin: "wss://coordinator.example.test",
		});
		expect([...(result?.realms.values() ?? [])]).toEqual(["group-a"]);
	});

	it.each([
		["missing switch", { CODEMEM_RELAY_ENABLED: undefined }],
		["switch not exactly true", { CODEMEM_RELAY_ENABLED: "1" }],
		["missing service key", { CODEMEM_RELAY_SERVICE_KEY: undefined }],
		["missing binding", { RELAY_ADMISSION: undefined }],
		["cleartext authority", { CODEMEM_RELAY_AUTHORITY_URL: "http://coordinator.example.test" }],
		["authority with query", { CODEMEM_RELAY_AUTHORITY_URL: "https://c.example.test/?a=1" }],
		["groups not JSON", { CODEMEM_RELAY_GROUPS: "group-a" }],
		["groups not an array", { CODEMEM_RELAY_GROUPS: '"group-a"' }],
		["no groups", { CODEMEM_RELAY_GROUPS: "[]" }],
		["non-string group", { CODEMEM_RELAY_GROUPS: "[1]" }],
		["padded group", { CODEMEM_RELAY_GROUPS: '[" group-a"]' }],
		["empty group", { CODEMEM_RELAY_GROUPS: '[""]' }],
		["oversized group", { CODEMEM_RELAY_GROUPS: JSON.stringify(["g".repeat(129)]) }],
		["duplicate groups", { CODEMEM_RELAY_GROUPS: '["group-a","group-a"]' }],
		[
			"more than 64 groups",
			{ CODEMEM_RELAY_GROUPS: JSON.stringify(Array.from({ length: 65 }, (_, i) => `g${i}`)) },
		],
	])("stays off with %s", (_name, overrides) => {
		// Act / Assert
		expect(config(overrides)).toBeNull();
	});

	it("accepts exactly 64 groups", () => {
		// Arrange
		const groups = Array.from({ length: 64 }, (_, i) => `g${i}`);
		// Act
		const result = config({ CODEMEM_RELAY_GROUPS: JSON.stringify(groups) });
		// Assert
		expect(result?.realms.size).toBe(64);
	});
});

describe("relay service signer", () => {
	it("derives the same key ID clients compute from the SSH public key", async () => {
		// Arrange
		const { privateKey } = generateKeyPairSync("ed25519");
		const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
		const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
		const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
		const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
		// Act
		const signer = await importRelayServiceSigner(pkcs8);
		// Assert
		expect(signer.keyId).toBe(await relayEd25519KeyId(publicKey));
		expect(await signer.sign(new Uint8Array([1]))).toHaveLength(64);
	});
});
