import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoordinatorStore } from "./coordinator-store.js";

describe("CoordinatorStore", () => {
	let tmpDir: string;
	let store: CoordinatorStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "coord-test-"));
		store = new CoordinatorStore(join(tmpDir, "coordinator.sqlite"));
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// -- Schema -------------------------------------------------------------

	describe("schema", () => {
		it("creates all expected tables", () => {
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
		it("creates and retrieves a group", () => {
			store.createGroup("g1", "Team Alpha");
			const group = store.getGroup("g1");
			expect(group).not.toBeNull();
			expect(group?.group_id).toBe("g1");
			expect(group?.display_name).toBe("Team Alpha");
			expect(group?.created_at).toBeTruthy();
		});

		it("returns null for missing group", () => {
			expect(store.getGroup("nope")).toBeNull();
		});

		it("INSERT OR IGNORE on duplicate group_id", () => {
			store.createGroup("g1", "Original");
			store.createGroup("g1", "Changed");
			expect(store.getGroup("g1")?.display_name).toBe("Original");
		});

		it("lists groups", () => {
			store.createGroup("g1");
			store.createGroup("g2", "Second");
			const groups = store.listGroups();
			expect(groups).toHaveLength(2);
		});
	});

	// -- Devices ------------------------------------------------------------

	describe("devices", () => {
		beforeEach(() => {
			store.createGroup("g1");
		});

		it("enrolls and retrieves a device", () => {
			store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
				displayName: "Laptop",
			});
			const enrollment = store.getEnrollment("g1", "d1");
			expect(enrollment).not.toBeNull();
			expect(enrollment?.device_id).toBe("d1");
			expect(enrollment?.display_name).toBe("Laptop");
		});

		it("returns null for missing enrollment", () => {
			expect(store.getEnrollment("g1", "missing")).toBeNull();
		});

		it("upserts on re-enroll", () => {
			store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
				displayName: "Old",
			});
			store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp2",
				publicKey: "pk2",
				displayName: "New",
			});
			const enrollment = store.getEnrollment("g1", "d1");
			expect(enrollment?.fingerprint).toBe("fp2");
			expect(enrollment?.display_name).toBe("New");
		});

		it("lists enrolled devices", () => {
			store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			store.enrollDevice("g1", {
				deviceId: "d2",
				fingerprint: "fp2",
				publicKey: "pk2",
			});
			expect(store.listEnrolledDevices("g1")).toHaveLength(2);
		});

		it("renames a device", () => {
			store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			expect(store.renameDevice("g1", "d1", "Desktop")).toBe(true);
			expect(store.getEnrollment("g1", "d1")?.display_name).toBe("Desktop");
		});

		it("disables and re-enables a device", () => {
			store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			store.setDeviceEnabled("g1", "d1", false);
			// Disabled device not returned by default
			expect(store.listEnrolledDevices("g1")).toHaveLength(0);
			// But shows up with includeDisabled
			expect(store.listEnrolledDevices("g1", true)).toHaveLength(1);
			// Re-enable
			store.setDeviceEnabled("g1", "d1", true);
			expect(store.listEnrolledDevices("g1")).toHaveLength(1);
		});

		it("removes a device and its presence", () => {
			store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			store.upsertPresence({
				groupId: "g1",
				deviceId: "d1",
				addresses: ["http://localhost:9000"],
				ttlS: 300,
			});
			expect(store.removeDevice("g1", "d1")).toBe(true);
			expect(store.getEnrollment("g1", "d1")).toBeNull();
			// Verify presence was also cleaned up
			const presence = store.db
				.prepare("SELECT * FROM presence_records WHERE group_id = ? AND device_id = ?")
				.get("g1", "d1");
			expect(presence).toBeUndefined();
		});

		it("returns false when removing a non-existent device", () => {
			expect(store.removeDevice("g1", "ghost")).toBe(false);
		});
	});

	// -- Presence -----------------------------------------------------------

	describe("presence", () => {
		beforeEach(() => {
			store.createGroup("g1");
			store.enrollDevice("g1", {
				deviceId: "d1",
				fingerprint: "fp1",
				publicKey: "pk1",
			});
			store.enrollDevice("g1", {
				deviceId: "d2",
				fingerprint: "fp2",
				publicKey: "pk2",
			});
		});

		it("upserts presence and returns normalized data", () => {
			const result = store.upsertPresence({
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

		it("lists group peers excluding requesting device", () => {
			store.upsertPresence({
				groupId: "g1",
				deviceId: "d1",
				addresses: ["http://localhost:9000"],
				ttlS: 300,
			});
			store.upsertPresence({
				groupId: "g1",
				deviceId: "d2",
				addresses: ["http://localhost:9001"],
				ttlS: 300,
			});
			// d1 asks for peers — should only see d2
			const peers = store.listGroupPeers("g1", "d1");
			expect(peers).toHaveLength(1);
			expect(peers[0].device_id).toBe("d2");
			expect(peers[0].stale).toBe(false);
			expect(peers[0].addresses).toEqual(["http://localhost:9001"]);
		});

		it("marks stale presence with empty addresses", () => {
			// Set presence with 0 TTL so it expires immediately
			store.upsertPresence({
				groupId: "g1",
				deviceId: "d2",
				addresses: ["http://localhost:9001"],
				ttlS: 0,
			});
			const peers = store.listGroupPeers("g1", "d1");
			expect(peers).toHaveLength(1);
			expect(peers[0].stale).toBe(true);
			expect(peers[0].addresses).toEqual([]);
		});

		it("shows enrolled peers with no presence record", () => {
			// d2 never reported presence
			const peers = store.listGroupPeers("g1", "d1");
			expect(peers).toHaveLength(1);
			expect(peers[0].device_id).toBe("d2");
			expect(peers[0].stale).toBe(true);
			expect(peers[0].addresses).toEqual([]);
		});
	});

	// -- Invites ------------------------------------------------------------

	describe("invites", () => {
		beforeEach(() => {
			store.createGroup("g1", "Team Alpha");
		});

		it("creates an invite and retrieves by token", () => {
			const invite = store.createInvite({
				groupId: "g1",
				policy: "auto_approve",
				expiresAt: "2099-01-01T00:00:00Z",
				createdBy: "admin",
			});
			expect(invite.invite_id).toBeTruthy();
			expect(invite.group_id).toBe("g1");
			expect(invite.policy).toBe("auto_approve");
			expect(invite.team_name_snapshot).toBe("Team Alpha");

			const byToken = store.getInviteByToken(invite.token as string);
			expect(byToken).not.toBeNull();
			expect(byToken?.invite_id).toBe(invite.invite_id);
		});

		it("returns null for unknown token", () => {
			expect(store.getInviteByToken("nonexistent")).toBeNull();
		});

		it("lists invites for a group", () => {
			store.createInvite({
				groupId: "g1",
				policy: "auto_approve",
				expiresAt: "2099-01-01T00:00:00Z",
			});
			store.createInvite({
				groupId: "g1",
				policy: "manual_review",
				expiresAt: "2099-06-01T00:00:00Z",
			});
			expect(store.listInvites("g1")).toHaveLength(2);
		});
	});

	// -- Join requests ------------------------------------------------------

	describe("join requests", () => {
		let inviteToken: string;

		beforeEach(() => {
			store.createGroup("g1");
			const invite = store.createInvite({
				groupId: "g1",
				policy: "manual_review",
				expiresAt: "2099-01-01T00:00:00Z",
			});
			inviteToken = invite.token as string;
		});

		it("creates a join request in pending status", () => {
			const req = store.createJoinRequest({
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

		it("lists pending join requests", () => {
			store.createJoinRequest({
				groupId: "g1",
				deviceId: "d1",
				publicKey: "pk1",
				fingerprint: "fp1",
				token: inviteToken,
			});
			store.createJoinRequest({
				groupId: "g1",
				deviceId: "d2",
				publicKey: "pk2",
				fingerprint: "fp2",
				token: inviteToken,
			});
			const pending = store.listJoinRequests("g1");
			expect(pending).toHaveLength(2);
		});

		it("approves a join request and enrolls the device", () => {
			const req = store.createJoinRequest({
				groupId: "g1",
				deviceId: "d-new",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				displayName: "New Device",
				token: inviteToken,
			});
			const reviewed = store.reviewJoinRequest({
				requestId: req.request_id as string,
				approved: true,
				reviewedBy: "admin",
			});
			expect(reviewed).not.toBeNull();
			expect(reviewed?.status).toBe("approved");
			expect(reviewed?.reviewed_by).toBe("admin");

			// Device should now be enrolled
			const enrollment = store.getEnrollment("g1", "d-new");
			expect(enrollment).not.toBeNull();
			expect(enrollment?.fingerprint).toBe("fp-new");
		});

		it("denies a join request without enrolling", () => {
			const req = store.createJoinRequest({
				groupId: "g1",
				deviceId: "d-new",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				token: inviteToken,
			});
			const reviewed = store.reviewJoinRequest({
				requestId: req.request_id as string,
				approved: false,
			});
			expect(reviewed?.status).toBe("denied");
			expect(store.getEnrollment("g1", "d-new")).toBeNull();
		});

		it("returns null for missing request_id", () => {
			expect(store.reviewJoinRequest({ requestId: "nope", approved: true })).toBeNull();
		});

		it("returns _no_transition for already-reviewed request", () => {
			const req = store.createJoinRequest({
				groupId: "g1",
				deviceId: "d-new",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				token: inviteToken,
			});
			store.reviewJoinRequest({
				requestId: req.request_id as string,
				approved: true,
			});
			const again = store.reviewJoinRequest({
				requestId: req.request_id as string,
				approved: false,
			});
			expect(again?._no_transition).toBe(true);
		});
	});
});
