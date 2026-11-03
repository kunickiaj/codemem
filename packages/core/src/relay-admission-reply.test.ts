import { afterEach, describe, expect, it } from "vitest";
import { encodeRelayAdmissionReply, readRelayAdmissionReply } from "./relay-admission-reply.js";
import { bytes, serverFixture } from "./relay-server-test-fixtures.js";

let fixture: Awaited<ReturnType<typeof serverFixture>> | undefined;
afterEach(() => fixture?.dispose());
async function reply(kind: "registration" | "relay") {
	fixture = await serverFixture();
	let packet = (await fixture.openPacket()).body.checks[0];
	if (kind === "registration") packet = (await fixture.registration(fixture.adopt())).body;
	const wire = await fixture.coordinator.check({
		packet,
		deviceHeader: "source",
		signal: new AbortController().signal,
	});
	return { packet, wire };
}
describe("own coordinator reply association", () => {
	it.each(["registration", "relay"] as const)("reads a real %s decision", async (kind) => {
		// Arrange
		const { packet, wire } = await reply(kind);
		// Act
		const result = readRelayAdmissionReply(wire, packet);
		// Assert
		expect(result).toMatchObject({
			decidedAtMs: 110000,
			remainingMs: kind === "registration" ? 900000 : 45000,
			health: { state: "ready", revision: 1 },
		});
	});
	it.each([
		"packetDigest",
		"requestNonce",
		"role",
		"remainingMs",
		"decidedAtMs",
		"routeNotAfter",
		"eligible",
		"extra",
		"revision",
		"state",
		"observedAtMs",
		"validUntilMs",
	])("denies changed %s", async (field) => {
		// Arrange
		const { packet, wire } = await reply("relay");
		const value = JSON.parse(new TextDecoder().decode(wire));
		const changes: Record<string, unknown> = {
			packetDigest: "0".repeat(64),
			requestNonce: "0".repeat(32),
			role: "responder",
			remainingMs: 45001,
			decidedAtMs: 130000,
			routeNotAfter: 156,
			eligible: false,
			extra: true,
			revision: -1,
			state: "paused",
			observedAtMs: 120001,
			validUntilMs: 110000,
		};
		if (["revision", "state", "observedAtMs", "validUntilMs"].includes(field))
			value.health[field] = changes[field];
		else value[field] = changes[field];
		// Act
		const result = readRelayAdmissionReply(bytes(JSON.stringify(value)), packet);
		// Assert
		expect(result).toBeNull();
	});
	it.each(["deviceId", "keyId", "remainingMs"])(
		"denies registration %s mismatch",
		async (field) => {
			// Arrange
			const { packet, wire } = await reply("registration");
			const value = JSON.parse(new TextDecoder().decode(wire));
			value[field] = field === "remainingMs" ? 899999 : "other";
			// Act
			const result = readRelayAdmissionReply(bytes(JSON.stringify(value)), packet);
			// Assert
			expect(result).toBeNull();
		},
	);
	it("accepts nonnegative readiness revision zero", async () => {
		// Arrange
		const { packet, wire } = await reply("relay");
		const value = JSON.parse(new TextDecoder().decode(wire));
		value.health.revision = 0;
		// Act
		const result = readRelayAdmissionReply(bytes(JSON.stringify(value)), packet);
		// Assert
		expect(result).not.toBeNull();
	});
	it("encodes a generic denial without request details", async () => {
		// Arrange
		const { packet } = await reply("relay");
		// Act
		const wire = encodeRelayAdmissionReply(null);
		// Assert
		expect(new TextDecoder().decode(wire)).toBe('{"v":1,"eligible":false}');
		expect(readRelayAdmissionReply(wire, packet)).toBeNull();
	});
});
