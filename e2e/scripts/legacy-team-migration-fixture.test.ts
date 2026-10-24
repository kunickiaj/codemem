import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ed25519KeyId } from "../../packages/core/src/coordinator-ed25519-key-id.ts";
import { initDatabase, MemoryStore } from "../../packages/core/src/index.ts";
import { ROSTER, rosterSummary } from "./legacy-team-migration-fixture.ts";

vi.mock("../../packages/core/src/index.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/core/src/index.ts")>()),
	initDatabase: vi.fn(),
	MemoryStore: vi.fn(),
}));

describe("legacy team migration fixture roster", () => {
	it("imports without initializing the fixture database", () => {
		// Arrange: importing this module must not run the CLI entrypoint.
		const expectedDeviceCount = 6;
		// Act
		const devices = Object.values(ROSTER);
		// Assert
		expect(devices).toHaveLength(expectedDeviceCount);
		expect(initDatabase).not.toHaveBeenCalled();
		expect(MemoryStore).not.toHaveBeenCalled();
	});

	it("gives all six devices distinct canonical Ed25519 key IDs", async () => {
		// Arrange: completion manifests require canonical ownership evidence.
		const devices = Object.values(ROSTER);
		// Act
		const keyIds = await Promise.all(devices.map((device) => ed25519KeyId(device.publicKey)));
		// Assert
		expect(keyIds).toHaveLength(6);
		for (const keyId of keyIds) expect(keyId).toMatch(/^[a-f0-9]{64}$/);
		expect(new Set(keyIds).size).toBe(6);
	});

	it.each(["shared", "optional", "beta", "beta-two", "beta-three", "beta-four"])(
		"rejects the former %s placeholder as canonical ownership evidence",
		async (name) => {
			// Arrange
			const placeholder = `legacy-team-e2e-${name}-public-key`;
			// Act
			const keyId = await ed25519KeyId(placeholder);
			// Assert
			expect(keyId).toBeNull();
		},
	);

	it("reports stable keys and text fingerprints across peer fixture calls", async () => {
		// Arrange: enrollment fingerprints hash the exact public text, not the SSH blob.
		const expected = Object.fromEntries(
			Object.entries(ROSTER).map(([name, device]) => [
				name,
				{ ...device, fingerprint: createHash("sha256").update(device.publicKey).digest("hex") },
			]),
		);
		// Act
		const firstPeer = rosterSummary();
		const secondPeer = rosterSummary();
		const keyIds = await Promise.all(
			Object.values(ROSTER).map((device) => ed25519KeyId(device.publicKey)),
		);
		// Assert
		expect(firstPeer).toEqual(expected);
		expect(secondPeer).toEqual(expected);
		expect(JSON.stringify(secondPeer)).toBe(JSON.stringify(firstPeer));
		for (const [index, device] of Object.values(firstPeer).entries()) {
			expect(device.fingerprint).not.toBe(keyIds[index]);
		}
	});

	it("does not let a changed report mutate the next peer's roster", () => {
		// Arrange
		const firstPeer = rosterSummary();
		const originalReport = JSON.stringify(firstPeer);
		// Act
		firstPeer.shared.fingerprint = "changed-fingerprint";
		delete firstPeer.optional;
		const secondPeer = rosterSummary();
		// Assert
		expect(JSON.stringify(secondPeer)).toBe(originalReport);
		expect(secondPeer.shared).not.toBe(firstPeer.shared);
	});
});
