import type { Context } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorEnrollment, CoordinatorStore } from "./coordinator-store-contract.js";

export const PEER_REVOCATION_CHECK_PATH = "/v1/peers/revocations";
/** Each peer costs one revocation read, so this keeps a request within D1's per-request query limit. */
export const PEER_REVOCATION_CHECK_MAX_PEERS = 25;
const MAX_BODY_BYTES = 64 * 1024;

export interface PeerRevocationCheckPeer {
	device_id: string;
	public_key: string;
}

interface SignedRequest {
	method: string;
	url: string;
	groupId: string;
	body: Uint8Array;
	deviceId: string | null;
	signature: string | null;
	timestamp: string | null;
	nonce: string | null;
}

export interface PeerRevocationCheckDeps {
	storeFactory: () => CoordinatorStore;
	authorizeRequest: (
		store: CoordinatorStore,
		request: SignedRequest,
	) => Promise<{ ok: boolean; error: string; enrollment: CoordinatorEnrollment | null }>;
	authErrorStatus: (error: string) => 401 | 403 | 409;
	readRequestBytes: (c: Context, maxBytes: number) => Promise<Uint8Array | null>;
	parseJsonObject: (raw: Uint8Array) => Record<string, unknown> | null;
	rateLimitedResponse: (
		c: Context,
		key: string,
		options: { authenticated: boolean },
	) => Response | null;
}

interface PeerRevocationApp {
	post(path: string, handler: (c: Context) => Promise<Response>): unknown;
}

/** Exact device ID and key pairs, or null when any entry is malformed or the list is too long. */
export function parsePeerRevocationCheckPeers(value: unknown): PeerRevocationCheckPeer[] | null {
	if (!Array.isArray(value) || value.length > PEER_REVOCATION_CHECK_MAX_PEERS) return null;
	const peers: PeerRevocationCheckPeer[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const { device_id: deviceId, public_key: publicKey } = entry as Record<string, unknown>;
		// The same identifier rule as the revocation store, so a valid request can't fail the read.
		if (!isAuthControllerId(deviceId) || typeof publicKey !== "string" || publicKey.length === 0)
			return null;
		if (publicKey.length > 4096 || publicKey.includes("\0")) return null;
		peers.push({ device_id: deviceId, public_key: publicKey });
	}
	return peers;
}

async function revokedPeerIds(
	store: CoordinatorStore,
	peers: PeerRevocationCheckPeer[],
): Promise<string[]> {
	const revoked = new Set<string>();
	for (const peer of peers) {
		// Either subject revokes the pair: the device ID with any key, or the key under any ID.
		const records = await store.listDeviceRevocations({
			deviceId: peer.device_id,
			publicKey: peer.public_key,
		});
		if (records.length > 0) revoked.add(peer.device_id);
	}
	return [...revoked].toSorted();
}

/**
 * Lets an enrolled device ask which of the peers it pinned are revoked
 * coordinator-wide. The answer is a yes or no for each device ID or key the
 * caller names, without revocation evidence, actor, or time.
 */
export function registerCoordinatorPeerRevocationCheckRoute(
	app: PeerRevocationApp,
	deps: PeerRevocationCheckDeps,
): void {
	app.post(PEER_REVOCATION_CHECK_PATH, async (c) => {
		const groupId = (c.req.query("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);
		const raw = await deps.readRequestBytes(c, MAX_BODY_BYTES);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const store = deps.storeFactory();
		try {
			const denied = await authorizeCheck(c, deps, store, { groupId, raw });
			if (denied) return denied;
			return await checkResponse(c, store, deps.parseJsonObject(raw)?.peers);
		} finally {
			await store.close();
		}
	});
}

/** A denial or rate-limit response, or null once the signed caller may run the check. */
async function authorizeCheck(
	c: Context,
	deps: PeerRevocationCheckDeps,
	store: CoordinatorStore,
	request: { groupId: string; raw: Uint8Array },
): Promise<Response | null> {
	const auth = await deps.authorizeRequest(store, {
		method: c.req.method,
		url: c.req.url,
		groupId: request.groupId,
		body: request.raw,
		deviceId: c.req.header("X-Opencode-Device") ?? null,
		signature: c.req.header("X-Opencode-Signature") ?? null,
		timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
		nonce: c.req.header("X-Opencode-Nonce") ?? null,
	});
	if (!auth.ok || !auth.enrollment)
		return (
			deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
			c.json({ error: auth.error }, deps.authErrorStatus(auth.error))
		);
	return deps.rateLimitedResponse(c, String(auth.enrollment.device_id), { authenticated: true });
}

async function checkResponse(
	c: Context,
	store: CoordinatorStore,
	rawPeers: unknown,
): Promise<Response> {
	const peers = parsePeerRevocationCheckPeers(rawPeers);
	if (!peers) return c.json({ error: "peers_invalid" }, 400);
	try {
		return c.json({ version: 1, revoked: await revokedPeerIds(store, peers) });
	} catch {
		return c.json({ error: "peer_revocation_unavailable" }, 503);
	}
}
