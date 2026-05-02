import {
	buildCanonicalRequest,
	type CoordinatorPeerRecord,
	fingerprintPublicKey,
	type InvitePayload,
	SIGNATURE_VERSION,
} from "@codemem/core";
import { env, exports } from "cloudflare:workers";
import {
	type KeyObject,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
	sign,
} from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

interface TestIdentity {
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	privateKey: KeyObject;
}

function derToSshEd25519(spkiDer: Buffer): string | null {
	if (spkiDer.length < 32) return null;
	const rawKey = spkiDer.subarray(spkiDer.length - 32);
	const keyType = Buffer.from("ssh-ed25519");
	const buf = Buffer.alloc(4 + keyType.length + 4 + rawKey.length);
	let offset = 0;
	buf.writeUInt32BE(keyType.length, offset);
	offset += 4;
	keyType.copy(buf, offset);
	offset += keyType.length;
	buf.writeUInt32BE(rawKey.length, offset);
	offset += 4;
	rawKey.copy(buf, offset);
	return `ssh-ed25519 ${buf.toString("base64")}`;
}

function createIdentity(): TestIdentity {
	const deviceId = randomUUID();
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const pubDer = publicKey.export({ type: "spki", format: "der" });
	const sshPublic = derToSshEd25519(Buffer.from(pubDer));
	if (!sshPublic) throw new Error("Failed to derive SSH public key.");
	return {
		deviceId,
		publicKey: sshPublic,
		fingerprint: fingerprintPublicKey(sshPublic),
		privateKey,
	};
}

