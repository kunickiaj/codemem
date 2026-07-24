import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	CoordinatorCreateInviteInput,
	CoordinatorStore,
} from "./coordinator-store-contract.js";
import {
	canonicalRecipientReviewedIntentJson,
	recipientReviewedIntentDigest,
} from "./recipient-reviewed-intent.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

function teamReviewedIntent(teamId: string) {
	return {
		version: 1,
		journey: "team",
		team: { teamId, displayName: "Core Team", futureProjectsInherit: true },
		projects: [],
		excludedProjects: [],
	};
}

function addDeviceReviewedIntent(identityId: string) {
	return {
		version: 1,
		journey: "add_device",
		targetIdentity: { identityId, displayName: "Brian" },
		projects: [],
		excludedProjects: [],
	};
}

export interface CoordinatorStoreHarnessContext<
	TStore extends CoordinatorStore = CoordinatorStore,
> {
	store: TStore;
	clearInviteReviewedIntent: (inviteId: string) => Promise<void> | void;
	revokeInvite: (inviteId: string, revokedAt: string) => Promise<void> | void;
	cleanup: () => Promise<void> | void;
}

export function runCoordinatorStoreContract<TStore extends CoordinatorStore>(
	label: string,
	setup: () => CoordinatorStoreHarnessContext<TStore>,
): void {
	describe(label, () => {
		let effectSequence = 0;
		const nextEffect = (action: "grant" | "revoke") =>
			`contract:${label}:${action}:${++effectSequence}`;

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

			it("renames a group", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Original");
					expect(await store.renameGroup("g1", "Renamed")).toBe(true);
					const group = await store.getGroup("g1");
					expect(group?.display_name).toBe("Renamed");
				});
			});

			it("archives and unarchives a group", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					expect(await store.archiveGroup("g1", "2026-04-14T00:00:00.000Z")).toBe(true);
					expect(await store.listGroups()).toEqual([]);
					expect(await store.listGroups(true)).toEqual([
						expect.objectContaining({
							group_id: "g1",
							archived_at: "2026-04-14T00:00:00.000Z",
						}),
					]);
					expect(await store.unarchiveGroup("g1")).toBe(true);
					expect(await store.listGroups()).toEqual([
						expect.objectContaining({ group_id: "g1", archived_at: null }),
					]);
				});
			});
		});

		describe("scope memberships", () => {
			it("creates and lists scopes with explicit authority fields", async () => {
				await withContext(async ({ store }) => {
					const scope = await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						kind: "team",
						authorityType: "coordinator",
						coordinatorId: "coord-a",
						groupId: "group-a",
						manifestIssuerDeviceId: "admin-device",
						membershipEpoch: 7,
						manifestHash: "hash-1",
					});

					expect(scope).toEqual(
						expect.objectContaining({
							scope_id: "scope-acme",
							label: "Acme Work",
							kind: "team",
							coordinator_id: "coord-a",
							group_id: "group-a",
							membership_epoch: 7,
							manifest_issuer_device_id: "admin-device",
							manifest_hash: "hash-1",
							status: "active",
						}),
					);
					expect(await store.listScopes({ coordinatorId: "coord-a", groupId: "group-a" })).toEqual([
						expect.objectContaining({ scope_id: "scope-acme" }),
					]);
				});
			});

			it("rejects duplicate scope ids instead of silently changing authority", async () => {
				await withContext(async ({ store }) => {
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						coordinatorId: "coord-a",
						groupId: "group-a",
					});

					await expect(
						store.createScope({
							scopeId: "scope-acme",
							label: "Conflicting Work",
							coordinatorId: "coord-b",
							groupId: "group-b",
						}),
					).rejects.toThrow("scopeId already exists");
					expect(await store.listScopes({ includeInactive: true })).toEqual([
						expect.objectContaining({
							scope_id: "scope-acme",
							label: "Acme Work",
							coordinator_id: "coord-a",
							group_id: "group-a",
						}),
					]);
				});
			});

			it("keeps group enrollment separate from scope grants", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("group-a");
					await store.enrollDevice("group-a", {
						deviceId: "device-a",
						fingerprint: "fp-a",
						publicKey: "pk-a",
					});
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						coordinatorId: "coord-a",
						groupId: "group-a",
					});

					expect(await store.listScopeMemberships("scope-acme")).toEqual([]);
					expect(await store.listScopeMembershipAuditEvents({ scopeId: "scope-acme" })).toEqual([]);

					await store.grantScopeMembership({
						effectId: nextEffect("grant"),
						scopeId: "scope-acme",
						deviceId: "device-a",
					});

					expect(await store.listScopeMemberships("scope-acme")).toEqual([
						expect.objectContaining({
							device_id: "device-a",
							status: "active",
							coordinator_id: "coord-a",
							group_id: "group-a",
						}),
					]);
				});
			});

			it("rejects scope grants with mismatched authority fields", async () => {
				await withContext(async ({ store }) => {
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						coordinatorId: "coord-a",
						groupId: "shared-group",
					});
					await store.createScope({
						scopeId: "scope-other",
						label: "Other Work",
						coordinatorId: "coord-b",
						groupId: "shared-group",
					});

					await expect(
						store.grantScopeMembership({
							effectId: nextEffect("grant"),
							scopeId: "scope-acme",
							deviceId: "device-a",
							coordinatorId: "coord-b",
							groupId: "shared-group",
						}),
					).rejects.toThrow("membership coordinatorId must match the scope coordinatorId");
					await expect(
						store.grantScopeMembership({
							effectId: nextEffect("grant"),
							scopeId: "scope-acme",
							deviceId: "device-a",
							coordinatorId: "coord-a",
							groupId: "other-group",
						}),
					).rejects.toThrow("membership groupId must match the scope groupId");
					expect(await store.listScopeMemberships("scope-acme")).toEqual([]);
				});
			});

			it("requires scope members to be enrolled in the scope group", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("group-a");
					await store.createGroup("group-b");
					await store.enrollDevice("group-b", {
						deviceId: "device-a",
						fingerprint: "fp-a",
						publicKey: "pk-a",
					});
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						groupId: "group-a",
					});

					await expect(
						store.grantScopeMembership({
							effectId: nextEffect("grant"),
							scopeId: "scope-acme",
							deviceId: "device-a",
						}),
					).rejects.toThrow("device must be enrolled and enabled in the scope group");

					await store.enrollDevice("group-a", {
						deviceId: "device-a",
						fingerprint: "fp-a",
						publicKey: "pk-a",
					});
					expect(await store.setDeviceEnabled("group-a", "device-a", false)).toBe(true);
					await expect(
						store.grantScopeMembership({
							effectId: nextEffect("grant"),
							scopeId: "scope-acme",
							deviceId: "device-a",
						}),
					).rejects.toThrow("device must be enrolled and enabled in the scope group");

					expect(await store.setDeviceEnabled("group-a", "device-a", true)).toBe(true);
					await expect(
						store.grantScopeMembership({
							effectId: nextEffect("grant"),
							scopeId: "scope-acme",
							deviceId: "device-a",
						}),
					).resolves.toEqual(expect.objectContaining({ status: "active" }));
				});
			});

			it("grants and revokes explicit device membership per scope", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("group-a");
					await store.enrollDevice("group-a", {
						deviceId: "device-a",
						fingerprint: "fp-a",
						publicKey: "pk-a",
					});
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						coordinatorId: "coord-a",
						groupId: "group-a",
					});
					const grant = await store.grantScopeMembership({
						effectId: nextEffect("grant"),
						scopeId: "scope-acme",
						deviceId: "device-a",
						role: "admin",
						membershipEpoch: 3,
						manifestIssuerDeviceId: "admin-device",
						manifestHash: "hash-grant",
						signedManifestJson: '{"grant":true}',
						actorType: "admin",
						actorId: "admin-device",
					});

					expect(grant).toEqual(
						expect.objectContaining({
							device_id: "device-a",
							role: "admin",
							status: "active",
							membership_epoch: 3,
							coordinator_id: "coord-a",
							group_id: "group-a",
							manifest_issuer_device_id: "admin-device",
							manifest_hash: "hash-grant",
							signed_manifest_json: '{"grant":true}',
						}),
					);

					expect(
						await store.revokeScopeMembership({
							effectId: nextEffect("revoke"),
							scopeId: "scope-acme",
							deviceId: "device-a",
							membershipEpoch: 4,
							manifestHash: "hash-revoke",
							signedManifestJson: '{"grant":false}',
							actorType: "admin",
							actorId: "admin-device",
						}),
					).toBe(true);
					expect(await store.listScopeMemberships("scope-acme")).toEqual([]);
					expect(await store.listScopeMemberships("scope-acme", true)).toEqual([
						expect.objectContaining({
							device_id: "device-a",
							status: "revoked",
							membership_epoch: 4,
							manifest_hash: "hash-revoke",
							signed_manifest_json: '{"grant":false}',
						}),
					]);
					expect(await store.listScopeMembershipAuditEvents({ scopeId: "scope-acme" })).toEqual([
						expect.objectContaining({
							effect_id: expect.stringContaining(":grant:"),
							action: "grant",
							scope_id: "scope-acme",
							device_id: "device-a",
							role: "admin",
							status: "active",
							membership_epoch: 3,
							previous_role: null,
							previous_status: null,
							previous_membership_epoch: null,
							coordinator_id: "coord-a",
							group_id: "group-a",
							actor_type: "admin",
							actor_id: "admin-device",
							manifest_hash: "hash-grant",
						}),
						expect.objectContaining({
							effect_id: expect.stringContaining(":revoke:"),
							action: "revoke",
							scope_id: "scope-acme",
							device_id: "device-a",
							role: "admin",
							status: "revoked",
							membership_epoch: 4,
							previous_role: "admin",
							previous_status: "active",
							previous_membership_epoch: 3,
							coordinator_id: "coord-a",
							group_id: "group-a",
							actor_type: "admin",
							actor_id: "admin-device",
							manifest_hash: "hash-revoke",
						}),
					]);
					expect(
						await store.listScopeMembershipAuditEvents({
							scopeId: "scope-acme",
							deviceId: "device-a",
							limit: 1,
						}),
					).toHaveLength(1);
				});
			});

			it("rejects first-time grant epochs below the scope epoch", async () => {
				await withContext(async ({ store }) => {
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						membershipEpoch: 7,
					});

					await expect(
						store.grantScopeMembership({
							effectId: "test:grant:scope-acme:device-a:below-epoch",
							scopeId: "scope-acme",
							deviceId: "device-a",
							membershipEpoch: 6,
						}),
					).rejects.toThrow("membershipEpoch must not be lower than the scope membershipEpoch");
					expect(await store.listScopeMemberships("scope-acme", true)).toEqual([]);
				});
			});

			it("keeps membership epochs monotonic across revoke and re-grant", async () => {
				await withContext(async ({ store }) => {
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						membershipEpoch: 7,
					});
					await store.grantScopeMembership({
						effectId: nextEffect("grant"),
						scopeId: "scope-acme",
						deviceId: "device-a",
					});
					expect(
						await store.revokeScopeMembership({
							effectId: nextEffect("revoke"),
							scopeId: "scope-acme",
							deviceId: "device-a",
						}),
					).toBe(true);
					expect(await store.listScopeMemberships("scope-acme", true)).toEqual([
						expect.objectContaining({
							device_id: "device-a",
							status: "revoked",
							membership_epoch: 8,
						}),
					]);
					await expect(
						store.grantScopeMembership({
							effectId: nextEffect("grant"),
							scopeId: "scope-acme",
							deviceId: "device-a",
							membershipEpoch: 8,
						}),
					).rejects.toThrow("membershipEpoch must not move backwards");
					expect(await store.listScopeMemberships("scope-acme", true)).toEqual([
						expect.objectContaining({
							device_id: "device-a",
							status: "revoked",
							membership_epoch: 8,
						}),
					]);

					const regrant = await store.grantScopeMembership({
						effectId: nextEffect("grant"),
						scopeId: "scope-acme",
						deviceId: "device-a",
					});

					expect(regrant).toEqual(
						expect.objectContaining({
							status: "active",
							membership_epoch: 9,
						}),
					);
					await expect(
						store.revokeScopeMembership({
							effectId: nextEffect("revoke"),
							scopeId: "scope-acme",
							deviceId: "device-a",
							membershipEpoch: 8,
						}),
					).rejects.toThrow("membershipEpoch must increase on revoke");
					await expect(
						store.grantScopeMembership({
							effectId: nextEffect("grant"),
							scopeId: "scope-acme",
							deviceId: "device-a",
							membershipEpoch: 8,
						}),
					).rejects.toThrow("membershipEpoch must not move backwards");
				});
			});

			it("keeps grants and revocations isolated per scope", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("group-a");
					await store.enrollDevice("group-a", {
						deviceId: "device-a",
						fingerprint: "fp-a",
						publicKey: "pk-a",
					});
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						groupId: "group-a",
						membershipEpoch: 2,
					});
					await store.createScope({
						scopeId: "scope-oss",
						label: "OSS codemem",
						groupId: "group-a",
						membershipEpoch: 2,
					});

					await store.grantScopeMembership({
						effectId: nextEffect("grant"),
						scopeId: "scope-acme",
						deviceId: "device-a",
					});
					await store.grantScopeMembership({
						effectId: nextEffect("grant"),
						scopeId: "scope-oss",
						deviceId: "device-a",
					});
					expect(
						await store.revokeScopeMembership({
							effectId: nextEffect("revoke"),
							scopeId: "scope-acme",
							deviceId: "device-a",
							membershipEpoch: 3,
						}),
					).toBe(true);

					expect(await store.listScopeMemberships("scope-acme")).toEqual([]);
					expect(await store.listScopeMemberships("scope-acme", true)).toEqual([
						expect.objectContaining({
							device_id: "device-a",
							status: "revoked",
							membership_epoch: 3,
						}),
					]);
					expect(await store.listScopeMemberships("scope-oss")).toEqual([
						expect.objectContaining({
							device_id: "device-a",
							status: "active",
							membership_epoch: 2,
						}),
					]);
				});
			});

			it("keeps group presence independent from scope revocation", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("group-a");
					await store.enrollDevice("group-a", {
						deviceId: "device-a",
						fingerprint: "fp-a",
						publicKey: "pk-a",
					});
					await store.enrollDevice("group-a", {
						deviceId: "device-b",
						fingerprint: "fp-b",
						publicKey: "pk-b",
					});
					await store.createScope({
						scopeId: "scope-acme",
						label: "Acme Work",
						groupId: "group-a",
					});
					await store.grantScopeMembership({
						effectId: nextEffect("grant"),
						scopeId: "scope-acme",
						deviceId: "device-b",
					});
					await store.upsertPresence({
						groupId: "group-a",
						deviceId: "device-b",
						addresses: ["http://10.0.0.5:7337"],
						ttlS: 300,
					});

					expect(
						await store.revokeScopeMembership({
							effectId: nextEffect("revoke"),
							scopeId: "scope-acme",
							deviceId: "device-b",
						}),
					).toBe(true);

					expect(await store.listScopeMemberships("scope-acme")).toEqual([]);
					expect(await store.listGroupPeers("group-a", "device-a")).toEqual([
						expect.objectContaining({
							device_id: "device-b",
							fingerprint: "fp-b",
							stale: false,
							addresses: ["http://10.0.0.5:7337"],
						}),
					]);
				});
			});

			it("replays identical effects without changing membership or audit history", async () => {
				await withContext(async ({ store }) => {
					await store.createScope({ scopeId: "scope-replay", label: "Replay" });
					const request = {
						effectId: "contract:membership-replay:grant",
						scopeId: "scope-replay",
						deviceId: "device-a",
						membershipEpoch: 4,
					};
					const first = await store.grantScopeMembership(request);
					const replay = await store.grantScopeMembership(request);
					expect(replay).toEqual(first);
					expect(
						await store.listScopeMembershipAuditEvents({ scopeId: "scope-replay" }),
					).toHaveLength(1);

					const revoke = {
						effectId: "contract:membership-replay:revoke",
						scopeId: "scope-replay",
						deviceId: "device-a",
						membershipEpoch: 5,
					};
					expect(await store.revokeScopeMembership(revoke)).toBe(true);
					expect(await store.revokeScopeMembership(revoke)).toBe(true);
					expect(await store.grantScopeMembership(request)).toEqual(first);
					expect(await store.listScopeMemberships("scope-replay", true)).toEqual([
						expect.objectContaining({ status: "revoked", membership_epoch: 5 }),
					]);
					expect(
						await store.listScopeMembershipAuditEvents({ scopeId: "scope-replay" }),
					).toHaveLength(2);
				});
			});

			it("fails closed when an effect id is reused for a different request", async () => {
				await withContext(async ({ store }) => {
					await store.createScope({ scopeId: "scope-conflict", label: "Conflict" });
					await store.grantScopeMembership({
						effectId: "contract:membership-conflict",
						scopeId: "scope-conflict",
						deviceId: "device-a",
						role: "member",
					});
					await expect(
						store.grantScopeMembership({
							effectId: "contract:membership-conflict",
							scopeId: "scope-conflict",
							deviceId: "device-a",
							role: "admin",
						}),
					).rejects.toThrow("scope_membership_effect_conflict");
					expect(await store.listScopeMemberships("scope-conflict")).toEqual([
						expect.objectContaining({ role: "member", membership_epoch: 0 }),
					]);
					expect(
						await store.listScopeMembershipAuditEvents({ scopeId: "scope-conflict" }),
					).toHaveLength(1);

					const missingRevoke = {
						effectId: "contract:missing-revoke",
						scopeId: "scope-conflict",
						deviceId: "missing-device",
					};
					expect(await store.revokeScopeMembership(missingRevoke)).toBe(false);
					expect(await store.revokeScopeMembership(missingRevoke)).toBe(false);
					await expect(
						store.grantScopeMembership({
							effectId: missingRevoke.effectId,
							scopeId: missingRevoke.scopeId,
							deviceId: missingRevoke.deviceId,
						}),
					).rejects.toThrow("scope_membership_effect_conflict");
					expect(await store.listScopeMemberships("scope-conflict")).toHaveLength(1);
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
					const peer = peers[0];
					if (!peer) throw new Error("expected peer[0]");
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
					const peer = peers[0];
					if (!peer) throw new Error("expected peer[0]");
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
					const peer = peers[0];
					if (!peer) throw new Error("expected peer[0]");
					expect(peer.device_id).toBe("d2");
					expect(peer.stale).toBe(true);
					expect(peer.addresses).toEqual([]);
				});
			});
		});

		describe("invites", () => {
			it.each([
				{ kind: "team_member" as const, targetId: "policy-team-revoked" },
				{ kind: "add_device" as const, targetId: "identity-revoked" },
			])("rejects a revoked $kind invite before first inspection or acceptance", async (testCase) => {
				await withContext(async ({ store, revokeInvite }) => {
					// Arrange
					await store.createGroup("g1", "Coordinator Alpha");
					const reviewedIntent =
						testCase.kind === "team_member"
							? teamReviewedIntent(testCase.targetId)
							: addDeviceReviewedIntent(testCase.targetId);
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						inviteKind: testCase.kind,
						...(testCase.kind === "team_member"
							? { policyTeamId: testCase.targetId }
							: { targetIdentityId: testCase.targetId }),
						reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
						reviewedIntent,
					});
					const acceptance = {
						token: invite.token,
						inviteKind: testCase.kind,
						identityId: testCase.kind === "add_device" ? testCase.targetId : "identity-recipient",
						deviceId: "device-recipient",
						publicKey: "recipient-public-key",
						fingerprint: fingerprintPublicKey("recipient-public-key"),
						now: "2026-07-23T00:00:00.000Z",
					};
					await revokeInvite(invite.invite_id, "2026-07-22T00:00:00.000Z");

					// Act
					const inspection = store.inspectRecipientInvite({
						token: invite.token,
						now: acceptance.now,
					});
					const consumption = store.consumeRecipientInvite(acceptance);

					// Assert
					await Promise.all([
						expect(inspection).rejects.toThrow("invite_invalid"),
						expect(consumption).rejects.toThrow("invite_invalid"),
					]);
					expect(await store.getInviteByTokenForInspection(invite.token)).toMatchObject({
						revoked_at: "2026-07-22T00:00:00.000Z",
						consumed_at: null,
						bound_device_id: null,
						bound_public_key: null,
						bound_fingerprint: null,
						recipient_actor_id: null,
					});
				});
			});

			it.each([
				{ kind: "team_member" as const, targetId: "policy-team-replay" },
				{ kind: "add_device" as const, targetId: "identity-replay" },
			])("rejects a revoked $kind invite after an accepted replay without changing its binding", async (testCase) => {
				await withContext(async ({ store, revokeInvite }) => {
					// Arrange
					await store.createGroup("g1", "Coordinator Alpha");
					const reviewedIntent =
						testCase.kind === "team_member"
							? teamReviewedIntent(testCase.targetId)
							: addDeviceReviewedIntent(testCase.targetId);
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						inviteKind: testCase.kind,
						...(testCase.kind === "team_member"
							? { policyTeamId: testCase.targetId }
							: { targetIdentityId: testCase.targetId }),
						reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
						reviewedIntent,
					});
					const acceptance = {
						token: invite.token,
						inviteKind: testCase.kind,
						identityId: testCase.kind === "add_device" ? testCase.targetId : "identity-recipient",
						deviceId: "device-recipient",
						publicKey: "recipient-public-key",
						fingerprint: fingerprintPublicKey("recipient-public-key"),
						now: "2026-07-23T00:00:00.000Z",
					};
					expect((await store.consumeRecipientInvite(acceptance)).status).toBe("accepted");
					expect((await store.consumeRecipientInvite(acceptance)).status).toBe("existing");
					const boundBeforeRevocation = await store.getInviteByTokenForInspection(invite.token);
					await revokeInvite(invite.invite_id, "2026-07-23T00:00:01.000Z");

					// Act
					const inspection = store.inspectRecipientInvite({
						token: invite.token,
						now: "2026-07-23T00:00:02.000Z",
					});
					const replay = store.consumeRecipientInvite({
						...acceptance,
						now: "2026-07-23T00:00:02.000Z",
					});

					// Assert
					await Promise.all([
						expect(inspection).rejects.toThrow("invite_invalid"),
						expect(replay).rejects.toThrow("invite_invalid"),
					]);
					const boundAfterRevocation = await store.getInviteByTokenForInspection(invite.token);
					expect(boundAfterRevocation).toMatchObject({
						revoked_at: "2026-07-23T00:00:01.000Z",
						consumed_at: boundBeforeRevocation?.consumed_at,
						bound_device_id: boundBeforeRevocation?.bound_device_id,
						bound_public_key: boundBeforeRevocation?.bound_public_key,
						bound_fingerprint: boundBeforeRevocation?.bound_fingerprint,
						recipient_actor_id: boundBeforeRevocation?.recipient_actor_id,
					});
				});
			});

			it("persists and single-use binds explicit Team and add-device invitations without scope membership", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Coordinator Alpha");
					await store.createScope({ scopeId: "scope-project", label: "Project" });
					const reviewedIntent = teamReviewedIntent("policy-team-1");
					const digest = await recipientReviewedIntentDigest(reviewedIntent);
					const teamInvite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						inviteKind: "team_member",
						policyTeamId: "policy-team-1",
						reviewedPreviewDigest: digest,
						reviewedIntent,
					});
					expect(teamInvite).toMatchObject({
						invite_kind: "team_member",
						policy_team_id: "policy-team-1",
						reviewed_preview_digest: digest,
						reviewed_intent_json: canonicalRecipientReviewedIntentJson(reviewedIntent),
					});
					const teamInspection = await store.inspectRecipientInvite({
						token: teamInvite.token,
						now: "2026-07-21T00:00:00.000Z",
					});
					expect(teamInspection).toMatchObject({
						kind: "team_member",
						policy_team_id: "policy-team-1",
						reviewed_intent: reviewedIntent,
						bound: false,
					});
					const publicKey = "team-member-key";
					const teamInput = {
						token: teamInvite.token,
						inviteKind: "team_member" as const,
						identityId: "identity-brian",
						deviceId: "device-brian",
						publicKey,
						fingerprint: fingerprintPublicKey(publicKey),
						now: "2026-07-21T00:00:00.000Z",
					};
					const acceptedTeam = await store.consumeRecipientInvite(teamInput);
					const replayedTeam = await store.consumeRecipientInvite(teamInput);
					expect(acceptedTeam).toMatchObject({
						status: "accepted",
						reviewed_intent: reviewedIntent,
					});
					expect(replayedTeam).toMatchObject({
						status: "existing",
						reviewed_intent: reviewedIntent,
					});
					await expect(
						store.consumeRecipientInvite({ ...teamInput, identityId: "identity-other" }),
					).rejects.toThrow("invite_identity_conflict");
					await expect(
						store.consumeRecipientInvite({ ...teamInput, deviceId: "device-other" }),
					).rejects.toThrow("invite_already_bound");
					await expect(
						store.consumeRecipientInvite({
							...teamInput,
							publicKey: "other-key",
							fingerprint: fingerprintPublicKey("other-key"),
						}),
					).rejects.toThrow("invite_already_bound");

					const addDeviceIntent = addDeviceReviewedIntent("identity-brian");
					const addDeviceInvite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						inviteKind: "add_device",
						targetIdentityId: "identity-brian",
						reviewedPreviewDigest: await recipientReviewedIntentDigest(addDeviceIntent),
						reviewedIntent: addDeviceIntent,
					});
					expect(
						await store.inspectRecipientInvite({
							token: addDeviceInvite.token,
							now: "2026-07-21T00:00:00.000Z",
						}),
					).toMatchObject({ kind: "add_device", target_identity_id: "identity-brian" });
					await expect(
						store.consumeRecipientInvite({
							...teamInput,
							token: addDeviceInvite.token,
							inviteKind: "add_device",
							identityId: "identity-other",
						}),
					).rejects.toThrow("invite_identity_conflict");
					const addDeviceInput = {
						...teamInput,
						token: addDeviceInvite.token,
						inviteKind: "add_device" as const,
						deviceId: "device-brian-2",
						publicKey: "add-device-key",
						fingerprint: fingerprintPublicKey("add-device-key"),
					};
					expect((await store.consumeRecipientInvite(addDeviceInput)).status).toBe("accepted");
					expect((await store.consumeRecipientInvite(addDeviceInput)).status).toBe("existing");
					expect(await store.listScopeMemberships("scope-project")).toEqual([]);
				});
			});

			it("requires reviewed intent for new recipient invites and fails inspection for migrated null snapshots", async () => {
				await withContext(async ({ store, clearInviteReviewedIntent }) => {
					await store.createGroup("g1", "Coordinator Alpha");
					for (const missing of [
						{
							inviteKind: "team_member" as const,
							policyTeamId: "policy-team-1",
							reviewedPreviewDigest: "a".repeat(64),
						},
						{
							inviteKind: "add_device" as const,
							targetIdentityId: "identity-brian",
							reviewedPreviewDigest: "b".repeat(64),
						},
					]) {
						await expect(
							store.createInvite({
								groupId: "g1",
								policy: "auto_admit",
								expiresAt: "2099-01-01T00:00:00Z",
								...missing,
							}),
						).rejects.toThrow("recipient_invite_review_unavailable");
					}

					const legacyIntent = teamReviewedIntent("policy-team-1");
					const missing = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						inviteKind: "team_member",
						policyTeamId: "policy-team-1",
						reviewedPreviewDigest: await recipientReviewedIntentDigest(legacyIntent),
						reviewedIntent: legacyIntent,
					});
					await clearInviteReviewedIntent(missing.invite_id);
					expect(await store.getInviteByTokenForInspection(missing.token)).toMatchObject({
						invite_id: missing.invite_id,
						reviewed_intent_json: null,
					});
					await expect(
						store.inspectRecipientInvite({
							token: missing.token,
							now: "2026-07-21T00:00:00.000Z",
						}),
					).rejects.toThrow("recipient_invite_review_unavailable");
					const valid = teamReviewedIntent("policy-team-1");
					await expect(
						store.createInvite({
							groupId: "g1",
							policy: "auto_admit",
							expiresAt: "2099-01-01T00:00:00Z",
							inviteKind: "team_member",
							policyTeamId: "policy-team-1",
							reviewedPreviewDigest: await recipientReviewedIntentDigest(valid),
							reviewedIntent: { ...valid, version: 2 },
						}),
					).rejects.toThrow("recipient_reviewed_intent_invalid");
					await expect(
						store.createInvite({
							groupId: "g1",
							policy: "auto_admit",
							expiresAt: "2099-01-01T00:00:00Z",
							inviteKind: "team_member",
							policyTeamId: "policy-team-other",
							reviewedPreviewDigest: await recipientReviewedIntentDigest(valid),
							reviewedIntent: valid,
						}),
					).rejects.toThrow("recipient_invite_intent_mismatch");
					await expect(
						store.createInvite({
							groupId: "g1",
							policy: "auto_admit",
							expiresAt: "2099-01-01T00:00:00Z",
							inviteKind: "team_member",
							policyTeamId: "policy-team-1",
							reviewedPreviewDigest: "0".repeat(64),
							reviewedIntent: valid,
						}),
					).rejects.toThrow("recipient_invite_intent_mismatch");
				});
			});

			it("replays only the exact consumed recipient binding after expiry", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Coordinator Alpha");
					const publicKey = "post-expiry-key";
					const reviewedIntent = teamReviewedIntent("policy-team-1");
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2026-07-21T00:00:01.000Z",
						inviteKind: "team_member",
						policyTeamId: "policy-team-1",
						reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
						reviewedIntent,
					});
					const input = {
						token: invite.token,
						inviteKind: "team_member" as const,
						identityId: "identity-brian",
						deviceId: "device-brian",
						publicKey,
						fingerprint: fingerprintPublicKey(publicKey),
						now: "2026-07-21T00:00:00.000Z",
					};

					expect((await store.consumeRecipientInvite(input)).status).toBe("accepted");
					expect(
						await store.inspectRecipientInvite({
							token: invite.token,
							now: "2026-07-21T00:00:02.000Z",
						}),
					).toMatchObject({ kind: "team_member", bound: true });
					const replay = await store.consumeRecipientInvite({
						...input,
						now: "2026-07-21T00:00:02.000Z",
					});
					expect(replay.status).toBe("existing");
					await expect(
						store.consumeRecipientInvite({
							...input,
							deviceId: "device-other",
							now: "2026-07-21T00:00:02.000Z",
						}),
					).rejects.toThrow("invite_already_bound");
					await expect(
						store.consumeRecipientInvite({
							...input,
							identityId: "identity-other",
							now: "2026-07-21T00:00:02.000Z",
						}),
					).rejects.toThrow("invite_identity_conflict");
					const otherPublicKey = "post-expiry-other-key";
					await expect(
						store.consumeRecipientInvite({
							...input,
							publicKey: otherPublicKey,
							fingerprint: fingerprintPublicKey(otherPublicKey),
							now: "2026-07-21T00:00:02.000Z",
						}),
					).rejects.toThrow("invite_already_bound");
				});
			});

			it("rejects first recipient invite use after expiry", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Coordinator Alpha");
					const publicKey = "expired-first-use-key";
					const reviewedIntent = addDeviceReviewedIntent("identity-brian");
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2026-07-21T00:00:01.000Z",
						inviteKind: "add_device",
						targetIdentityId: "identity-brian",
						reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
						reviewedIntent,
					});

					await expect(
						store.consumeRecipientInvite({
							token: invite.token,
							inviteKind: "add_device",
							identityId: "identity-brian",
							deviceId: "device-brian",
							publicKey,
							fingerprint: fingerprintPublicKey(publicKey),
							now: "2026-07-21T00:00:02.000Z",
						}),
					).rejects.toThrow("invite_expired");
				});
			});

			it("fails closed when recipient invitations expire or their coordinator group is archived", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Coordinator Alpha");
					const teamIntent = teamReviewedIntent("policy-team-1");
					const expired = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2000-01-01T00:00:00Z",
						inviteKind: "team_member",
						policyTeamId: "policy-team-1",
						reviewedPreviewDigest: await recipientReviewedIntentDigest(teamIntent),
						reviewedIntent: teamIntent,
					});
					await expect(
						store.inspectRecipientInvite({
							token: expired.token,
							now: "2026-07-21T00:00:00.000Z",
						}),
					).rejects.toThrow("invite_expired");
					await expect(
						store.consumeRecipientInvite({
							token: expired.token,
							inviteKind: "team_member",
							identityId: "identity-brian",
							deviceId: "device-brian",
							publicKey: "expired-key",
							fingerprint: fingerprintPublicKey("expired-key"),
							now: "2026-07-21T00:00:00.000Z",
						}),
					).rejects.toThrow("invite_expired");
					const addDeviceIntent = addDeviceReviewedIntent("identity-brian");
					const active = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						inviteKind: "add_device",
						targetIdentityId: "identity-brian",
						reviewedPreviewDigest: await recipientReviewedIntentDigest(addDeviceIntent),
						reviewedIntent: addDeviceIntent,
					});
					await store.archiveGroup("g1", "2026-07-21T00:00:00.000Z");
					await expect(
						store.inspectRecipientInvite({
							token: active.token,
							now: "2026-07-21T00:00:00.000Z",
						}),
					).rejects.toThrow("group_archived");
					await expect(
						store.consumeRecipientInvite({
							token: active.token,
							inviteKind: "add_device",
							identityId: "identity-brian",
							deviceId: "device-brian",
							publicKey: "archived-key",
							fingerprint: fingerprintPublicKey("archived-key"),
							now: "2026-07-21T00:00:00.000Z",
						}),
					).rejects.toThrow("group_archived");
				});
			});

			it("fails closed for archived groups and mismatched public-key fingerprints", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const operationId = `share_${"7".repeat(40)}`;
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest: "6".repeat(64),
						projectIntent: [
							{
								canonical_identity: "git:https://example.test/codemem",
								display_name: "codemem",
								existing_memory_count: 0,
							},
						],
					});
					const input = {
						token: invite.token,
						operationId,
						deviceId: "device",
						publicKey: "key",
						fingerprint: "wrong",
						recipientActorId: "actor",
						recipientDisplayName: "Brian",
						deviceDisplayName: "Brian's Mac",
						now: "2026-07-20T00:00:00.000Z",
					};
					await expect(store.consumeProjectInvite(input)).rejects.toThrow("fingerprint_mismatch");
					await store.archiveGroup("g1", "2026-07-20T00:00:00.000Z");
					await expect(
						store.consumeProjectInvite({ ...input, fingerprint: fingerprintPublicKey("key") }),
					).rejects.toThrow("group_archived");
				});
			});

			it("distinguishes expired and invalid project invite acceptance", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const operationId = `share_${"9".repeat(40)}`;
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2000-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest: "8".repeat(64),
						projectIntent: [
							{
								canonical_identity: "git:https://example.test/codemem",
								display_name: "codemem",
								existing_memory_count: 0,
							},
						],
					});
					const input = {
						token: invite.token,
						operationId,
						deviceId: "device",
						publicKey: "key",
						fingerprint: fingerprintPublicKey("key"),
						recipientActorId: "actor",
						recipientDisplayName: "Brian",
						deviceDisplayName: "Brian's Mac",
						now: "2026-07-20T00:00:00.000Z",
					};
					await expect(store.consumeProjectInvite(input)).rejects.toThrow("invite_expired");
					await expect(store.consumeProjectInvite({ ...input, token: "invalid" })).rejects.toThrow(
						"invite_invalid",
					);
				});
			});

			it("atomically binds a project invite and returns the same acceptance only to the same identity", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					await store.enrollDevice("g1", {
						deviceId: "seed-1",
						fingerprint: "seed-fp",
						publicKey: "seed-pk",
					});
					const operationId = `share_${"a".repeat(40)}`;
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest: "b".repeat(64),
						inviterActorId: "actor-adam",
						inviterDisplayName: "Adam",
						inviterDeviceId: "seed-1",
						pendingPersonId: "pending-brian",
						projectSummaries: [{ display_name: "codemem", existing_memory_count: 3 }],
						projectIntent: [
							{
								canonical_identity: "git:https://example.test/codemem",
								display_name: "codemem",
								existing_memory_count: 3,
							},
						],
					});
					const publicKey = "brian-key";
					const input = {
						token: invite.token,
						operationId,
						deviceId: "brian-device",
						publicKey,
						fingerprint: fingerprintPublicKey(publicKey),
						recipientActorId: "actor-brian",
						recipientDisplayName: "Brian",
						deviceDisplayName: "Brian's MacBook",
						now: "2026-07-20T00:00:00.000Z",
					};
					const accepted = await store.consumeProjectInvite(input);
					const retry = await store.consumeProjectInvite(input);
					const retryAfterExpiry = await store.consumeProjectInvite({
						...input,
						now: "2100-01-01T00:00:00.000Z",
					});
					expect(accepted.status).toBe("accepted");
					expect(retry.status).toBe("existing");
					expect(retryAfterExpiry.status).toBe("existing");
					expect(retry.invite).toMatchObject({
						bound_device_id: "brian-device",
						recipient_actor_id: "actor-brian",
						recipient_device_display_name: "Brian's MacBook",
						trust_state: "bootstrap_grant_created",
					});
					expect(retry.bootstrap_grant?.seed_device_id).toBe("seed-1");
					await expect(
						store.consumeProjectInvite({ ...input, deviceId: "other-device" }),
					).rejects.toThrow("invite_already_bound");
					await expect(
						store.consumeProjectInvite({
							...input,
							publicKey: "other-key",
							fingerprint: fingerprintPublicKey("other-key"),
						}),
					).rejects.toThrow("invite_already_bound");
					await expect(
						store.consumeProjectInvite({ ...input, operationId: `share_${"c".repeat(40)}` }),
					).rejects.toThrow("invite_invalid");
					await expect(
						store.consumeProjectInvite({ ...input, recipientDisplayName: "Not Brian" }),
					).rejects.toThrow("invite_identity_conflict");
				});
			});

			it("reports one accepted result for concurrent identical consumes", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const operationId = `share_${"4".repeat(40)}`;
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest: "3".repeat(64),
						projectIntent: [
							{
								canonical_identity: "workspace:codemem",
								display_name: "codemem",
								existing_memory_count: 1,
							},
						],
					});
					const publicKey = "race-key";
					const input = {
						token: invite.token,
						operationId,
						deviceId: "race-device",
						publicKey,
						fingerprint: fingerprintPublicKey(publicKey),
						recipientActorId: "race-actor",
						recipientDisplayName: "Brian",
						deviceDisplayName: "Brian's Mac",
						now: "2026-07-20T00:00:00.000Z",
					};
					const results = await Promise.all([
						store.consumeProjectInvite(input),
						store.consumeProjectInvite(input),
					]);
					expect(results.map((result) => result.status).toSorted()).toEqual([
						"accepted",
						"existing",
					]);
					const saved = await store.getInviteByTokenForInspection(invite.token);
					expect(saved?.token).toBe(`consumed:${invite.invite_id}`);
				});
			});

			it("recovers pending inviter bootstrap once and reuses it across retries", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const operationId = `share_${"2".repeat(40)}`;
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest: "1".repeat(64),
						inviterActorId: "actor-adam",
						inviterDeviceId: "seed-later",
						projectIntent: [
							{
								canonical_identity: "workspace:codemem",
								display_name: "codemem",
								existing_memory_count: 1,
							},
						],
					});
					const publicKey = "pending-key";
					const input = {
						token: invite.token,
						operationId,
						deviceId: "pending-device",
						publicKey,
						fingerprint: fingerprintPublicKey(publicKey),
						recipientActorId: "actor-brian",
						recipientDisplayName: "Brian",
						deviceDisplayName: "Brian's Mac",
						now: "2026-07-20T00:00:00.000Z",
					};
					const pending = await store.consumeProjectInvite(input);
					expect(pending.invite.trust_state).toBe("pending_inviter_device");
					expect(pending.bootstrap_grant).toBeNull();
					await store.enrollDevice("g1", {
						deviceId: "seed-later",
						publicKey: "seed-key",
						fingerprint: fingerprintPublicKey("seed-key"),
					});
					const retries = await Promise.all([
						store.consumeProjectInvite(input),
						store.consumeProjectInvite(input),
					]);
					expect(retries.every((result) => result.status === "existing")).toBe(true);
					expect(retries[0]?.invite.trust_state).toBe("bootstrap_grant_created");
					expect(retries[0]?.bootstrap_grant?.grant_id).toBe(retries[1]?.bootstrap_grant?.grant_id);
					expect(await store.listBootstrapGrants("g1")).toHaveLength(1);
				});
			});
			it("retains project-intent references and retries the same operation idempotently", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const input = {
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId: `share_${"a".repeat(40)}`,
						reviewedProjectSetDigest: "b".repeat(64),
					};

					const first = await store.createInvite(input);
					const retry = await store.createInvite(input);

					expect(retry.invite_id).toBe(first.invite_id);
					expect(retry.token).toBe(first.token);
					expect(retry).toMatchObject({
						operation_id: input.operationId,
						reviewed_project_set_digest: input.reviewedProjectSetDigest,
					});
				});
			});

			it("reissues an expired project invite without changing its operation identity", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const operationId = `share_${"c".repeat(40)}`;
					const reviewedProjectSetDigest = "d".repeat(64);
					const expired = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2000-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest,
					});

					const reissued = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest,
					});

					expect(reissued.invite_id).toBe(expired.invite_id);
					expect(reissued.token).not.toBe(expired.token);
					expect(reissued.token_digest).toBe(
						createHash("sha256").update(reissued.token, "utf8").digest("hex"),
					);
					expect(reissued.expires_at).toBe("2099-01-01T00:00:00.000Z");
					expect(reissued.revoked_at).toBeNull();
					expect(await store.getInviteByToken(expired.token)).toBeNull();
					expect(await store.getInviteByToken(reissued.token)).toMatchObject({
						operation_id: operationId,
					});
				});
			});

			it("treats project invite expiry as output when retrying the same operation", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const input = {
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId: `share_${"e".repeat(40)}`,
						reviewedProjectSetDigest: "f".repeat(64),
					};
					const first = await store.createInvite(input);

					const retry = await store.createInvite({
						...input,
						expiresAt: "2099-02-01T00:00:00Z",
					});

					expect(retry.invite_id).toBe(first.invite_id);
					expect(retry.token).toBe(first.token);
					expect(retry.expires_at).toBe(first.expires_at);
				});
			});

			it("returns one invite for concurrent same-intent operation creation", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const input = {
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId: `share_${"d".repeat(40)}`,
						reviewedProjectSetDigest: "e".repeat(64),
					};

					const [first, second] = await Promise.all([
						store.createInvite(input),
						store.createInvite(input),
					]);

					expect(second.invite_id).toBe(first.invite_id);
					expect(second.token).toBe(first.token);
				});
			});

			it("rejects the loser of concurrent conflicting-intent operation creation", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const operationId = `share_${"f".repeat(40)}`;
					const results = await Promise.allSettled([
						store.createInvite({
							groupId: "g1",
							policy: "auto_admit",
							expiresAt: "2099-01-01T00:00:00Z",
							operationId,
							reviewedProjectSetDigest: "1".repeat(64),
						}),
						store.createInvite({
							groupId: "g1",
							policy: "auto_admit",
							expiresAt: "2099-01-01T00:00:00Z",
							operationId,
							reviewedProjectSetDigest: "2".repeat(64),
						}),
					]);

					expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
					const rejected = results.find((result) => result.status === "rejected");
					expect(rejected).toMatchObject({
						status: "rejected",
						reason: expect.objectContaining({ message: "invite_operation_intent_conflict" }),
					});
				});
			});

			it("rejects reuse of an operation id with different reviewed intent", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const operationId = `share_${"a".repeat(40)}`;
					const original = {
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest: "b".repeat(64),
						projectSummaries: [{ display_name: "codemem", existing_memory_count: 1 }],
					} satisfies CoordinatorCreateInviteInput;
					await store.createInvite(original);

					await expect(
						store.createInvite({
							...original,
							reviewedProjectSetDigest: "c".repeat(64),
						}),
					).rejects.toThrow("invite_operation_intent_conflict");
					await expect(
						store.createInvite({
							...original,
							projectSummaries: [{ display_name: "renamed", existing_memory_count: 1 }],
						}),
					).rejects.toThrow("invite_operation_intent_conflict");
				});
			});

			it("rejects a project invite that conflicts with a disabled enrollment identity", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					await store.enrollDevice("g1", {
						deviceId: "disabled-device",
						publicKey: "old-key",
						fingerprint: fingerprintPublicKey("old-key"),
					});
					await store.setDeviceEnabled("g1", "disabled-device", false);
					const operationId = `share_${"6".repeat(40)}`;
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest: "7".repeat(64),
						projectIntent: [
							{
								canonical_identity: "workspace:codemem",
								display_name: "codemem",
								existing_memory_count: 0,
							},
						],
					});

					await expect(
						store.consumeProjectInvite({
							token: invite.token,
							operationId,
							deviceId: "disabled-device",
							publicKey: "new-key",
							fingerprint: fingerprintPublicKey("new-key"),
							recipientActorId: "actor-brian",
							recipientDisplayName: "Brian",
							deviceDisplayName: "Brian's Mac",
							now: "2026-07-20T00:00:00.000Z",
						}),
					).rejects.toThrow("invite_identity_conflict");
				});
			});

			it("does not let a consumed invite retry re-enable an admin-disabled device", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1", "Team Alpha");
					const operationId = `share_${"5".repeat(40)}`;
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
						operationId,
						reviewedProjectSetDigest: "4".repeat(64),
						projectIntent: [
							{
								canonical_identity: "workspace:codemem",
								display_name: "codemem",
								existing_memory_count: 0,
							},
						],
					});
					const publicKey = "accepted-key";
					const input = {
						token: invite.token,
						operationId,
						deviceId: "accepted-device",
						publicKey,
						fingerprint: fingerprintPublicKey(publicKey),
						recipientActorId: "actor-brian",
						recipientDisplayName: "Brian",
						deviceDisplayName: "Brian's Mac",
						now: "2026-07-20T00:00:00.000Z",
					};
					await expect(store.consumeProjectInvite(input)).resolves.toMatchObject({
						status: "accepted",
					});
					await store.setDeviceEnabled("g1", "accepted-device", false);

					await expect(store.consumeProjectInvite(input)).rejects.toThrow(
						"invite_acceptance_incomplete",
					);
					expect(await store.getEnrollment("g1", "accepted-device")).toBeNull();
				});
			});

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
					expect(invite.operation_id ?? null).toBeNull();
					expect(invite.reviewed_project_set_digest ?? null).toBeNull();
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

			it("can mint a bootstrap grant when approving a join request", async () => {
				await withContext(async ({ store }) => {
					await store.createGroup("g1");
					await store.enrollDevice("g1", {
						deviceId: "seed-1",
						fingerprint: "seed-fp",
						publicKey: "seed-pk",
					});
					const invite = await store.createInvite({
						groupId: "g1",
						policy: "approval_required",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					const req = await store.createJoinRequest({
						groupId: "g1",
						deviceId: "worker-1",
						publicKey: "worker-pk",
						fingerprint: "worker-fp",
						token: invite.token,
					});
					const reviewed = await store.reviewJoinRequest({
						requestId: req.request_id as string,
						approved: true,
						bootstrapGrant: {
							seedDeviceId: "seed-1",
							expiresAt: "2099-02-01T00:00:00Z",
						},
					});
					expect(reviewed?.status).toBe("approved");
					expect(reviewed?.bootstrap_grant).toEqual(
						expect.objectContaining({
							group_id: "g1",
							seed_device_id: "seed-1",
							worker_device_id: "worker-1",
						}),
					);
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

		describe("bootstrap grants", () => {
			it("creates and retrieves a bootstrap grant", async () => {
				await withContext(async ({ store }) => {
					const grant = await store.createBootstrapGrant({
						groupId: "g1",
						seedDeviceId: "seed-1",
						workerDeviceId: "worker-1",
						expiresAt: "2099-01-01T00:00:00Z",
						createdBy: "admin",
					});
					const fetched = await store.getBootstrapGrant(grant.grant_id);
					expect(fetched).not.toBeNull();
					expect(fetched?.seed_device_id).toBe("seed-1");
					expect(fetched?.worker_device_id).toBe("worker-1");
				});
			});

			it("lists bootstrap grants for a group", async () => {
				await withContext(async ({ store }) => {
					await store.createBootstrapGrant({
						groupId: "g1",
						seedDeviceId: "seed-1",
						workerDeviceId: "worker-1",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					await store.createBootstrapGrant({
						groupId: "g1",
						seedDeviceId: "seed-1",
						workerDeviceId: "worker-2",
						expiresAt: "2099-02-01T00:00:00Z",
					});
					expect(await store.listBootstrapGrants("g1")).toHaveLength(2);
				});
			});

			it("revokes a bootstrap grant", async () => {
				await withContext(async ({ store }) => {
					const grant = await store.createBootstrapGrant({
						groupId: "g1",
						seedDeviceId: "seed-1",
						workerDeviceId: "worker-1",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					expect(await store.revokeBootstrapGrant(grant.grant_id, "2099-01-02T00:00:00Z")).toBe(
						true,
					);
					const fetched = await store.getBootstrapGrant(grant.grant_id);
					expect(fetched?.revoked_at).toBe("2099-01-02T00:00:00Z");
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

			it("scopes nonce replay checks by device", async () => {
				await withContext(async ({ store }) => {
					expect(await store.recordNonce("d1", "shared-nonce", "2026-03-28T00:00:00Z")).toBe(true);
					expect(await store.recordNonce("d2", "shared-nonce", "2026-03-28T00:00:00Z")).toBe(true);
					expect(await store.recordNonce("d1", "shared-nonce", "2026-03-28T00:00:01Z")).toBe(false);
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
