import type { KeyObject } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
	DIRECT_NOISE_ACTIVE,
	DIRECT_NOISE_FEATURE,
	PAIRING_NOISE_TRANSPORT,
	promotePeerToNoiseRequired,
} from "./sync-transport-policy.js";
import {
	createTransportStatement,
	type SignedTransportStatement,
	TRANSPORT_STATEMENT_CAPABILITY,
	verifyTransportStatement,
} from "./sync-transport-statement.js";

export interface PairingPayload {
	device_id: string;
	fingerprint: string;
	public_key: string;
	address: string;
	addresses: string[];
	transports?: string[];
}

/**
 * The one pairing payload shape the CLI and the viewer both emit. The payload
 * travels out of band between the user's own devices and carries the key to
 * pin, so the transports it lists are trusted along with that key.
 */
export function buildPairingPayload(input: {
	deviceId: string;
	fingerprint: string;
	publicKey: string;
	addresses: string[];
	advertiseNoise?: boolean;
}): PairingPayload {
	const payload: PairingPayload = {
		device_id: input.deviceId,
		fingerprint: input.fingerprint,
		public_key: input.publicKey,
		address: input.addresses[0] ?? "",
		addresses: input.addresses,
	};
	if (input.advertiseNoise ?? DIRECT_NOISE_ACTIVE) payload.transports = [PAIRING_NOISE_TRANSPORT];
	return payload;
}

export function pairingPayloadOffersNoise(payload: Record<string, unknown>): boolean {
	const transports = payload.transports;
	return Array.isArray(transports) && transports.includes(PAIRING_NOISE_TRANSPORT);
}

/**
 * Record what an accepted pairing payload says about Noise. Call after the
 * payload's key is pinned. A payload without the transport leaves the peer's
 * policy as it was, so re-pairing never downgrades a peer.
 */
export function recordPairingTransportEvidence(
	db: Database,
	peerDeviceId: string,
	payload: Record<string, unknown>,
): boolean {
	if (!pairingPayloadOffersNoise(payload)) return false;
	return promotePeerToNoiseRequired(db, peerDeviceId, "pairing_payload");
}

/** Presence capability entries for this device's own signed statement. */
export function localTransportStatementCapability(input: {
	deviceId: string;
	fingerprint: string;
	privateKey: () => KeyObject | Buffer | null;
	active?: boolean;
	now?: Date;
}): Record<string, SignedTransportStatement> {
	if (!(input.active ?? DIRECT_NOISE_ACTIVE)) return {};
	const key = input.privateKey();
	if (!key) throw new Error("private key missing");
	return {
		[TRANSPORT_STATEMENT_CAPABILITY]: createTransportStatement(
			{
				deviceId: input.deviceId,
				fingerprint: input.fingerprint,
				features: [DIRECT_NOISE_FEATURE],
				issuedAt: (input.now ?? new Date()).toISOString(),
			},
			key,
		),
	};
}

type PinnedPeerRow = { public_key: string | null; pinned_fingerprint: string | null };

function pinnedKey(db: Database, peerDeviceId: string): string | null {
	const row = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as PinnedPeerRow | undefined;
	const publicKey = row?.public_key?.trim();
	return publicKey && row?.pinned_fingerprint?.trim() ? (row.public_key as string) : null;
}

/** Merged discovery records keep every group's statement here, not just the first group's. */
const STATEMENT_CANDIDATES = "transport_statement_candidates";

function statementOf(record: Record<string, unknown>): unknown {
	const capabilities = record.capabilities;
	if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities))
		return undefined;
	return (capabilities as Record<string, unknown>)[TRANSPORT_STATEMENT_CAPABILITY];
}

function statementCandidates(peer: Record<string, unknown>): unknown[] {
	const merged = peer[STATEMENT_CANDIDATES];
	const candidates = Array.isArray(merged) ? [...merged] : [];
	const own = statementOf(peer);
	if (own !== undefined) candidates.push(own);
	return candidates;
}

/** A discovery record for the first group listing a device, with that group's statement kept. */
export function withTransportStatementCandidates(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const own = statementOf(record);
	return { ...record, [STATEMENT_CANDIDATES]: own === undefined ? [] : [own] };
}

/** Keep a later group's statement when its record merges into an earlier one. */
export function appendTransportStatementCandidate(
	existing: Record<string, unknown>,
	record: Record<string, unknown>,
): void {
	const own = statementOf(record);
	if (own === undefined) return;
	const merged = existing[STATEMENT_CANDIDATES];
	existing[STATEMENT_CANDIDATES] = [...(Array.isArray(merged) ? merged : []), own];
}

function listsNoise(
	statements: readonly unknown[],
	pinned: { deviceId: string; publicKey: string },
): boolean {
	return statements.some((statement) =>
		verifyTransportStatement(statement, pinned)?.features.includes(DIRECT_NOISE_FEATURE),
	);
}

/**
 * Promote discovered peers whose own signed statement lists Noise. Every
 * group's statement is checked against the key this store already pinned for
 * the device, never against the key in the listing. A listing that omits or
 * breaks statements changes nothing. Returns how many peers were promoted.
 */
export function ingestCoordinatorTransportStatements(
	db: Database,
	peers: readonly Record<string, unknown>[],
): number {
	let promoted = 0;
	for (const peer of peers) {
		const deviceId = typeof peer.device_id === "string" ? peer.device_id.trim() : "";
		const statements = statementCandidates(peer);
		if (!deviceId || statements.length === 0) continue;
		const publicKey = pinnedKey(db, deviceId);
		if (!publicKey || !listsNoise(statements, { deviceId, publicKey })) continue;
		if (promotePeerToNoiseRequired(db, deviceId, "transport_statement")) promoted += 1;
	}
	return promoted;
}
