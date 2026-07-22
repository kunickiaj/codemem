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
		await env.COORDINATOR_DB.prepare("DELETE FROM coordinator_bootstrap_grants").run();
		await env.COORDINATOR_DB.prepare("DELETE FROM coordinator_scope_membership_effect_receipts").run();
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

	it("atomically accepts project invites while preserving legacy join behavior after migration 0008", async () => {
		const legacyJoiner = createIdentity();
		const projectJoiner = createIdentity();
		const conflictingJoiner = createIdentity();
		const adminHeaders = {
			"content-type": "application/json",
			"X-Codemem-Coordinator-Admin": "test-secret",
		};
		await env.COORDINATOR_DB.prepare(
			"INSERT INTO groups (group_id, display_name, created_at) VALUES (?, ?, ?)",
		)
			.bind("g1", "Team Alpha", "2026-03-28T00:00:00Z")
			.run();

		const legacyInviteResponse = await exports.default.fetch(
			"https://example.com/v1/admin/invites",
			{
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({
					group_id: "g1",
					policy: "auto_admit",
					expires_at: "2099-01-01T00:00:00Z",
					coordinator_url: "https://example.com",
				}),
			},
		);
		const legacyInvite = (await legacyInviteResponse.json()) as { payload: InvitePayload };
		const legacyJoinResponse = await exports.default.fetch("https://example.com/v1/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: legacyInvite.payload.token,
				device_id: legacyJoiner.deviceId,
				public_key: legacyJoiner.publicKey,
				fingerprint: legacyJoiner.fingerprint,
			}),
		});
		expect(legacyJoinResponse.status).toBe(200);
		expect(await legacyJoinResponse.json()).toMatchObject({ status: "enrolled" });

		const operationId = `share_${"a".repeat(40)}`;
		const reviewedProjectSetDigest = "b".repeat(64);
		const projectInviteBody = {
			group_id: "g1",
			policy: "auto_admit",
			expires_at: "2099-01-01T00:00:00Z",
			coordinator_url: "https://example.com",
			operation_id: operationId,
			reviewed_project_set_digest: reviewedProjectSetDigest,
			inviter_actor_id: "actor-adam",
			inviter_display_name: "Adam",
			inviter_device_id: "inviter-device",
			pending_person_id: "pending-brian",
			project_summaries: [{ display_name: "codemem", existing_memory_count: 3 }],
			project_intent: [
				{
					canonical_identity: "git:https://example.test/codemem",
					display_name: "codemem",
					existing_memory_count: 3,
				},
			],
		};
		const projectInviteResponse = await exports.default.fetch(
			"https://example.com/v1/admin/invites",
			{
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify(projectInviteBody),
			},
		);
		expect(projectInviteResponse.status).toBe(200);
		const projectInvite = (await projectInviteResponse.json()) as { payload: InvitePayload };
		const retryResponse = await exports.default.fetch("https://example.com/v1/admin/invites", {
			method: "POST",
			headers: adminHeaders,
			body: JSON.stringify(projectInviteBody),
		});
		expect(retryResponse.status).toBe(200);
		expect((await retryResponse.json()) as { payload: InvitePayload }).toMatchObject({
			payload: { token: projectInvite.payload.token },
		});
		const conflictResponse = await exports.default.fetch("https://example.com/v1/admin/invites", {
			method: "POST",
			headers: adminHeaders,
			body: JSON.stringify({
				...projectInviteBody,
				reviewed_project_set_digest: "c".repeat(64),
			}),
		});
		expect(conflictResponse.status).toBe(409);
		expect(await conflictResponse.json()).toEqual({ error: "invite_operation_intent_conflict" });
		expect(
			await env.COORDINATOR_DB.prepare(
				`SELECT operation_id, reviewed_project_set_digest
				 FROM coordinator_invites WHERE operation_id = ?`,
			)
				.bind(operationId)
				.first(),
		).toEqual({ operation_id: operationId, reviewed_project_set_digest: reviewedProjectSetDigest });
		await expect(
			env.COORDINATOR_DB.prepare(
				`INSERT INTO coordinator_invites(
					invite_id, group_id, token, policy, expires_at, created_at, operation_id,
					reviewed_project_set_digest
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					"duplicate-operation",
					"g1",
					"duplicate-token",
					"auto_admit",
					"2099-01-01T00:00:00Z",
					"2026-03-28T00:00:00Z",
					operationId,
					reviewedProjectSetDigest,
				)
				.run(),
		).rejects.toThrow();

		const tamperedJoinResponse = await exports.default.fetch("https://example.com/v1/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: projectInvite.payload.token,
				operation_id: operationId,
				device_id: projectJoiner.deviceId,
				public_key: projectJoiner.publicKey,
				fingerprint: projectJoiner.fingerprint,
				recipient_actor_id: "actor-brian",
				recipient_display_name: "Brian",
				device_display_name: "Brian's Test Mac",
				projects: [{ canonical_identity: "attacker-controlled" }],
			}),
		});
		expect(tamperedJoinResponse.status).toBe(400);
		expect(await tamperedJoinResponse.json()).toEqual({
			error: "unexpected_project_invite_fields",
		});

		const fingerprintMismatchResponse = await exports.default.fetch(
			"https://example.com/v1/join",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					token: projectInvite.payload.token,
					operation_id: operationId,
					device_id: projectJoiner.deviceId,
					public_key: projectJoiner.publicKey,
					fingerprint: conflictingJoiner.fingerprint,
					recipient_actor_id: "actor-brian",
					recipient_display_name: "Brian",
					device_display_name: "Brian's Test Mac",
				}),
			},
		);
		expect(fingerprintMismatchResponse.status).toBe(400);
		expect(await fingerprintMismatchResponse.json()).toEqual({ error: "fingerprint_mismatch" });

		const projectJoinResponse = await exports.default.fetch("https://example.com/v1/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: projectInvite.payload.token,
				operation_id: operationId,
				device_id: projectJoiner.deviceId,
				public_key: projectJoiner.publicKey,
				fingerprint: projectJoiner.fingerprint,
				recipient_actor_id: "actor-brian",
				recipient_display_name: "Brian",
				device_display_name: "Brian's Test Mac",
			}),
		});
		const projectJoinBody = (await projectJoinResponse.json()) as Record<string, unknown>;
		expect(projectJoinResponse.status, JSON.stringify(projectJoinBody)).toBe(200);
		expect(projectJoinBody).toMatchObject({
			status: "accepted",
			operation_id: operationId,
			trust_state: "pending_inviter_device",
		});
		const retry = await exports.default.fetch("https://example.com/v1/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: projectInvite.payload.token,
				operation_id: operationId,
				device_id: projectJoiner.deviceId,
				public_key: projectJoiner.publicKey,
				fingerprint: projectJoiner.fingerprint,
				recipient_actor_id: "actor-brian",
				recipient_display_name: "Brian",
				device_display_name: "Brian's Test Mac",
			}),
		});
		expect(await retry.json()).toMatchObject({ status: "existing" });
		const conflictingJoinResponse = await exports.default.fetch(
			"https://example.com/v1/join",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					token: projectInvite.payload.token,
					operation_id: operationId,
					device_id: conflictingJoiner.deviceId,
					public_key: conflictingJoiner.publicKey,
					fingerprint: conflictingJoiner.fingerprint,
					recipient_actor_id: "actor-brian",
					recipient_display_name: "Brian",
					device_display_name: "Brian's Other Mac",
				}),
			},
		);
		expect(conflictingJoinResponse.status).toBe(409);
		expect(await conflictingJoinResponse.json()).toEqual({ error: "invite_already_bound" });
		expect(
			await env.COORDINATOR_DB.prepare(
				`SELECT token, token_digest, bound_device_id, recipient_actor_id, project_intent_json
				 FROM coordinator_invites WHERE operation_id = ?`,
			)
				.bind(operationId)
				.first(),
		).toEqual({
			token: expect.stringMatching(/^consumed:/),
			token_digest: expect.any(String),
			bound_device_id: projectJoiner.deviceId,
			recipient_actor_id: "actor-brian",
			project_intent_json: JSON.stringify(projectInviteBody.project_intent),
		});
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
					effect_id: "worker:scope-a:grant:device",
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
				body: JSON.stringify({
					effect_id: "worker:scope-a:revoke:device",
					membership_epoch: 4,
					memory_payload: { id: 1 },
				}),
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
			`SELECT effect_id, action, scope_id, device_id, status, membership_epoch,
				previous_status, previous_membership_epoch, actor_type, actor_id
			 FROM coordinator_scope_membership_audit_log
			 WHERE scope_id = ?
			 ORDER BY event_id ASC`,
		)
			.bind("scope-a")
			.all<Record<string, unknown>>();
		expect(auditRows.results).toEqual([
			expect.objectContaining({
				effect_id: "worker:scope-a:grant:device",
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
				effect_id: "worker:scope-a:revoke:device",
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

	it("reuses a managed project boundary and grants only the explicit bounded device set", async () => {
		await env.COORDINATOR_DB.prepare(
			"INSERT INTO groups (group_id, display_name, created_at) VALUES ('g1', 'Team', ?)",
		)
			.bind("2026-07-20T00:00:00Z")
			.run();
		const devices = [createIdentity(), createIdentity(), createIdentity(), createIdentity()];
		for (const [index, device] of devices.entries()) {
			const enrolled = await exports.default.fetch("https://example.com/v1/admin/devices", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Codemem-Coordinator-Admin": "test-secret",
				},
				body: JSON.stringify({
					group_id: "g1",
					device_id: device.deviceId,
					fingerprint: device.fingerprint,
					public_key: device.publicKey,
					display_name: `Device ${index + 1}`,
				}),
			});
			expect(enrolled.status).toBe(200);
		}
		const scopeBody = JSON.stringify({
			scope_id: "managed-project:deterministic",
			label: "api",
			kind: "managed_project",
			authority_type: "coordinator",
			membership_epoch: 1,
		});
		const create = () =>
			exports.default.fetch("https://example.com/v1/admin/groups/g1/scopes", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Codemem-Coordinator-Admin": "test-secret",
				},
				body: scopeBody,
			});
		expect((await create()).status).toBe(201);
		// Duplicate create may report conflict; the durable boundary remains unique
		// and is safely recoverable by re-reading it.
		expect([200, 400, 409]).toContain((await create()).status);
		const scopes = await exports.default.fetch("https://example.com/v1/admin/groups/g1/scopes", {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});
		const scopesPayload = (await scopes.json()) as { items: Array<{ scope_id: string }> };
		expect(
			scopesPayload.items.filter((scope) => scope.scope_id === "managed-project:deterministic"),
		).toHaveLength(1);
		const reviewed = devices.slice(0, 3);
		for (const device of reviewed) {
			const grant = () =>
				exports.default.fetch(
					"https://example.com/v1/admin/groups/g1/scopes/managed-project%3Adeterministic/members",
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"X-Codemem-Coordinator-Admin": "test-secret",
						},
						body: JSON.stringify({
							effect_id: `worker:managed-project:grant:${device.deviceId}:1`,
							device_id: device.deviceId,
							role: "member",
							membership_epoch: 1,
						}),
					},
				);
			expect((await grant()).status).toBe(201);
			expect((await grant()).status).toBe(201);
		}
		const conflictingEffect = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/managed-project%3Adeterministic/members",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Codemem-Coordinator-Admin": "test-secret",
				},
				body: JSON.stringify({
					effect_id: `worker:managed-project:grant:${reviewed[0]?.deviceId}:1`,
					device_id: reviewed[0]?.deviceId,
					role: "admin",
					membership_epoch: 1,
				}),
			},
		);
		expect(conflictingEffect.status).toBe(409);
		expect(await conflictingEffect.json()).toEqual({ error: "scope_membership_effect_conflict" });
		expect(
			await env.COORDINATOR_DB.prepare(
				"SELECT COUNT(*) AS count FROM coordinator_scope_membership_effect_receipts WHERE scope_id = ?",
			)
				.bind("managed-project:deterministic")
				.first<{ count: number }>(),
		).toEqual({ count: reviewed.length });
		expect(
			await env.COORDINATOR_DB.prepare(
				"SELECT COUNT(*) AS count FROM coordinator_scope_membership_audit_log WHERE scope_id = ?",
			)
				.bind("managed-project:deterministic")
				.first<{ count: number }>(),
		).toEqual({ count: reviewed.length });
		const listed = await exports.default.fetch(
			"https://example.com/v1/admin/groups/g1/scopes/managed-project%3Adeterministic/members",
			{ headers: { "X-Codemem-Coordinator-Admin": "test-secret" } },
		);
		const payload = (await listed.json()) as { items: Array<{ device_id: string }> };
		expect(payload.items.map((item) => item.device_id).sort()).toEqual(
			reviewed.map((device) => device.deviceId).sort(),
		);
		expect(payload.items.some((item) => item.device_id === devices[3]?.deviceId)).toBe(false);
	});

	it("persists explicit Team and add-device invitation bindings without mutating coordinator memberships", async () => {
		const device = createIdentity();
		const otherDevice = createIdentity();
		const adminHeaders = {
			"content-type": "application/json",
			"X-Codemem-Coordinator-Admin": "test-secret",
		};
		await env.COORDINATOR_DB.prepare(
			"INSERT INTO groups (group_id, display_name, created_at) VALUES ('g1', 'Coordinator Team', ?)",
		)
			.bind("2026-07-21T00:00:00Z")
			.run();
		const createInvite = async (body: Record<string, unknown>) => {
			const response = await exports.default.fetch("https://example.com/v1/admin/invites", {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({
					group_id: "g1",
					policy: "auto_admit",
					expires_at: "2099-01-01T00:00:00Z",
					coordinator_url: "https://example.com",
					...body,
				}),
			});
			expect(response.status).toBe(200);
			return (await response.json()) as { payload: InvitePayload };
		};

		const team = await createInvite({
			invite_kind: "team_member",
			policy_team_id: "policy-team-1",
			reviewed_preview_digest: "a".repeat(64),
		});
		expect(team.payload).toMatchObject({
			kind: "team_member",
			policy_team_id: "policy-team-1",
			reviewed_preview_digest: "a".repeat(64),
		});
		const inspect = await exports.default.fetch("https://example.com/v1/invites/inspect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: team.payload.token }),
		});
		expect(await inspect.json()).toMatchObject({
			kind: "team_member",
			policy_team_id: "policy-team-1",
			bound: false,
		});
		const acceptBody = {
			token: team.payload.token,
			invite_kind: "team_member",
			identity_id: "identity-brian",
			device_id: device.deviceId,
			public_key: device.publicKey,
			fingerprint: device.fingerprint,
		};
		const accept = () =>
			exports.default.fetch("https://example.com/v1/join", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(acceptBody),
			});
		expect(await (await accept()).json()).toMatchObject({ status: "accepted" });
		expect(await (await accept()).json()).toMatchObject({ status: "existing" });
		const changedDevice = await exports.default.fetch("https://example.com/v1/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...acceptBody,
				device_id: otherDevice.deviceId,
				public_key: otherDevice.publicKey,
				fingerprint: otherDevice.fingerprint,
			}),
		});
		expect(changedDevice.status).toBe(409);
		expect(await changedDevice.json()).toEqual({ error: "invite_already_bound" });

		const addDevice = await createInvite({
			invite_kind: "add_device",
			target_identity_id: "identity-brian",
			reviewed_preview_digest: "b".repeat(64),
		});
		const wrongIdentity = await exports.default.fetch("https://example.com/v1/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: addDevice.payload.token,
				invite_kind: "add_device",
				identity_id: "identity-other",
				device_id: otherDevice.deviceId,
				public_key: otherDevice.publicKey,
				fingerprint: otherDevice.fingerprint,
			}),
		});
		expect(wrongIdentity.status).toBe(409);
		expect(await wrongIdentity.json()).toEqual({ error: "invite_identity_conflict" });

		expect(
			await env.COORDINATOR_DB.prepare("SELECT COUNT(*) AS count FROM enrolled_devices")
				.first<{ count: number }>(),
		).toEqual({ count: 0 });
		expect(
			await env.COORDINATOR_DB.prepare("SELECT COUNT(*) AS count FROM coordinator_scope_memberships")
				.first<{ count: number }>(),
		).toEqual({ count: 0 });

		await env.COORDINATOR_DB.prepare(
			"UPDATE coordinator_invites SET revoked_at = ? WHERE token_digest IS NOT NULL AND invite_kind = 'team_member'",
		)
			.bind("2026-07-21T01:00:00Z")
			.run();
		expect((await accept()).status).toBe(400);
		await env.COORDINATOR_DB.prepare("UPDATE groups SET archived_at = ? WHERE group_id = 'g1'")
			.bind("2026-07-21T01:00:00Z")
			.run();
		const archived = await exports.default.fetch("https://example.com/v1/invites/inspect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: addDevice.payload.token }),
		});
		expect(archived.status).toBe(409);
		expect(await archived.json()).toEqual({ error: "group_archived" });
	});
});
