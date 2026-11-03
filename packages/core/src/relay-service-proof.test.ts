import { describe, expect, it } from "vitest";
import { SESSION, testSigner } from "./relay-server-test-fixtures.js";
import {
	createRelayServiceProof,
	relayAudienceId,
	relayAuthorityId,
	relayRealmId,
	verifyRelayServiceProof,
} from "./relay-service-proof.js";

describe("relay service proof", () => {
	async function proof() {
		const signer = testSigner(3),
			audienceId = "f".repeat(64);
		const body = await createRelayServiceProof({
			audienceId,
			challengeId: SESSION,
			utcMs: 110000,
			signer,
		});
		return {
			audienceId,
			challengeId: SESSION,
			publicKey: signer.publicKey,
			body,
			startedAtMs: 0,
			nowMs: 4999,
			deadlineMs: 5000,
		};
	}
	it("verifies the configured pin and exact pending challenge before the deadline", async () => {
		// Arrange
		const options = await proof();
		// Act
		const valid = await verifyRelayServiceProof(options);
		// Assert
		expect(valid).toBe(true);
		expect(options.body).toMatchObject({ issuedAt: 110, expiresAt: 140 });
	});
	it.each([
		"audience",
		"challenge",
		"pin",
		"signature",
		"five seconds",
		"earlier deadline",
		"backward clock",
		"interval",
	])("denies changed %s", async (change) => {
		// Arrange
		const options = await proof();
		const mutations: Record<string, () => void> = {
			audience: () => {
				options.audienceId = "a".repeat(64);
			},
			challenge: () => {
				options.challengeId = "a".repeat(32);
			},
			pin: () => {
				options.publicKey = testSigner(4).publicKey;
			},
			signature: () => {
				options.body = { ...options.body, signature: Buffer.alloc(64).toString("base64") };
			},
			"five seconds": () => {
				options.nowMs = 5000;
			},
			"earlier deadline": () => {
				options.deadlineMs = 4999;
			},
			"backward clock": () => {
				options.nowMs = -1;
			},
			interval: () => {
				options.body = { ...options.body, expiresAt: 141 };
			},
		};
		mutations[change]?.();
		// Act
		const valid = await verifyRelayServiceProof(options);
		// Assert
		expect(valid).toBe(false);
	});
	it("canonicalizes authority URLs and separates realm and audience identities", () => {
		// Arrange
		const key = testSigner(3).keyId;
		// Act
		const authority = relayAuthorityId("https://coordinator.example/base///");
		const realm = relayRealmId(authority, "group-A");
		const audience = relayAudienceId("wss://relay.example", key);
		// Assert
		expect(authority).toBe(relayAuthorityId("https://coordinator.example/base"));
		expect(realm).not.toBe(relayRealmId(authority, "group-B"));
		expect(audience).not.toBe(relayAudienceId("wss://other.example", key));
	});
	it.each([0, 63, 65])("rejects a signer output of %s bytes", async (length) => {
		// Arrange
		const signer = testSigner(3);
		signer.sign.mockResolvedValueOnce(new Uint8Array(length));
		// Act / Assert
		await expect(
			createRelayServiceProof({
				audienceId: "f".repeat(64),
				challengeId: SESSION,
				utcMs: 110000,
				signer,
			}),
		).rejects.toThrow();
	});
	it.each([
		"http://coordinator.example",
		"https://user@coordinator.example",
		"https://coordinator.example/?x=1",
		"https://coordinator.example/#x",
	])("rejects unsafe authority %s", (url) => {
		// Arrange / Act / Assert
		expect(() => relayAuthorityId(url)).toThrow();
	});
	it.each([
		"http://relay.example",
		"wss://relay.example/",
		"wss://user@relay.example",
		"wss://relay.example/path",
	])("rejects non-origin audience %s", (url) => {
		// Arrange / Act / Assert
		expect(() => relayAudienceId(url, testSigner(3).keyId)).toThrow();
	});
});
