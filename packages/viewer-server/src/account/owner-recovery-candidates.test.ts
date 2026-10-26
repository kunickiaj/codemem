import { describe, expect, it } from "vitest";
import {
	expectNoConfirmation,
	recoveryFixture,
	recoveryTests,
	scope,
} from "../../test/owner-recovery-service-fixture.js";
import { candidateList, recordedOwnerGroups } from "./owner-recovery-candidates.js";
import { createAccountOwnerRecoveryService } from "./owner-recovery-service.js";

recoveryTests();

/** Serve unscoped device-owner previews with the fixture's real canonical history. */
async function historyFixture(options: { groups?: string[] } = {}) {
	const f = await recoveryFixture({ fact: false, ...options });
	f.previewDeviceOwner.mockImplementation(async (input) => {
		const history = await f.reviewOwner({
			...input,
			purpose: "existing_account_owner",
			resolutionScope: scope,
			identityId: "identity-a",
		});
		f.reviewOwner.mockClear();
		return { state: "ready", legacy_history: history.legacy_history };
	});
	return f;
}

describe("recorded owner candidates", () => {
	it("suggests each Identity that Team history records for the current device", async () => {
		// Arrange
		const f = await historyFixture();
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		// Act
		const result = await service.getProfile();
		// Assert
		expect(result.candidates).toEqual([
			{
				id: "identity-b",
				label: "This profile's Identity, recorded for this device in retained-history-c",
			},
		]);
	});

	it("asks the coordinator only for read-only previews of the current device owner", async () => {
		// Arrange
		const f = await historyFixture();
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const before = f.immutableSnapshot();
		// Act
		await service.getProfile();
		// Assert
		const calls = f.previewDeviceOwner.mock.calls.map(([input]) => input);
		expect(calls).toEqual([
			expect.objectContaining({
				groupId: "group-a",
				deviceId: f.deviceId,
				fingerprint: f.fingerprint,
				identityId: "identity-b",
			}),
		]);
		for (const field of [
			"confirmEvidenceDigest",
			"confirmOwnerResolutionDigest",
			"resolutionScope",
		])
			expect(calls[0]).not.toHaveProperty(field);
		expectNoConfirmation(f);
		expect(f.immutableSnapshot()).toEqual(before);
	});

	it("reuses recent suggestions for the same profile to spare the shared admin rate limit", async () => {
		// Arrange
		const f = await historyFixture();
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const first = await service.getProfile();
		// Act
		const again = await service.getProfile();
		f.advance(60_000);
		await service.getProfile();
		// Assert
		expect(again.candidates).toEqual(first.candidates);
		expect(f.previewDeviceOwner).toHaveBeenCalledTimes(2);
	});

	it("returns the profile without suggestions when the coordinator preview fails", async () => {
		// Arrange
		const f = await historyFixture();
		f.previewDeviceOwner.mockRejectedValue(new Error("coordinator unavailable"));
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		// Act
		const result = await service.getProfile();
		// Assert
		expect(result).toMatchObject({ reviewAccess: "operator", candidates: [] });
	});

	it("does not contact the coordinator for suggestions without operator access", async () => {
		// Arrange
		const f = await historyFixture();
		f.setAdmin(null);
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		// Act
		const result = await service.getProfile();
		// Assert
		expect(result).toMatchObject({ reviewAccess: "request", candidates: [] });
		expect(f.previewDeviceOwner).not.toHaveBeenCalled();
	});
});

describe("candidate projection", () => {
	it("ignores malformed history and other devices", () => {
		// Arrange
		const responses = [
			null,
			{ legacy_history: "not-a-list" },
			{ legacy_history: [{ group_id: "group-a", manifest: { version: 99 } }] },
		];
		// Act
		const owners = recordedOwnerGroups(responses, { deviceId: "device-a" });
		// Assert
		expect(owners.size).toBe(0);
	});

	it("keeps labels within the browser's 256-character limit for many or long groups", () => {
		// Arrange
		const many = new Set(["g1", "g2", "g3", "g4", "g5"]);
		const long = new Set(["x".repeat(256), "y".repeat(256)]);
		const owners = new Map([
			["local:many", many],
			["local:long", long],
		]);
		// Act
		const candidates = candidateList(owners, "local:other");
		// Assert
		expect(candidates).toEqual([
			{ id: "local:long", label: "Identity recorded for this device in 2 groups" },
			{ id: "local:many", label: "Identity recorded for this device in g1, g2, g3 and 2 more" },
		]);
		for (const candidate of candidates) expect(candidate.label.length).toBeLessThanOrEqual(256);
	});

	it("labels another recorded Identity separately from this profile's Identity", () => {
		// Arrange
		const owners = new Map([
			["local:personal", new Set(["nerdworld"])],
			["local:work", new Set(["sre", "nerdworld"])],
		]);
		// Act
		const candidates = candidateList(owners, "local:work");
		// Assert
		expect(candidates).toEqual([
			{ id: "local:personal", label: "Identity recorded for this device in nerdworld" },
			{
				id: "local:work",
				label: "This profile's Identity, recorded for this device in nerdworld, sre",
			},
		]);
	});
});
