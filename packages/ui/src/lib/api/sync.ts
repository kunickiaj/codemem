/* Sync-domain viewer endpoints — status, invite import, peer
 * lifecycle (accept, rename, delete, scope, identity), actor CRUD, and
 * the manual sync-now trigger. Every request in this file hits
 * /api/sync/* or /api/sync/run/* on the viewer. */

import { fetchJson, payloadError, readJsonPayload } from "./internal";
import type { AcceptDiscoveredPeerResult, ImportInviteResult, SyncRunResponse } from "./types";

export async function loadSyncStatus(
	includeDiagnostics: boolean,
	project = "",
	options?: { includeJoinRequests?: boolean },
): Promise<unknown> {
	const params = new URLSearchParams();
	if (includeDiagnostics) params.set("includeDiagnostics", "1");
	if (project) params.set("project", project);
	if (options?.includeJoinRequests) params.set("includeJoinRequests", "1");
	const suffix = params.size ? `?${params.toString()}` : "";
	return fetchJson(`/api/sync/status${suffix}`);
}

export async function importCoordinatorInvite(invite: string): Promise<ImportInviteResult> {
	const resp = await fetch("/api/sync/invites/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ invite }),
	});
	const { text, payload: data } = await readJsonPayload<ImportInviteResult>(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function loadSyncActors(): Promise<unknown> {
	return fetchJson("/api/sync/actors");
}

export async function loadPairing(includeDiagnostics = false): Promise<unknown> {
	const suffix = includeDiagnostics ? "?includeDiagnostics=1" : "";
	return fetchJson(`/api/sync/pairing${suffix}`);
}

export async function updatePeerScope(
	peerDeviceId: string,
	include: string[] | null,
	exclude: string[] | null,
	inheritGlobal = false,
): Promise<unknown> {
	const resp = await fetch("/api/sync/peers/scope", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			include,
			exclude,
			inherit_global: inheritGlobal,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) {
		throw new Error(payloadError(payload) || text || "request failed");
	}
	return payload;
}

export async function updatePeerIdentity(
	peerDeviceId: string,
	claimedLocalActor: boolean,
): Promise<unknown> {
	const resp = await fetch("/api/sync/peers/identity", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			claimed_local_actor: claimedLocalActor,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function assignPeerActor(
	peerDeviceId: string,
	actorId: string | null,
): Promise<unknown> {
	const resp = await fetch("/api/sync/peers/identity", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			actor_id: actorId,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function deletePeer(peerDeviceId: string): Promise<unknown> {
	const resp = await fetch(`/api/sync/peers/${encodeURIComponent(peerDeviceId)}`, {
		method: "DELETE",
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function renamePeer(peerDeviceId: string, name: string): Promise<unknown> {
	const resp = await fetch("/api/sync/peers/rename", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			name,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function acceptDiscoveredPeer(
	peerDeviceId: string,
	fingerprint: string,
): Promise<AcceptDiscoveredPeerResult> {
	const resp = await fetch("/api/sync/peers/accept-discovered", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			fingerprint,
		}),
	});
	const text = await resp.text();
	let payload: AcceptDiscoveredPeerResult = {};
	try {
		const parsed = text ? JSON.parse(text) : null;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			payload = parsed as AcceptDiscoveredPeerResult;
		}
	} catch {
		payload = {};
	}
	const detail = typeof payload.detail === "string" ? payload.detail : undefined;
	if (!resp.ok) throw new Error(detail || payloadError(payload) || text || "request failed");
	return payload;
}

export async function createActor(displayName: string): Promise<unknown> {
	const resp = await fetch("/api/sync/actors", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ display_name: displayName }),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function renameActor(actorId: string, displayName: string): Promise<unknown> {
	const resp = await fetch("/api/sync/actors/rename", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ actor_id: actorId, display_name: displayName }),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function mergeActor(
	primaryActorId: string,
	secondaryActorId: string,
): Promise<unknown> {
	const resp = await fetch("/api/sync/actors/merge", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			primary_actor_id: primaryActorId,
			secondary_actor_id: secondaryActorId,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function deactivateActor(actorId: string): Promise<unknown> {
	const resp = await fetch("/api/sync/actors/deactivate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ actor_id: actorId }),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function claimLegacyDeviceIdentity(originDeviceId: string): Promise<unknown> {
	const resp = await fetch("/api/sync/legacy-devices/claim", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ origin_device_id: originDeviceId }),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function triggerSync(address?: string): Promise<SyncRunResponse> {
	const payload = address ? { address } : {};
	const resp = await fetch("/api/sync/run", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const { text, payload: body } = await readJsonPayload<SyncRunResponse>(resp);
	if (!resp.ok) throw new Error(payloadError(body) || text || "request failed");
	if (!text) throw new Error("empty sync response");
	if (!Array.isArray(body?.items)) throw new Error(text || "invalid sync response");
	return body;
}
