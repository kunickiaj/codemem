import { describe, expect, it } from "vitest";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

export interface CoordinatorStoreHarnessContext<
	TStore extends CoordinatorStore = CoordinatorStore,
> {
	store: TStore;
	cleanup: () => Promise<void> | void;
}

export function runCoordinatorStoreContract<TStore extends CoordinatorStore>(
	label: string,
	setup: () => CoordinatorStoreHarnessContext<TStore>,
): void {
	describe(label, () => {
		async function withContext(
			run: (ctx: CoordinatorStoreHarnessContext<TStore>) => Promise<void> | void,
		) {
			const ctx = setup();
			try {
				await run(ctx);
			} finally {
				await ctx.cleanup();
			}
		}

		describe("groups", () => {
			it("creates and retrieves a group", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const group = await store.getGroup("g1");
					expect(group).not.toBeNull();
					expect(group?.group_id).toBe("g1");
					expect(group?.display_name).toBe("Team Alpha");
					expect(group?.created_at).toBeTruthy();
				});
			});

			it("returns null for missing group", async () => {
				await withContext(async ({ store }) => {
					expect(await store.getGroup("nope")).toBeNull();
				});
			});

			it("INSERT OR IGNORE on duplicate group_id", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Original");
					await store.createGroup("g1", "Changed");
					const group = await store.getGroup("g1");
					expect(group?.display_name).toBe("Original");
				});
			});

			it("lists groups", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.createGroup("g2", "Second");
					expect(await store.listGroups()).toHaveLength(2);
				});
			});
		});

		describe("devices", () => {
			it("enrolls and retrieves a device", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
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
			});

			it("returns null for missing enrollment", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					expect(await store.getEnrollment("g1", "missing")).toBeNull();
				});
			});

			it("upserts on re-enroll", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
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
			});

			it("lists enrolled devices", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
					await store.enrollDevice("g1", { deviceId: "d2", fingerprint: "fp2", publicKey: "pk2" });
					expect(await store.listEnrolledDevices("g1")).toHaveLength(2);
				});
			});

			it("renames a device", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
					expect(await store.renameDevice("g1", "d1", "Desktop")).toBe(true);
					const enrollment = await store.getEnrollment("g1", "d1");
					expect(enrollment?.display_name).toBe("Desktop");
				});
			});

			it("disables and re-enables a device", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
					await store.setDeviceEnabled("g1", "d1", false);
					expect(await store.listEnrolledDevices("g1")).toHaveLength(0);
					expect(await store.listEnrolledDevices("g1", true)).toHaveLength(1);
					await store.setDeviceEnabled("g1", "d1", true);
					expect(await store.listEnrolledDevices("g1")).toHaveLength(1);
				});
			});

			it("removes a device and its presence", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
					await store.upsertPresence({
						groupId: "g1",
						deviceId: "d1",
						addresses: ["http://localhost:9000"],
						ttlS: 300,
					});
					expect(await store.removeDevice("g1", "d1")).toBe(true);
					expect(await store.getEnrollment("g1", "d1")).toBeNull();
					expect(await store.listGroupPeers("g1", "d2")).toEqual([]);
				});
			});

			it("returns false when removing a non-existent device", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					expect(await store.removeDevice("g1", "ghost")).toBe(false);
				});
			});
		});

		describe("presence", () => {
			it("upserts presence and returns normalized data", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
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
			});

			it("lists group peers excluding requesting device", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
					await store.enrollDevice("g1", { deviceId: "d2", fingerprint: "fp2", publicKey: "pk2" });
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
					const peers = await store.listGroupPeers("g1", "d1");
					expect(peers).toHaveLength(1);
					const peer = peers[0]!;
					expect(peer.device_id).toBe("d2");
					expect(peer.public_key).toBe("pk2");
					expect(peer.stale).toBe(false);
					expect(peer.addresses).toEqual(["http://localhost:9001"]);
				});
			});

			it("marks stale presence with empty addresses", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
					await store.enrollDevice("g1", { deviceId: "d2", fingerprint: "fp2", publicKey: "pk2" });
					await store.upsertPresence({
						groupId: "g1",
						deviceId: "d2",
						addresses: ["http://localhost:9001"],
						ttlS: 0,
					});
					const peers = await store.listGroupPeers("g1", "d1");
					expect(peers).toHaveLength(1);
					const peer = peers[0]!;
					expect(peer.stale).toBe(true);
					expect(peer.addresses).toEqual([]);
				});
			});

			it("shows enrolled peers with no presence record", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", { deviceId: "d1", fingerprint: "fp1", publicKey: "pk1" });
					await store.enrollDevice("g1", { deviceId: "d2", fingerprint: "fp2", publicKey: "pk2" });
					const peers = await store.listGroupPeers("g1", "d1");
					expect(peers).toHaveLength(1);
					const peer = peers[0]!;
					expect(peer.device_id).toBe("d2");
					expect(peer.stale).toBe(true);
					expect(peer.addresses).toEqual([]);
				});
			});
		});

		describe("invites", () => {
			it("creates an invite and retrieves by token", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
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
			});

			it("returns null for unknown token", async () => {
				await withContext(async ({ store }) => {
					expect(await store.getInviteByToken("nonexistent")).toBeNull();
				});
			});

			it("lists invites for a group", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
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
		});

		describe("join requests", () => {
			it("creates a join request in pending status", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "manual_review",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					const req = await store.createJoinRequest({
						groupId: "g1",
						deviceId: "d-new",
						publicKey: "pk-new",
						fingerprint: "fp-new",
						displayName: "New Device",
						token: invite.token,
					});
					expect(req.request_id).toBeTruthy();
					expect(req.status).toBe("pending");
					expect(req.device_id).toBe("d-new");
				});
			});

			it("lists pending join requests", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "manual_review",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					await store.createJoinRequest({
						groupId: "g1",
						deviceId: "d1",
						publicKey: "pk1",
						fingerprint: "fp1",
						token: invite.token,
					});
					await store.createJoinRequest({
						groupId: "g1",
						deviceId: "d2",
						publicKey: "pk2",
						fingerprint: "fp2",
						token: invite.token,
					});
					expect(await store.listJoinRequests("g1")).toHaveLength(2);
				});
			});

			it("approves a join request and enrolls the device", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "manual_review",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					const req = await store.createJoinRequest({
						groupId: "g1",
						deviceId: "d-new",
						publicKey: "pk-new",
						fingerprint: "fp-new",
						displayName: "New Device",
						token: invite.token,
					});
					const reviewed = await store.reviewJoinRequest({
						requestId: req.request_id as string,
						approved: true,
						reviewedBy: "admin",
					});
					expect(reviewed).not.toBeNull();
					expect(reviewed?.status).toBe("approved");
					expect(reviewed?.reviewed_by).toBe("admin");
					const enrollment = await store.getEnrollment("g1", "d-new");
					expect(enrollment?.fingerprint).toBe("fp-new");
				});
			});

			it("denies a join request without enrolling", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "manual_review",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					const req = await store.createJoinRequest({
						groupId: "g1",
						deviceId: "d-new",
						publicKey: "pk-new",
						fingerprint: "fp-new",
						token: invite.token,
					});
					const reviewed = await store.reviewJoinRequest({
						requestId: req.request_id as string,
						approved: false,
					});
					expect(reviewed?.status).toBe("denied");
					expect(await store.getEnrollment("g1", "d-new")).toBeNull();
				});
			});

			it("returns null for missing request_id", async () => {
				await withContext(async ({ store }) => {
					expect(await store.reviewJoinRequest({ requestId: "nope", approved: true })).toBeNull();
				});
			});

			it("returns _no_transition for already-reviewed request", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "manual_review",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					const req = await store.createJoinRequest({
						groupId: "g1",
						deviceId: "d-new",
						publicKey: "pk-new",
						fingerprint: "fp-new",
						token: invite.token,
					});
					await store.reviewJoinRequest({ requestId: req.request_id as string, approved: true });
					const again = await store.reviewJoinRequest({
						requestId: req.request_id as string,
						approved: false,
					});
					expect(again?._no_transition).toBe(true);
				});
			});
		});

		describe("reciprocal approvals", () => {
			it("creates and lists a pending outgoing reciprocal approval", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					const request = await store.createReciprocalApproval({
						groupId: "g1",
						requestingDeviceId: "d1",
						requestedDeviceId: "d2",
					});
					expect(request.status).toBe("pending");
					expect(
						await store.listReciprocalApprovals({
							groupId: "g1",
							deviceId: "d1",
							direction: "outgoing",
						}),
					).toEqual([
						expect.objectContaining({ request_id: request.request_id, status: "pending" }),
					]);
				});
			});

			it("surfaces incoming pending reciprocal approvals for the requested device", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.createReciprocalApproval({
						groupId: "g1",
						requestingDeviceId: "d1",
						requestedDeviceId: "d2",
					});
					expect(
						await store.listReciprocalApprovals({
							groupId: "g1",
							deviceId: "d2",
							direction: "incoming",
						}),
					).toEqual([
						expect.objectContaining({ requesting_device_id: "d1", requested_device_id: "d2" }),
					]);
				});
			});

			it("completes the reverse pending approval when the second device also approves", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.createReciprocalApproval({
						groupId: "g1",
						requestingDeviceId: "d1",
						requestedDeviceId: "d2",
					});
					const completed = await store.createReciprocalApproval({
						groupId: "g1",
						requestingDeviceId: "d2",
						requestedDeviceId: "d1",
					});
					expect(completed.status).toBe("completed");
					expect(
						await store.listReciprocalApprovals({
							groupId: "g1",
							deviceId: "d1",
							direction: "incoming",
						}),
					).toEqual([]);
					expect(
						await store.listReciprocalApprovals({
							groupId: "g1",
							deviceId: "d2",
							direction: "incoming",
						}),
					).toEqual([]);
				});
			});
		});

		describe("nonces", () => {
			it("records a nonce once and rejects replay", async () => {
				await withContext(async ({ store }) => {
					expect(await store.recordNonce("d1", "nonce-1", "2026-03-28T00:00:00Z")).toBe(true);
					expect(await store.recordNonce("d1", "nonce-1", "2026-03-28T00:00:01Z")).toBe(false);
				});
			});

			it("allows nonce cleanup and reuse after cutoff", async () => {
				await withContext(async ({ store }) => {
					expect(await store.recordNonce("d1", "nonce-1", "2026-03-28T00:00:00Z")).toBe(true);
					await store.cleanupNonces("2026-03-28T00:00:01Z");
					expect(await store.recordNonce("d1", "nonce-1", "2026-03-28T00:00:02Z")).toBe(true);
				});
			});
		});
	});
}
