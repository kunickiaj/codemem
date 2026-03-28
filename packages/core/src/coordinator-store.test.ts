import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore as CoordinatorStore } from "./coordinator-store.js";

describe("CoordinatorStore", () => {
	let tmpDir: string;
	let store: CoordinatorStore;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "coord-test-"));
		store = new CoordinatorStore(join(tmpDir, "coordinator.sqlite"));
	});

	afterEach(async () => {
		await store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// -- Schema -------------------------------------------------------------

	describe("schema", () => {
		it("creates all expected tables", async () => {
			const tables = store.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as { name: string }[];
			const names = tables.map((t) => t.name).sort();
			expect(names).toEqual([
				"coordinator_invites",
				"coordinator_join_requests",
				"enrolled_devices",
				"groups",
				"presence_records",
				"request_nonces",
			]);
		});
	});

	// -- Groups -------------------------------------------------------------

	describe("groups", () => {
		it("creates and retrieves a group", async () => {
			await store.createGroup("g1", "Team Alpha");
			const group = await store.getGroup("g1");
			expect(group).not.toBeNull();
			expect(group?.group_id).toBe("g1");
			expect(group?.display_name).toBe("Team Alpha");
			expect(group?.created_at).toBeTruthy();
		});

		it("returns null for missing group", async () => {
			expect(await store.getGroup("nope")).toBeNull();
		});

		it("INSERT OR IGNORE on duplicate group_id", async () => {
			await store.createGroup("g1", "Original");
			await store.createGroup("g1", "Changed");
			const group = await store.getGroup("g1");
			expect(group?.display_name).toBe("Original");
		});

		it("lists groups", async () => {
			await store.createGroup("g1");
			await store.createGroup("g2", "Second");
			const groups = await store.listGroups();
			expect(groups).toHaveLength(2);
		});
	});

	// -- Devices ------------------------------------------------------------

	describe("devices", () => {
		beforeEach(async () => {
			await store.createGroup("g1");
		});

		it("enrolls and retrieves a device", async () => {
			await store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
				displayName: "Laptop",
			});
			const enrollment = await store.getEnrollment("g1", "d1");
			expect(enrollment).not.toBeNull();
			expect(enrollment?.device_id).toBe("d1");
			expect(enrollment?.display_name).toBe("Laptop");
		});

		it("returns null for missing enrollment", async () => {
			expect(await store.getEnrollment("g1", "missing")).toBeNull();
		});

		it("upserts on re-enroll", async () => {
			await store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
				displayName: "Old",
			});
			await store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp2",
				publicKey: "pk2",
				displayName: "New",
			});
			const enrollment = await store.getEnrollment("g1", "d1");
			expect(enrollment?.fingerprint).toBe("fp2");
			expect(enrollment?.display_name).toBe("New");
		});

		it("lists enrolled devices", async () => {
			await store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			await store.enrollDevice("g1", {
				deviceId: "d2",
				fingerprint: "fp2",
				publicKey: "pk2",
			});
			expect(await store.listEnrolledDevices("g1")).toHaveLength(2);
		});

		it("renames a device", async () => {
			await store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			expect(await store.renameDevice("g1", "d1", "Desktop")).toBe(true);
			const enrollment = await store.getEnrollment("g1", "d1");
			expect(enrollment?.display_name).toBe("Desktop");
		});

		it("disables and re-enables a device", async () => {
			await store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			await store.setDeviceEnabled("g1", "d1", false);
			// Disabled device not returned by default
			expect(await store.listEnrolledDevices("g1")).toHaveLength(0);
			// But shows up with includeDisabled
			expect(await store.listEnrolledDevices("g1", true)).toHaveLength(1);
			// Re-enable
			await store.setDeviceEnabled("g1", "d1", true);
			expect(await store.listEnrolledDevices("g1")).toHaveLength(1);
		});

		it("removes a device and its presence", async () => {
			await store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			await store.upsertPresence({
				groupId: "g1",
				deviceId: "d1",
				addresses: ["http://localhost:9000"],
				ttlS: 300,
			});
			expect(await store.removeDevice("g1", "d1")).toBe(true);
			expect(await store.getEnrollment("g1", "d1")).toBeNull();
			// Verify presence was also cleaned up
			const presence = store.db
				.prepare("SELECT * FROM presence_records WHERE group_id = ? AND device_id = ?")
				.get("g1", "d1");
			expect(presence).toBeUndefined();
		});

		it("returns false when removing a non-existent device", async () => {
			expect(await store.removeDevice("g1", "ghost")).toBe(false);
		});
	});

	// -- Presence -----------------------------------------------------------

	describe("presence", () => {
		beforeEach(async () => {
			await store.createGroup("g1");
			await store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			await store.enrollDevice("g1", {
				deviceId: "d2",
				fingerprint: "fp2",
				publicKey: "pk2",
			});
		});

		it("upserts presence and returns normalized data", async () => {
			const result = await store.upsertPresence({
				groupId: "g1",
				deviceId: "d1",
				addresses: ["http://localhost:9000"],
				ttlS: 300,
			});
			expect(result.group_id).toBe("g1");
			expect(result.device_id).toBe("d1");
			expect(result.addresses).toEqual(["http://localhost:9000"]);
			expect(result.expires_at).toBeTruthy();
		});

		it("lists group peers excluding requesting device", async () => {
			await store.upsertPresence({
				groupId: "g1",
				deviceId: "d1",
				addresses: ["http://localhost:9000"],
				ttlS: 300,
			});
			await store.upsertPresence({
				groupId: "g1",
				deviceId: "d2",
				addresses: ["http://localhost:9001"],
				ttlS: 300,
			});
			// d1 asks for peers — should only see d2
			const peers = await store.listGroupPeers("g1", "d1");
			expect(peers).toHaveLength(1);
			expect(peers[0].device_id).toBe("d2");
			expect(peers[0].stale).toBe(false);
			expect(peers[0].addresses).toEqual(["http://localhost:9001"]);
		});

		it("marks stale presence with empty addresses", async () => {
			// Set presence with 0 TTL so it expires immediately
			await store.upsertPresence({
				groupId: "g1",
				deviceId: "d2",
				addresses: ["http://localhost:9001"],
				ttlS: 0,
			});
			const peers = await store.listGroupPeers("g1", "d1");
			expect(peers).toHaveLength(1);
			expect(peers[0].stale).toBe(true);
			expect(peers[0].addresses).toEqual([]);
		});

		it("shows enrolled peers with no presence record", async () => {
			// d2 never reported presence
			const peers = await store.listGroupPeers("g1", "d1");
			expect(peers).toHaveLength(1);
			expect(peers[0].device_id).toBe("d2");
			expect(peers[0].stale).toBe(true);
			expect(peers[0].addresses).toEqual([]);
		});
	});

	// -- Invites ------------------------------------------------------------

	describe("invites", () => {
		beforeEach(async () => {
			await store.createGroup("g1", "Team Alpha");
		});

		it("creates an invite and retrieves by token", async () => {
			const invite = await store.createInvite({
				groupId: "g1",
				policy: "auto_approve",
				expiresAt: "2099-01-01T00:00:00Z",
				createdBy: "admin",
			});
			expect(invite.invite_id).toBeTruthy();
			expect(invite.group_id).toBe("g1");
			expect(invite.policy).toBe("auto_approve");
			expect(invite.team_name_snapshot).toBe("Team Alpha");

			const byToken = await store.getInviteByToken(invite.token as string);
			expect(byToken).not.toBeNull();
			expect(byToken?.invite_id).toBe(invite.invite_id);
		});

		it("returns null for unknown token", async () => {
			expect(await store.getInviteByToken("nonexistent")).toBeNull();
		});

		it("lists invites for a group", async () => {
			await store.createInvite({
				groupId: "g1",
				policy: "auto_approve",
				expiresAt: "2099-01-01T00:00:00Z",
			});
			await store.createInvite({
				groupId: "g1",
				policy: "manual_review",
				expiresAt: "2099-06-01T00:00:00Z",
			});
			expect(await store.listInvites("g1")).toHaveLength(2);
		});
	});

	// -- Join requests ------------------------------------------------------

	describe("join requests", () => {
		let inviteToken: string;

		beforeEach(async () => {
			await store.createGroup("g1");
			const invite = await store.createInvite({
				groupId: "g1",
				policy: "manual_review",
				expiresAt: "2099-01-01T00:00:00Z",
			});
			inviteToken = invite.token as string;
		});

		it("creates a join request in pending status", async () => {
			const req = await store.createJoinRequest({
				groupId: "g1",
				deviceId: "d-new",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				displayName: "New Device",
				token: inviteToken,
			});
			expect(req.request_id).toBeTruthy();
			expect(req.status).toBe("pending");
			expect(req.device_id).toBe("d-new");
		});

		it("lists pending join requests", async () => {
			await store.createJoinRequest({
				groupId: "g1",
				deviceId: "d1",
				publicKey: "pk1",
				fingerprint: "fp1",
				token: inviteToken,
			});
			await store.createJoinRequest({
				groupId: "g1",
				deviceId: "d2",
				publicKey: "pk2",
				fingerprint: "fp2",
				token: inviteToken,
			});
			const pending = await store.listJoinRequests("g1");
			expect(pending).toHaveLength(2);
		});

		it("approves a join request and enrolls the device", async () => {
			const req = await store.createJoinRequest({
				groupId: "g1",
				deviceId: "d-new",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				displayName: "New Device",
				token: inviteToken,
			});
			const reviewed = await store.reviewJoinRequest({
				requestId: req.request_id as string,
				approved: true,
				reviewedBy: "admin",
			});
			expect(reviewed).not.toBeNull();
			expect(reviewed?.status).toBe("approved");
			expect(reviewed?.reviewed_by).toBe("admin");

			// Device should now be enrolled
			const enrollment = await store.getEnrollment("g1", "d-new");
			expect(enrollment).not.toBeNull();
			expect(enrollment?.fingerprint).toBe("fp-new");
		});

		it("denies a join request without enrolling", async () => {
			const req = await store.createJoinRequest({
				groupId: "g1",
				deviceId: "d-new",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				token: inviteToken,
			});
			const reviewed = await store.reviewJoinRequest({
				requestId: req.request_id as string,
				approved: false,
			});
			expect(reviewed?.status).toBe("denied");
			expect(await store.getEnrollment("g1", "d-new")).toBeNull();
		});

		it("returns null for missing request_id", async () => {
			expect(await store.reviewJoinRequest({ requestId: "nope", approved: true })).toBeNull();
		});

		it("returns _no_transition for already-reviewed request", async () => {
			const req = await store.createJoinRequest({
				groupId: "g1",
				deviceId: "d-new",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				token: inviteToken,
			});
			await store.reviewJoinRequest({
				requestId: req.request_id as string,
				approved: true,
			});
			const again = await store.reviewJoinRequest({
				requestId: req.request_id as string,
				approved: false,
			});
			expect(again?._no_transition).toBe(true);
		});
	});
});
