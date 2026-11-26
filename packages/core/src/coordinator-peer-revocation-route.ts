import type { Context } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorPeerRemovalLookupResult } from "./coordinator-peer-removal-query.js";
import type { CoordinatorEnrollment, CoordinatorStore } from "./coordinator-store-contract.js";

export const PEER_REVOCATION_CHECK_PATH = "/v1/peers/revocations";
/** Snapshot reads have fixed cost. Preserve the existing request cardinality limit. */
export const PEER_REVOCATION_CHECK_MAX_PEERS = 25;
const MAX_BODY_BYTES = 64 * 1024;

export interface PeerRevocationCheckPeer {
	device_id: string;
	public_key?: string;
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
		if (!isAuthControllerId(deviceId)) return null;
		if (
			publicKey !== undefined &&
			(typeof publicKey !== "string" ||
				publicKey.length === 0 ||
				publicKey.length > 4096 ||
				publicKey.includes("\0"))
		)
			return null;
		if (publicKey === undefined) peers.push({ device_id: deviceId });
		else peers.push({ device_id: deviceId, public_key: publicKey });
	}
	return peers;
}

function validIds(value: unknown, requested: Set<string>): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(id: unknown, i: number) =>
				typeof id === "string" && requested.has(id) && (i === 0 || value[i - 1] < id),
		)
	);
}

/** Refuse a broken store contract rather than replying with partial data or evidence. */
function completeSnapshot(
	raw: unknown,
	peers: PeerRevocationCheckPeer[],
): CoordinatorPeerRemovalLookupResult {
	if (!raw || typeof raw !== "object") throw new Error("peer_revocation_unavailable");
	const value = raw as Record<string, unknown>;
	const requested = new Set(peers.map((peer) => peer.device_id));
	if (
		!Number.isSafeInteger(value.removal_seq) ||
		(value.removal_seq as number) < 0 ||
		!["revoked", "removed", "enrolled"].every((field) => validIds(value[field], requested))
	)
		throw new Error("peer_revocation_unavailable");
	const result = raw as CoordinatorPeerRemovalLookupResult;
	if (result.removed.some((id) => result.revoked.includes(id)))
		throw new Error("peer_revocation_unavailable");
	return { ...result, key_evidence: checkedKeyEvidence(value.key_evidence, requested, result) };
}

/**
 * The key evidence when it keeps the contract, or none. A broken evidence answer
 * costs only the evidence: the legacy fields still answer as before it existed.
 */
function checkedKeyEvidence(
	raw: unknown,
	requested: Set<string>,
	result: CoordinatorPeerRemovalLookupResult,
): CoordinatorPeerRemovalLookupResult["key_evidence"] {
	const evidence = raw as Record<string, unknown> | null | undefined;
	if (
		!evidence ||
		typeof evidence !== "object" ||
		!["removed", "enrolled"].every((field) => validIds(evidence[field], requested)) ||
		// A key enrolled under an ID is an enrollment of that ID.
		(evidence.enrolled as string[]).some((id) => !result.enrolled.includes(id))
	)
		return { removed: [], enrolled: [] };
	return evidence as unknown as CoordinatorPeerRemovalLookupResult["key_evidence"];
}

/**
 * Lets an enrolled device read coordinator-wide revocation, removal and
 * enrollment state for only the IDs or keys it names, without evidence.
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
			const check = await authorizeCheck(c, deps, store, { groupId, raw });
			if ("denied" in check) return check.denied;
			const caller = { groupId, deviceId: check.deviceId, publicKey: check.publicKey };
			return await checkResponse(c, store, deps.parseJsonObject(raw)?.peers, caller);
		} catch {
			return c.json({ error: "peer_revocation_unavailable" }, 503);
		} finally {
			await store.close();
		}
	});
}

/** A denial or rate-limit response, or the signed caller's device ID once it may run the check. */
async function authorizeCheck(
	c: Context,
	deps: PeerRevocationCheckDeps,
	store: CoordinatorStore,
	request: { groupId: string; raw: Uint8Array },
): Promise<{ denied: Response } | { deviceId: string; publicKey: string }> {
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
		return {
			denied:
				deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
				c.json({ error: auth.error }, deps.authErrorStatus(auth.error)),
		};
	const deviceId = String(auth.enrollment.device_id);
	const limited = deps.rateLimitedResponse(c, deviceId, { authenticated: true });
	// The key the signature was verified with, so the lookup relates devices to this key only.
	return limited
		? { denied: limited }
		: { deviceId, publicKey: String(auth.enrollment.public_key) };
}

async function checkResponse(
	c: Context,
	store: CoordinatorStore,
	rawPeers: unknown,
	caller: { groupId: string; deviceId: string; publicKey: string },
): Promise<Response> {
	const peers = parsePeerRevocationCheckPeers(rawPeers);
	if (!peers) return c.json({ error: "peers_invalid" }, 400);
	try {
		// One page per authenticated, valid request. Only the subsequent snapshot
		// decides readiness; fill counters alone never authorize a complete answer.
		await store.fillEnrollmentKeyIds({ limit: 200 });
		const snapshot = completeSnapshot(
			await store.lookupPeerRemovals({
				peers: peers.map((peer) => ({ deviceId: peer.device_id, publicKey: peer.public_key })),
				caller,
			}),
			peers,
		);
		const { revoked, removed, enrolled, removal_seq, key_evidence } = snapshot;
		// `key_evidence` is additive: clients from before it read only the other fields.
		return c.json({
			version: 1,
			revoked,
			removed,
			enrolled,
			removal_seq,
			key_evidence: { removed: key_evidence.removed, enrolled: key_evidence.enrolled },
		});
	} catch {
		return c.json({ error: "peer_revocation_unavailable" }, 503);
	}
}
