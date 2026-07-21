import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
	coordinatorCreateScopeAction,
	coordinatorDisableDeviceAction,
	coordinatorEnableDeviceAction,
	coordinatorEnrollDeviceAction,
	coordinatorGrantScopeMembershipAction,
	coordinatorImportInviteAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorListScopeMembershipsAction,
	coordinatorListScopesAction,
	coordinatorRemoveDeviceAction,
	coordinatorRenameDeviceAction,
	coordinatorRevokeScopeMembershipAction,
	coordinatorUpdateScopeAction,
} from "./coordinator-actions.js";
import { encodeInvitePayload } from "./coordinator-invites.js";
import { connect } from "./db.js";
import { fingerprintPublicKey, loadPublicKey } from "./sync-identity.js";

describe("coordinator local admin actions", () => {
	let tmpDir: string;
	let dbPath: string;
	let prevConfigPath: string | undefined;
	let prevDbPath: string | undefined;
	let prevKeysDir: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "coord-actions-test-"));
		dbPath = join(tmpDir, "coordinator.sqlite");
		prevConfigPath = process.env.CODEMEM_CONFIG;
		prevDbPath = process.env.CODEMEM_DB;
		prevKeysDir = process.env.CODEMEM_KEYS_DIR;
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (prevConfigPath == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevConfigPath;
		if (prevDbPath == null) delete process.env.CODEMEM_DB;
		else process.env.CODEMEM_DB = prevDbPath;
		if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
		else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates and lists groups", async () => {
		const group = await coordinatorCreateGroupAction({
			groupId: "team-a",
			displayName: "Team A",
			dbPath,
		});
		expect(group.group_id).toBe("team-a");
		expect(await coordinatorListGroupsAction({ dbPath })).toEqual([
			expect.objectContaining({ group_id: "team-a", display_name: "Team A" }),
		]);
	});

	it("enrolls and lists devices for an existing group", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const enrollment = await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			displayName: "Laptop",
			dbPath,
		});
		expect(enrollment.device_id).toBe("device-1");
		expect(await coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([
			expect.objectContaining({ device_id: "device-1", display_name: "Laptop" }),
		]);
	});

	it("renames, disables, and removes devices", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		expect(
			await coordinatorRenameDeviceAction({
				groupId: "team-a",
				deviceId: "device-1",
				displayName: "Work Laptop",
				dbPath,
			}),
		).toEqual(expect.objectContaining({ display_name: "Work Laptop" }));
		expect(
			await coordinatorDisableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath }),
		).toBe(true);
		expect(await coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([]);
		expect(
			await coordinatorListDevicesAction({ groupId: "team-a", includeDisabled: true, dbPath }),
		).toEqual([expect.objectContaining({ device_id: "device-1", enabled: 0 })]);
		expect(
			await coordinatorRemoveDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath }),
		).toBe(true);
		expect(
			await coordinatorListDevicesAction({ groupId: "team-a", includeDisabled: true, dbPath }),
		).toEqual([]);
	});

	it("returns the renamed disabled device instead of null", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		await coordinatorDisableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath });
		await expect(
			coordinatorRenameDeviceAction({
				groupId: "team-a",
				deviceId: "device-1",
				displayName: "Disabled Laptop",
				dbPath,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				device_id: "device-1",
				display_name: "Disabled Laptop",
				enabled: 0,
			}),
		);
	});

	it("re-enables a disabled device", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		await coordinatorDisableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath });
		expect(await coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([]);
		expect(
			await coordinatorEnableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath }),
		).toBe(true);
		expect(await coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([
			expect.objectContaining({ device_id: "device-1", enabled: 1 }),
		]);
	});

	it("returns false when enabling a missing device", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		expect(
			await coordinatorEnableDeviceAction({ groupId: "team-a", deviceId: "missing", dbPath }),
		).toBe(false);
	});

	it("rejects enrollment into a missing group", async () => {
		await expect(
			coordinatorEnrollDeviceAction({
				groupId: "missing",
				deviceId: "device-1",
				fingerprint: "fp-1",
				publicKey: "pk-1",
				dbPath,
			}),
		).rejects.toThrow("Group not found: missing");
	});

	it("creates, updates, lists, grants, and revokes local Sharing domain memberships", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		const created = await coordinatorCreateScopeAction({
			groupId: "team-a",
			scopeId: "scope-acme",
			label: "Acme Work",
			kind: "team",
			coordinatorId: "coord-a",
			membershipEpoch: 2,
			dbPath,
		});
		expect(created).toEqual(
			expect.objectContaining({
				scope_id: "scope-acme",
				label: "Acme Work",
				group_id: "team-a",
				membership_epoch: 2,
			}),
		);
		expect(await coordinatorListScopesAction({ groupId: "team-a", dbPath })).toEqual([
			expect.objectContaining({ scope_id: "scope-acme" }),
		]);
		expect(
			await coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				dbPath,
			}),
		).toEqual([]);
		const updated = await coordinatorUpdateScopeAction({
			groupId: "team-a",
			scopeId: "scope-acme",
			label: "Acme Engineering",
			membershipEpoch: 3,
			dbPath,
		});
		expect(updated).toEqual(
			expect.objectContaining({ label: "Acme Engineering", membership_epoch: 3 }),
		);

		const grant = await coordinatorGrantScopeMembershipAction({
			groupId: "team-a",
			scopeId: "scope-acme",
			deviceId: "device-1",
			role: "admin",
			membershipEpoch: 3,
			actorId: "admin-alice",
			dbPath,
		});
		expect(grant).toEqual(
			expect.objectContaining({
				scope_id: "scope-acme",
				device_id: "device-1",
				role: "admin",
				status: "active",
			}),
		);
		expect(
			await coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				dbPath,
			}),
		).toEqual([expect.objectContaining({ device_id: "device-1", status: "active" })]);
		expect(
			await coordinatorRevokeScopeMembershipAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				deviceId: "device-1",
				actorId: "admin-bob",
				dbPath,
			}),
		).toBe(true);
		expect(
			await coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				dbPath,
			}),
		).toEqual([]);
		expect(
			await coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				includeRevoked: true,
				dbPath,
			}),
		).toEqual([expect.objectContaining({ device_id: "device-1", status: "revoked" })]);
		const auditStore = new BetterSqliteCoordinatorStore(dbPath);
		try {
			expect(await auditStore.listScopeMembershipAuditEvents({ scopeId: "scope-acme" })).toEqual([
				expect.objectContaining({
					action: "grant",
					device_id: "device-1",
					membership_epoch: 3,
					actor_type: "admin",
					actor_id: "admin-alice",
				}),
				expect.objectContaining({
					action: "revoke",
					device_id: "device-1",
					status: "revoked",
					previous_membership_epoch: 3,
					actor_type: "admin",
					actor_id: "admin-bob",
				}),
			]);
		} finally {
			await auditStore.close();
		}
	});

	it("rejects local Sharing domain actions for missing groups or scopes", async () => {
		await expect(
			coordinatorCreateScopeAction({
				groupId: "missing",
				scopeId: "scope-acme",
				label: "Acme Work",
				dbPath,
			}),
		).rejects.toThrow("Group not found: missing");
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		expect(
			await coordinatorUpdateScopeAction({
				groupId: "team-a",
				scopeId: "missing-scope",
				label: "Nope",
				dbPath,
			}),
		).toBeNull();
		await expect(
			coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "missing-scope",
				dbPath,
			}),
		).rejects.toThrow("Scope not found: missing-scope");
		await expect(
			coordinatorGrantScopeMembershipAction({
				groupId: "team-a",
				scopeId: "missing-scope",
				deviceId: "device-1",
				dbPath,
			}),
		).rejects.toThrow("Scope not found: missing-scope");
	});

	it("sends remote Sharing domain admin requests with the admin secret", async () => {
		const prevAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
		process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "secret";
		const scope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "team-a",
			manifest_issuer_device_id: null,
			membership_epoch: 2,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const membership = {
			scope_id: "scope-acme",
			device_id: "device-1",
			role: "member",
			status: "active",
			membership_epoch: 2,
			coordinator_id: "coord-a",
			group_id: "team-a",
			manifest_issuer_device_id: null,
			manifest_hash: null,
			signed_manifest_json: null,
			updated_at: "2026-03-28T00:00:00Z",
		};
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			expect(init?.headers).toMatchObject({ "X-Codemem-Coordinator-Admin": "secret" });
			if (path.endsWith("/scopes") && init?.method === "GET") {
				return new Response(JSON.stringify({ items: [scope] }), { status: 200 });
			}
			if (path.endsWith("/scopes") && init?.method === "POST") {
				return new Response(JSON.stringify({ ok: true, scope }), { status: 201 });
			}
			if (path.endsWith("/members") && init?.method === "POST") {
				return new Response(JSON.stringify({ ok: true, membership }), { status: 201 });
			}
			if (path.endsWith("/revoke") && init?.method === "POST") {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			expect(
				await coordinatorListScopesAction({
					groupId: "team-a",
					includeInactive: true,
					remoteUrl: "https://coord.example.test/",
				}),
			).toEqual([scope]);
			expect(
				await coordinatorCreateScopeAction({
					groupId: "team-a",
					scopeId: "scope-acme",
					label: "Acme Work",
					remoteUrl: "https://coord.example.test/",
				}),
			).toEqual(scope);
			expect(
				await coordinatorGrantScopeMembershipAction({
					groupId: "team-a",
					scopeId: "scope-acme",
					deviceId: "device-1",
					remoteUrl: "https://coord.example.test/",
				}),
			).toEqual(membership);
			expect(
				await coordinatorRevokeScopeMembershipAction({
					groupId: "team-a",
					scopeId: "scope-acme",
					deviceId: "device-1",
					remoteUrl: "https://coord.example.test/",
				}),
			).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(4);
		} finally {
			if (prevAdminSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevAdminSecret;
		}
	});

	it("maps remote missing Sharing domain membership revokes to false", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "membership_not_found" }), { status: 404 }),
			),
		);

		expect(
			await coordinatorRevokeScopeMembershipAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				deviceId: "device-1",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).toBe(false);
	});

	it("warns when local invite coordinator URL looks private-only", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://100.103.98.49:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a CGNAT/Tailscale-style coordinator IP address. This can be correct for Tailnet-only teams, but other teammates may not be able to join unless they share that network.",
		]);
	});

	it("does not warn for public-looking invite coordinator URLs", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([]);
	});

	it("imports invites using CODEMEM_DB and CODEMEM_KEYS_DIR when flags are omitted", async () => {
		const envDbPath = join(tmpDir, "env-mem.sqlite");
		const envKeysDir = join(tmpDir, "env-keys");
		process.env.CODEMEM_DB = envDbPath;
		process.env.CODEMEM_KEYS_DIR = envKeysDir;
		const capturedBodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "{}";
				capturedBodies.push(JSON.parse(body) as Record<string, unknown>);
				return new Response(JSON.stringify({ ok: true, status: "enrolled" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);

		const invite = encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: "invite-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
		});

		await coordinatorImportInviteAction({ inviteValue: invite });

		const publicKey = loadPublicKey(envKeysDir);
		expect(publicKey).toBeTruthy();
		const conn = connect(envDbPath);
		try {
			expect(
				conn.prepare("SELECT COUNT(1) AS total FROM sync_device").get() as { total?: number },
			).toMatchObject({ total: 1 });
		} finally {
			conn.close();
		}
		expect(capturedBodies).toEqual([
			expect.objectContaining({
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(String(publicKey)),
			}),
		]);
	});

	it("falls back to the local actor identity for CLI project invite imports", async () => {
		const actionDbPath = join(tmpDir, "project-invite.sqlite");
		const keysDir = join(tmpDir, "project-keys");
		const capturedBodies: Record<string, unknown>[] = [];
		const operationId = `share_${"a".repeat(40)}`;
		const inviterPublicKey = "ssh-ed25519 inviter-public-key";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "{}";
				capturedBodies.push(JSON.parse(body) as Record<string, unknown>);
				return new Response(
					JSON.stringify({
						ok: true,
						status: "accepted",
						operation_id: operationId,
						trust_state: "bootstrap_grant_created",
						bootstrap_grant_id: "grant-1",
						inviter_device: {
							device_id: "inviter-device",
							public_key: inviterPublicKey,
							fingerprint: fingerprintPublicKey(inviterPublicKey),
							display_name: "Adam's Mac",
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: "project-invite-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
			operation_id: operationId,
		});

		await coordinatorImportInviteAction({ inviteValue: invite, dbPath: actionDbPath, keysDir });

		const body = capturedBodies[0];
		expect(body?.recipient_actor_id).toBe(`local:${body?.device_id}`);
		expect(body?.recipient_display_name).toEqual(expect.any(String));
		expect(body?.device_display_name).toEqual(expect.any(String));
		const conn = connect(actionDbPath);
		try {
			expect(
				conn
					.prepare(`SELECT name, pinned_fingerprint, public_key, pending_bootstrap_grant_id,
						discovered_via_group_id FROM sync_peers WHERE peer_device_id = 'inviter-device'`)
					.get(),
			).toEqual({
				name: "Adam's Mac",
				pinned_fingerprint: fingerprintPublicKey(inviterPublicKey),
				public_key: inviterPublicKey,
				pending_bootstrap_grant_id: "grant-1",
				discovered_via_group_id: "team-a",
			});
			expect(
				conn
					.prepare("SELECT display_name, is_local, status FROM actors WHERE actor_id = ?")
					.get(body?.recipient_actor_id),
			).toMatchObject({ is_local: 1, status: "active" });
		} finally {
			conn.close();
		}
	});

	it("warns when local invite coordinator URL uses private IPv6 space", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://[fd7a:115c:a1e0::1234]:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a ULA/Tailnet-style coordinator IPv6 address. This can be correct for private-network teams, but other teammates may not be able to join unless they share that network.",
		]);
	});

	it("warns when local invite coordinator URL uses link-local IPv6 space", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://[fe80::1]:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a link-local coordinator IPv6 address. It usually only works on the same local network segment.",
		]);
	});
});
