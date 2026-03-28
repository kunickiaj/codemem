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
});