function signHeaders(identity: TestIdentity, method: string, url: string, body: string): Record<string, string> {
	const parsed = new URL(url);
	const pathWithQuery = `${parsed.pathname}${parsed.search}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = randomBytes(16).toString("hex");
	const bodyBytes = Buffer.from(body);
	const canonical = buildCanonicalRequest(method, pathWithQuery, timestamp, nonce, bodyBytes);
	const signature = sign(null, canonical, identity.privateKey).toString("base64");
	return {
		"X-Opencode-Device": identity.deviceId,
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": nonce,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature}`,
	};
}

	describe("workers vitest + local D1 validation", () => {
	afterEach(async () => {
		await env.COORDINATOR_DB.prepare("DELETE FROM coordinator_scope_membership_audit_log").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM coordinator_scope_memberships").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM coordinator_scopes").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM coordinator_join_requests").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM coordinator_invites").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM request_nonces").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM presence_records").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM groups").run();
	});

	it("exercises invite, join approval, signed presence, peer lookup, and nonce replay", async () => {
		const inviter = createIdentity();
		const joiner = createIdentity();
		const peer = createIdentity();

		await env.COORDINATOR_DB.prepare(
			"INSERT INTO groups (group_id, display_name, created_at) VALUES (?, ?, ?)",
		)
			.bind("g1", "Team Alpha", "2026-03-28T00:00:00Z")
			.run();

		const enrollPeer = await exports.default.fetch("https://example.com/v1/admin/devices", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({
				group_id: "g1",
				device_id: peer.deviceId,
				fingerprint: peer.fingerprint,
				public_key: peer.publicKey,
				display_name: "Peer Device",
			}),
		});
		expect(enrollPeer.status).toBe(200);

		const inviteRes = await exports.default.fetch("https://example.com/v1/admin/invites", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({
				group_id: "g1",
				policy: "approval_required",
				expires_at: "2099-01-01T00:00:00Z",
				coordinator_url: "https://example.com",
			}),
		});
		expect(inviteRes.status).toBe(200);
		const inviteJson = (await inviteRes.json()) as { payload: InvitePayload };

		const joinRes = await exports.default.fetch("https://example.com/v1/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: inviteJson.payload.token,
				device_id: joiner.deviceId,
				public_key: joiner.publicKey,
				fingerprint: joiner.fingerprint,
				display_name: "Joiner Device",
			}),
		});
		expect(joinRes.status).toBe(200);
		const joinJson = (await joinRes.json()) as { request_id: string; status: string };
		expect(joinJson.status).toBe("pending");

		const approveRes = await exports.default.fetch("https://example.com/v1/admin/join-requests/approve", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ request_id: joinJson.request_id, reviewed_by: inviter.deviceId }),
		});
		expect(approveRes.status).toBe(200);

		const peerPresenceBody = JSON.stringify({
			group_id: "g1",
			fingerprint: peer.fingerprint,
			addresses: ["http://10.0.0.5:7337"],
			ttl_s: 180,
		});
		const peerPresenceRes = await exports.default.fetch("https://example.com/v1/presence", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signHeaders(peer, "POST", "https://example.com/v1/presence", peerPresenceBody),
			},
			body: peerPresenceBody,
		});
		expect(peerPresenceRes.status).toBe(200);

		const joinerPresenceBody = JSON.stringify({
			group_id: "g1",
			fingerprint: joiner.fingerprint,
			addresses: ["http://10.0.0.6:7337"],
			ttl_s: 180,
		});
		const joinerPresenceInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signHeaders(joiner, "POST", "https://example.com/v1/presence", joinerPresenceBody),
			},
			body: joinerPresenceBody,
		};
		const joinerPresenceRes = await exports.default.fetch("https://example.com/v1/presence", joinerPresenceInit);
		expect(joinerPresenceRes.status).toBe(200);

		const peersRes = await exports.default.fetch("https://example.com/v1/peers?group_id=g1", {
			method: "GET",
			headers: signHeaders(joiner, "GET", "https://example.com/v1/peers?group_id=g1", ""),
		});
		expect(peersRes.status).toBe(200);
		const peersJson = (await peersRes.json()) as { items: CoordinatorPeerRecord[] };
		expect(peersJson.items).toEqual([
			expect.objectContaining({
				device_id: peer.deviceId,
				fingerprint: peer.fingerprint,
				stale: false,
				addresses: ["http://10.0.0.5:7337"],
			}),
		]);

		const replayRes = await exports.default.fetch("https://example.com/v1/presence", joinerPresenceInit);
		expect(replayRes.status).toBe(401);
		expect(await replayRes.json()).toEqual({ error: "nonce_replay" });
	});

	it("manages Sharing domain metadata and explicit memberships through worker admin routes", async () => {
		await env.COORDINATOR_DB.prepare(
			"INSERT INTO groups (group_id, display_name, created_at) VALUES (?, ?, ?)",
		)
			.bind("g1", "Team Alpha", "2026-03-28T00:00:00Z")
			.run();

		const device = createIdentity();
		const observer = createIdentity();
		const adminHeaders = {
			"content-type": "application/json",
			"X-Codemem-Coordinator-Admin": "test-secret",
			"X-Codemem-Coordinator-Admin-Actor": "admin-worker",
		};

		const enrollRes = await exports.default.fetch("https://example.com/v1/admin/devices", {
			method: "POST",
			headers: adminHeaders,
			body: JSON.stringify({
				group_id: "g1",
				device_id: device.deviceId,
				fingerprint: device.fingerprint,
				public_key: device.publicKey,
				display_name: "Laptop",
			}),
		});
		expect(enrollRes.status).toBe(200);
		const enrollObserverRes = await exports.default.fetch("https://example.com/v1/admin/devices", {
			method: "POST",
			headers: adminHeaders,
			body: JSON.stringify({
				group_id: "g1",
				device_id: observer.deviceId,
				fingerprint: observer.fingerprint,
				public_key: observer.publicKey,
				display_name: "Observer Device",
			}),
		});
		expect(enrollObserverRes.status).toBe(200);

		const createScopeRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes",
			{
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({
					scope_id: "scope-a",
					label: "Scope A",
					membership_epoch: 1,
					memory_payload: { must_not_matter: true },
				}),
			},
		);
		expect(createScopeRes.status).toBe(201);
		expect(await createScopeRes.json()).toMatchObject({
			ok: true,
			scope: { scope_id: "scope-a", group_id: "g1", label: "Scope A" },
		});

		const listScopesRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes",
			{ headers: { "X-Codemem-Coordinator-Admin": "test-secret" } },
		);
		expect(listScopesRes.status).toBe(200);
		const scopesJson = (await listScopesRes.json()) as { items: Array<Record<string, unknown>> };
		expect(scopesJson.items).toEqual([
			expect.objectContaining({ scope_id: "scope-a", label: "Scope A" }),
		]);

		const updateScopeRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/scope-a",
			{
				method: "PATCH",
				headers: adminHeaders,
				body: JSON.stringify({ label: "Renamed Scope", membership_epoch: 2 }),
			},
		);
		expect(updateScopeRes.status).toBe(200);
		expect(await updateScopeRes.json()).toMatchObject({
			scope: { scope_id: "scope-a", label: "Renamed Scope", membership_epoch: 2 },
		});

		const initialMembersRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/scope-a/members",
			{ headers: { "X-Codemem-Coordinator-Admin": "test-secret" } },
		);
		expect(initialMembersRes.status).toBe(200);
		expect(await initialMembersRes.json()).toMatchObject({ items: [] });

		const grantRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/scope-a/members",
			{
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({
					device_id: device.deviceId,
					role: "reader",
					membership_epoch: 3,
					memory_items: [{ id: 1 }],
				}),
			},
		);
		expect(grantRes.status).toBe(201);
		expect(await grantRes.json()).toMatchObject({
			membership: {
				scope_id: "scope-a",
				group_id: "g1",
				device_id: device.deviceId,
				status: "active",
			},
		});

		const activeMembersRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/scope-a/members",
			{ headers: { "X-Codemem-Coordinator-Admin": "test-secret" } },
		);
		expect(activeMembersRes.status).toBe(200);
		const activeMembersJson = (await activeMembersRes.json()) as {
			items: Array<Record<string, unknown>>;
		};
		expect(activeMembersJson.items).toEqual([
			expect.objectContaining({ device_id: device.deviceId, status: "active" }),
		]);

		const revokeRes = await exports.default.fetch(
			`https://example.com/v1/admin/groups/g1/scopes/scope-a/members/${encodeURIComponent(device.deviceId)}/revoke`,
			{
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({ membership_epoch: 4, memory_payload: { id: 1 } }),
			},
		);
		expect(revokeRes.status).toBe(200);
		expect(await revokeRes.json()).toMatchObject({
			ok: true,
			scope_id: "scope-a",
			device_id: device.deviceId,
		});

		const revokedDevicePresenceBody = JSON.stringify({
			group_id: "g1",
			fingerprint: device.fingerprint,
			addresses: ["http://10.0.0.7:7337"],
			ttl_s: 180,
		});
		const revokedDevicePresenceRes = await exports.default.fetch("https://example.com/v1/presence", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signHeaders(
					device,
					"POST",
					"https://example.com/v1/presence",
					revokedDevicePresenceBody,
				),
			},
			body: revokedDevicePresenceBody,
		});
		expect(revokedDevicePresenceRes.status).toBe(200);

		const peersAfterRevokeRes = await exports.default.fetch(
			"https://example.com/v1/peers?group_id=g1",
			{
				method: "GET",
				headers: signHeaders(observer, "GET", "https://example.com/v1/peers?group_id=g1", ""),
			},
		);
		expect(peersAfterRevokeRes.status).toBe(200);
		const peersAfterRevokeJson = (await peersAfterRevokeRes.json()) as {
			items: CoordinatorPeerRecord[];
		};
		expect(peersAfterRevokeJson.items).toEqual([
			expect.objectContaining({
				device_id: device.deviceId,
				fingerprint: device.fingerprint,
				stale: false,
				addresses: ["http://10.0.0.7:7337"],
			}),
		]);

		const activeMembersAfterRevokeRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/scope-a/members",
			{ headers: { "X-Codemem-Coordinator-Admin": "test-secret" } },
		);
		expect(activeMembersAfterRevokeRes.status).toBe(200);
		expect(await activeMembersAfterRevokeRes.json()).toMatchObject({ items: [] });

		const revokedMembersRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/scope-a/members?include_revoked=1",
			{ headers: { "X-Codemem-Coordinator-Admin": "test-secret" } },
		);
		expect(revokedMembersRes.status).toBe(200);
		const revokedMembersJson = (await revokedMembersRes.json()) as {
			items: Array<Record<string, unknown>>;
		};
		expect(revokedMembersJson.items).toEqual([
			expect.objectContaining({ device_id: device.deviceId, status: "revoked" }),
		]);

		const auditRows = await env.COORDINATOR_DB.prepare(
			`SELECT action, scope_id, device_id, status, membership_epoch,
				previous_status, previous_membership_epoch, actor_type, actor_id
			 FROM coordinator_scope_membership_audit_log
			 WHERE scope_id = ?
			 ORDER BY event_id ASC`,
		)
			.bind("scope-a")
			.all<Record<string, unknown>>();
		expect(auditRows.results).toEqual([
			expect.objectContaining({
				action: "grant",
				scope_id: "scope-a",
				device_id: device.deviceId,
				status: "active",
				membership_epoch: 3,
				previous_status: null,
				previous_membership_epoch: null,
				actor_type: "admin",
				actor_id: "admin-worker",
			}),
			expect.objectContaining({
				action: "revoke",
				scope_id: "scope-a",
				device_id: device.deviceId,
				status: "revoked",
				membership_epoch: 4,
				previous_status: "active",
				previous_membership_epoch: 3,
				actor_type: "admin",
				actor_id: "admin-worker",
			}),
		]);

		const dataPlaneRes = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/scope-a/members/device-1/memories",
			{ headers: { "X-Codemem-Coordinator-Admin": "test-secret" } },
		);
		expect(dataPlaneRes.status).toBe(404);
	});
});
