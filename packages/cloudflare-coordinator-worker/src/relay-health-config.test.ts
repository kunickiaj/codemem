import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createProbeSigner,
	readRelayHealthConfig,
	relayHealthClock,
} from "./relay-health-config.js";
import {
	RelayHealthSampleBudget,
	relayHealthInstrumentation,
	startRelayHealth,
} from "./relay-health-link.js";
import { verifyCloudflareCoordinatorRequest } from "./request-verifier.js";

const valid = {
	CODEMEM_RELAY_ENABLED: "true",
	CODEMEM_RELAY_AUTHORITY_URL: "https://coordinator.example.test",
	CODEMEM_RELAY_GROUPS: JSON.stringify(["group-a", "group-b"]),
	CODEMEM_RELAY_SERVICE_KEY: "unused-by-config",
	CODEMEM_RELAY_HEALTH_PROBE_DEVICE: "probe",
	// Any well-formed base64 passes config. WebCrypto import decides whether it is a key.
	CODEMEM_RELAY_HEALTH_PROBE_KEY: "AAECAw==",
	CODEMEM_RELAY_HEALTH_SCOPES: JSON.stringify({ "group-a": "scope-a", "group-b": "scope-b" }),
};

describe("relay health config", () => {
	it("maps every configured group to its synthetic scope on the HTTPS origin", () => {
		// Act
		const config = readRelayHealthConfig(valid);
		// Assert
		expect(config).toMatchObject({
			origin: "https://coordinator.example.test/",
			probeDeviceId: "probe",
		});
		expect([...(config?.probeKey ?? [])]).toEqual([0, 1, 2, 3]);
		expect([...(config?.scopes ?? [])]).toEqual([
			["group-a", "scope-a"],
			["group-b", "scope-b"],
		]);
	});

	it.each([
		["relay off", { CODEMEM_RELAY_ENABLED: "false" }],
		["no probe device", { CODEMEM_RELAY_HEALTH_PROBE_DEVICE: undefined }],
		["a padded probe device", { CODEMEM_RELAY_HEALTH_PROBE_DEVICE: " probe" }],
		["no probe key", { CODEMEM_RELAY_HEALTH_PROBE_KEY: "" }],
		["a probe key with non-base64 characters", { CODEMEM_RELAY_HEALTH_PROBE_KEY: "not-base64!" }],
		["a truncated base64 probe key", { CODEMEM_RELAY_HEALTH_PROBE_KEY: "AAECA" }],
		[
			"a group without a scope",
			{ CODEMEM_RELAY_HEALTH_SCOPES: JSON.stringify({ "group-a": "scope-a" }) },
		],
		["scopes that are not JSON", { CODEMEM_RELAY_HEALTH_SCOPES: "{" }],
		["an HTTP authority", { CODEMEM_RELAY_AUTHORITY_URL: "http://coordinator.example.test" }],
	])("is off with %s", (_name, overrides) => {
		// Act / Assert
		expect(readRelayHealthConfig({ ...valid, ...overrides })).toBeNull();
	});

	it("reports a malformed probe key as not configured and never reaches the object", async () => {
		// Arrange
		let reached = false;
		const stub = {
			ensureScheduled: async () => {
				reached = true;
				return true;
			},
		};
		const namespace = { idFromName: () => ({}), get: () => stub };
		// Act
		const started = await startRelayHealth({
			...valid,
			CODEMEM_RELAY_HEALTH_PROBE_KEY: "%%%",
			RELAY_HEALTH: namespace,
		} as never);
		// Assert
		expect(started).toBe("not_configured");
		expect(reached).toBe(false);
	});

	it("declares a verified clock within the five-second bound", () => {
		// Act
		const stamp = relayHealthClock();
		// Assert
		expect(stamp.verified).toBe(true);
		expect(Number.isSafeInteger(stamp.utcMs)).toBe(true);
		expect(stamp.maxErrorMs + stamp.resolutionMs).toBeLessThanOrEqual(5000);
	});
});

describe("relay health probe signing", () => {
	it("produces v2 headers the coordinator verifier accepts", async () => {
		// Arrange
		const { privateKey } = generateKeyPairSync("ed25519");
		const pkcs8 = new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }));
		const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
		const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
		const sign = createProbeSigner("probe", pkcs8);
		// Act
		const headers = await sign({
			url: "https://coordinator.example.test/v1/scopes?group_id=group-a",
			method: "GET",
			body: new Uint8Array(),
		});
		const verified = await verifyCloudflareCoordinatorRequest({
			method: "GET",
			pathWithQuery: "/v1/scopes?group_id=group-a",
			bodyBytes: new Uint8Array(),
			timestamp: headers["X-Opencode-Timestamp"],
			nonce: headers["X-Opencode-Nonce"],
			signature: headers["X-Opencode-Signature"],
			publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
			deviceId: "probe",
		});
		// Assert
		expect(headers["X-Opencode-Device"]).toBe("probe");
		expect(headers["X-Opencode-Signature"]).toMatch(/^v2:[A-Za-z0-9+/]{86}==$/);
		expect(verified).toBe(true);
	});
});

describe("relay health sample forwarding", () => {
	it("allows a burst of ten, then one sample per second", () => {
		// Arrange
		let now = 0;
		const budget = new RelayHealthSampleBudget(() => now);
		// Act
		const burst = Array.from({ length: 11 }, () => budget.take());
		now = 999;
		const early = budget.take();
		now = 2000;
		const refilled = budget.take();
		// Assert
		expect(burst.filter(Boolean)).toHaveLength(10);
		expect([early, refilled]).toEqual([false, true]);
	});

	it("instruments only scope reads, with a context and a health binding", () => {
		// Arrange
		const ctx = { waitUntil: () => {} };
		const namespace = { idFromName: () => ({}), get: () => ({}) };
		const env = { ...valid, RELAY_HEALTH: namespace } as never;
		const request = (path: string, method = "GET") =>
			new Request(`https://coordinator.example.test${path}`, { method });
		// Act
		const results = [
			relayHealthInstrumentation(request("/v1/scopes?group_id=group-a"), env, ctx),
			relayHealthInstrumentation(request("/v1/scopes/s/members?group_id=group-a"), env, ctx),
			relayHealthInstrumentation(request("/v1/peers?group_id=group-a"), env, ctx),
			relayHealthInstrumentation(request("/v1/scopes", "POST"), env, ctx),
			relayHealthInstrumentation(request("/v1/scopes"), env, undefined),
			relayHealthInstrumentation(request("/v1/scopes"), { ...valid } as never, ctx),
		];
		// Assert
		expect(results.map((result) => result !== undefined)).toEqual([
			true,
			true,
			false,
			false,
			false,
			false,
		]);
	});
});
