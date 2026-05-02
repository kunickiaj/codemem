import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
	coordinatorCreateScopeAction,
	coordinatorDisableDeviceAction,
	coordinatorEnableDeviceAction,
	coordinatorEnrollDeviceAction,
	coordinatorGrantScopeMembershipAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorListScopeMembershipsAction,
	coordinatorListScopesAction,
	coordinatorRemoveDeviceAction,
	coordinatorRenameDeviceAction,
	coordinatorRevokeScopeMembershipAction,
	coordinatorUpdateScopeAction,
} from "./coordinator-actions.js";

describe("coordinator local admin actions", () => {
	let tmpDir: string;
	let dbPath: string;
	let prevConfigPath: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "coord-actions-test-"));
		dbPath = join(tmpDir, "coordinator.sqlite");
		prevConfigPath = process.env.CODEMEM_CONFIG;
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (prevConfigPath == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevConfigPath;
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
