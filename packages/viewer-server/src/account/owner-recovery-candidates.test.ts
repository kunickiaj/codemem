import { deepStrictEqual } from "node:assert/strict";
import type { coordinatorAuthControllerReviewAction } from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import {
	expectNoConfirmation,
	recoveryFixture,
	recoveryTests,
	scope,
} from "../../test/owner-recovery-service-fixture.js";
import {
	candidateList,
	readRecoveryCandidates,
	recordedOwnerGroups,
} from "./owner-recovery-candidates.js";
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
		deepStrictEqual(f.immutableSnapshot(), before);
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

	it("does not suggest an Identity that another device only guessed", () => {
		// Arrange: device-a uploaded the completion; its row for device-b is a label.
		const decision = (deviceId: string, evidence: "self" | "label") => ({
			device_id: deviceId,
			key_fingerprint: (deviceId === "device-a" ? "1" : "2").repeat(64),
			enabled: true,
			identity_id: "identity-a",
			decision: "included",
			identity_evidence: evidence,
		});
		const manifest = {
			version: 1,
			coordinator_id: "coordinator-a",
			candidate_ref: "legacy-team-candidate:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			candidate_digest: "a".repeat(64),
			team_id: "team-a",
			team_digest: "b".repeat(64),
			source_digest: "c".repeat(64),
			finish_digest: "d".repeat(64),
			access_delta_digest: "e".repeat(64),
			team: {
				display_name: "Synthetic Team",
				policy_revision: "f".repeat(64),
				device_eligibility_mode: "reviewed_allowlist",
			},
			memberships: [{ identity_id: "identity-a", role: "member" }],
			device_decisions: [decision("device-a", "self"), decision("device-b", "label")],
			project_mappings: [],
			project_recipients: [],
			completed_at: "2026-09-01T00:00:00.000Z",
		};
		const responses = [{ legacy_history: [{ group_id: "group-a", manifest }] }];
		// Act
		const uploader = recordedOwnerGroups(responses, { deviceId: "device-a" });
		const guessed = recordedOwnerGroups(responses, { deviceId: "device-b" });
		// Assert
		expect([...uploader.keys()]).toEqual(["identity-a"]);
		expect(guessed.size).toBe(0);
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
			{
				id: "local:work",
				label: "This profile's Identity, recorded for this device in nerdworld, sre",
			},
			{ id: "local:personal", label: "Identity recorded for this device in nerdworld" },
		]);
	});

	it("caps suggestions at the browser's 256-candidate limit and keeps this profile's Identity", () => {
		// Arrange
		const owners = new Map(
			Array.from({ length: 300 }, (_, index) => [
				`local:${String(index).padStart(3, "0")}`,
				new Set(["g"]),
			]),
		);
		owners.set("local:zzz-current", new Set(["g"]));
		// Act
		const candidates = candidateList(owners, "local:zzz-current");
		// Assert
		expect(candidates).toHaveLength(256);
		expect(candidates[0]?.id).toBe("local:zzz-current");
	});
});

describe("candidate request budget", () => {
	const device = { deviceId: "device-a", fingerprint: "a".repeat(64), identityId: "local:a" };
	const base = { remoteUrl: "https://coordinator.example", adminSecret: "secret", device };

	it("stops after the first group whose preview found this device's enrollment", async () => {
		// Arrange
		const previewDeviceOwner = vi.fn(async () => ({ enrollment: {}, legacy_history: [] }));
		// Act
		await readRecoveryCandidates({ ...base, previewDeviceOwner, groups: ["g1", "g2", "g3"] });
		// Assert
		expect(previewDeviceOwner).toHaveBeenCalledOnce();
	});

	it("stops on returned history when an identity mismatch hides the enrollment", async () => {
		// Arrange
		const previewDeviceOwner = vi.fn(async () => ({ enrollment: null, legacy_history: [{}] }));
		// Act
		await readRecoveryCandidates({ ...base, previewDeviceOwner, groups: ["g1", "g2"] });
		// Assert
		expect(previewDeviceOwner).toHaveBeenCalledOnce();
	});

	it("tries the next group after a failure or a group without this device", async () => {
		// Arrange
		const previewDeviceOwner = vi
			.fn<typeof coordinatorAuthControllerReviewAction>()
			.mockRejectedValueOnce(new Error("unavailable"))
			.mockResolvedValueOnce({ enrollment: null, legacy_history: [] })
			.mockResolvedValueOnce({ enrollment: {}, legacy_history: [] });
		// Act
		await readRecoveryCandidates({ ...base, previewDeviceOwner, groups: ["g1", "g2", "g3", "g4"] });
		// Assert
		expect(previewDeviceOwner.mock.calls.map(([input]) => input.groupId)).toEqual([
			"g1",
			"g2",
			"g3",
		]);
	});
});
