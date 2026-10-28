import { deepStrictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
	recoveryFixture,
	recoveryTests,
	selectionFor,
} from "../../test/owner-recovery-service-fixture.js";
import { createAccountOwnerRecoveryService } from "./owner-recovery-service.js";

recoveryTests();
async function setup() {
	const f = await recoveryFixture({ admin: false });
	const service = createAccountOwnerRecoveryService(f.serviceOptions);
	f.cleanup(() => service.close());
	const selection = await selectionFor(service);
	return { ...f, service, selection };
}
describe("noncredential receipt import", () => {
	it("allows a no-admin import only through a fresh exact signed receipt read", async () => {
		// Arrange: ordinary storage IDs from the real original controller and checked fact.
		const f = await setup();
		const before = f.immutableSnapshot();
		// Act
		const result = await f.service.importReply({
			selection: f.selection,
			replyText: JSON.stringify(f.reply()),
		});
		// Assert
		expect(result.groups).toMatchObject([{ groupId: "group-a", status: "confirmed" }]);
		expect(f.reviewOwner).not.toHaveBeenCalled();
		expect(f.readRemoteReceiptStatus).toHaveBeenCalledWith(
			expect.objectContaining({ receipt: f.receipt(), ownerIdentityId: "identity-a" }),
		);
		expect(
			f.requests.some(
				(request) =>
					new URL(request.url).pathname === "/v1/auth/resolved-account-owner-receipt-status",
			),
		).toBe(true);
		expect(f.association()).toMatchObject({
			ownerIdentityId: "identity-a",
			attestationId: f.receipt().attestationId,
			reviewDigest: f.receipt().reviewEvidenceDigest,
		});
		deepStrictEqual(f.immutableSnapshot(), before);
	});
	it.each([
		"credential",
		"path",
		"scope",
		"extra-group",
		"duplicate-group",
		"oversize",
		"invalid-json",
	])("rejects %s reply before signed receipt IO", async (mode) => {
		// Arrange
		const f = await setup();
		const reply = f.reply();
		const group = reply.groups[0];
		if (!group) throw new Error("Missing receipt group");
		const changes: Record<string, () => void> = {
			credential: () => {
				Object.assign(reply, { adminSecret: "never-accept-browser-credential" });
			},
			path: () => {
				Object.assign(reply, { dbPath: f.dbPath });
			},
			scope: () => {
				reply.scope = "all_owners";
			},
			"extra-group": () => {
				reply.groups.push({ ...group, groupId: "foreign" });
			},
			"duplicate-group": () => {
				reply.groups.push({ ...group });
			},
		};
		changes[mode]?.();
		let replyText = JSON.stringify(reply);
		if (mode === "oversize") replyText += " ".repeat(32 * 1024);
		if (mode === "invalid-json") replyText = "not JSON";
		// Act / Assert
		await expect(f.service.importReply({ selection: f.selection, replyText })).rejects.toThrow();
		expect(f.readRemoteReceiptStatus).not.toHaveBeenCalled();
		expect(f.association()).toBeNull();
	});
	it.each([
		"attestationId",
		"reviewReceiptId",
		"reviewEvidenceDigest",
		"resolutionId",
		"resolutionEvidenceDigest",
	])("cannot borrow another valid owner fact with a wrong %s", async (field) => {
		// Arrange: real requester signatures and real persisted resolution; one wrong reference.
		const f = await setup();
		const reply = f.reply();
		const group = reply.groups[0];
		if (!group) throw new Error("Missing receipt group");
		Object.assign(group, {
			[field]: field.endsWith("Digest") ? "e".repeat(64) : "different-retained-reference",
		});
		// Act
		const result = await f.service.importReply({
			selection: f.selection,
			replyText: JSON.stringify(reply),
		});
		// Assert
		expect(result.groups[0]?.status).toBe("failed");
		expect(f.readRemoteReceiptStatus).toHaveBeenCalledOnce();
		expect(f.association()).toBeNull();
		expect(f.reviewOwner).not.toHaveBeenCalled();
	});
});

describe("fresh imported proof checks", () => {
	it("rejects a trusted-dependency DTO claiming confirmed owner for the wrong actual device", async () => {
		// Arrange: even a well-shaped model response is not proof for the selected subject.
		const f = await setup();
		const original = f.readRemoteReceiptStatus.getMockImplementation();
		if (!original) throw new Error("Missing receipt reader");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			const dto = await original(input);
			if (dto.kind === "owner_status") dto.status.deviceId = "foreign-device";
			return dto;
		});
		// Act
		const result = await f.service.importReply({
			selection: f.selection,
			replyText: JSON.stringify(f.reply()),
		});
		// Assert
		expect(result.groups[0]?.status).toBe("failed");
		expect(f.association()).toBeNull();
	});
	it("reports unknown and does not retain when the actual runtime actor changes while proof is awaited", async () => {
		// Arrange
		const f = await setup();
		const original = f.readRemoteReceiptStatus.getMockImplementation();
		if (!original) throw new Error("Missing receipt reader");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			const dto = await original(input);
			f.profile.identityId = "identity-next";
			f.config.actor_id = "identity-next";
			return dto;
		});
		// Act
		const result = await f.service.importReply({
			selection: f.selection,
			replyText: JSON.stringify(f.reply()),
		});
		// Assert
		expect(result.groups[0]?.status).toBe("unknown");
		expect(f.association()).toBeNull();
	});
	it("requires a fresh linked profile, not only owner_confirmed with unavailable account profile", async () => {
		// Arrange
		const f = await setup();
		const original = f.readRemoteReceiptStatus.getMockImplementation();
		if (!original) throw new Error("Missing receipt reader");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			const dto = await original(input);
			if (dto.kind === "owner_status")
				Object.assign(dto.status, { profileState: "unavailable", profile: null });
			return dto;
		});
		// Act
		const result = await f.service.importReply({
			selection: f.selection,
			replyText: JSON.stringify(f.reply()),
		});
		// Assert
		expect(result.groups[0]?.status).toBe("failed");
		expect(f.association()).toBeNull();
	});
});
