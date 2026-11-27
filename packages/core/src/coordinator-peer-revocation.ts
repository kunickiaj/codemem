import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorSyncConfig } from "./coordinator-sync-config.js";
import type { Database } from "./db.js";
import { readPeerRemovalCheckState } from "./peer-removal-check-state.js";
import type { MemoryStore } from "./store.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";

/** Matches the coordinator's per-request limit on `/v1/peers/revocations`. */
const CHECK_BATCH_SIZE = 25;

/** `unsupported` means the coordinator predates the check; `failed` means the answer was unusable. */
export type PeerRevocationCheckStatus = "checked" | "unsupported" | "failed";

/** A device this device asks the coordinator about. A binding without a pairing has no key to send. */
export interface PeerRemovalLookupEntry {
	device_id: string;
	public_key?: string;
}

export interface PeerRemovalLookup {
	status: PeerRevocationCheckStatus;
	/** IDs this device sent that the coordinator blocked. Never also in `removed`. */
	revoked: string[];
	/** IDs this device sent that the coordinator removed. */
	removed: string[];
	/** IDs this device sent that the coordinator holds any enrollment for. */
	enrolled: string[];
	/**
	 * The lowest `removal_seq` among the replies of a lookup that every batch
	 * answered and that left out no pairing or binding. Otherwise null.
	 */
	removalSeq: number | null;
	/** The local counter value read in the same transaction as the entries. */
	generation: number | null;
	/** Groups that answered this device's signed request with `403 device_removed`. */
	removedFromGroups: string[];
	/**
	 * IDs whose key this device sent is still enabled under that ID, from the
	 * coordinator's key evidence. Absent or empty when the coordinator sent none.
	 */
	keyEnrolled?: string[];
}

/** What the coordinator says about one device, or that it gave no usable answer. */
export type PeerRemovalAnswer =
	| { answered: true; enrolled: boolean; removed: boolean; revoked: boolean }
	| { answered: false };

class CheckStatusError extends Error {
	constructor(readonly status: number) {
		super(`peer revocation check failed (${status})`);
	}
}

interface PeerRemovalReply {
	revoked: string[];
	removed: string[];
	enrolled: string[];
	removalSeq: number;
	keyEnrolled: string[];
}

type StoreLike = Pick<MemoryStore, "db" | "dbPath">;
type SignedRequest = {
	localDeviceId: string;
	groupId: string;
	keysDir?: string;
	removedFromGroups?: string[];
	/** Fail on a redirect, so the answer comes from the coordinator and group that were asked. */
	redirect?: "error";
};

/** The stored key when the coordinator would accept it. Otherwise the device is asked about by ID only. */
function usableKey(publicKey: string | null | undefined): string | undefined {
	if (typeof publicKey !== "string" || publicKey.trim() === "") return undefined;
	return publicKey.length <= 4096 && !publicKey.includes("\0") ? publicKey : undefined;
}

function lookupEntry(deviceId: string, publicKey?: string | null): PeerRemovalLookupEntry {
	const key = usableKey(publicKey);
	return key === undefined ? { device_id: deviceId } : { device_id: deviceId, public_key: key };
}

/**
 * One entry for every pairing and every device with an active binding, by device
 * ID. A pairing sends its key when it has a usable one. `omitted` is true when a
 * device ID fails the coordinator's identifier rule: sending it would fail the
 * whole batch, so it is left out, and the lookup then covers less than this
 * device holds.
 */
function lookupEntries(
	db: Database,
	localDeviceId: string,
): { entries: PeerRemovalLookupEntry[]; omitted: boolean } {
	const pairings = db
		.prepare(
			`SELECT peer_device_id, public_key FROM sync_peers
			 WHERE peer_device_id IS NOT ? ORDER BY peer_device_id`,
		)
		.all(localDeviceId) as Array<{ peer_device_id: unknown; public_key: string | null }>;
	const keys = new Map(pairings.map((row) => [row.peer_device_id, row.public_key]));
	const bound = db
		.prepare(
			`SELECT device_id FROM identity_devices
			 WHERE status = 'active' AND device_id IS NOT ? ORDER BY device_id`,
		)
		.pluck()
		.all(localDeviceId) as unknown[];
	const deviceIds = [...keys.keys(), ...bound.filter((deviceId) => !keys.has(deviceId))];
	const entries = deviceIds
		.filter((deviceId) => isAuthControllerId(deviceId))
		.map((deviceId) => lookupEntry(deviceId, keys.get(deviceId)));
	return { entries, omitted: entries.length !== deviceIds.length };
}

/** The reply's IDs among those this device asked about. Anything else in the array is ignored. */
function sentIds(value: unknown[], sent: Set<string>): string[] {
	return value.filter((id): id is string => typeof id === "string" && sent.has(id));
}

/**
 * The IDs whose sent key the coordinator reports still enabled, or none. Every
 * entry of both lists must be an ID this device sent a key for, every enabled
 * one must also be enrolled, and no ID may be both removed and enabled;
 * otherwise the whole evidence is discarded. A broken evidence answer costs
 * only the evidence, never the reply.
 */
function keyEnrolledIds(
	value: unknown,
	entries: PeerRemovalLookupEntry[],
	enrolled: readonly string[],
): string[] {
	const evidence = value as { removed?: unknown; enrolled?: unknown } | null | undefined;
	if (!evidence || typeof evidence !== "object") return [];
	if (!Array.isArray(evidence.removed) || !Array.isArray(evidence.enrolled)) return [];
	const keyed = new Set(
		entries.filter((entry) => entry.public_key).map((entry) => entry.device_id),
	);
	// Every entry must be an ID this device sent with a key; one stray entry voids it all.
	const strict = (list: unknown[]): list is string[] =>
		list.every((id) => typeof id === "string" && keyed.has(id));
	if (!strict(evidence.removed) || !strict(evidence.enrolled)) return [];
	const removedKeys = new Set(evidence.removed);
	if (evidence.enrolled.some((id) => removedKeys.has(id) || !enrolled.includes(id))) return [];
	return evidence.enrolled;
}

/** A reply without all three arrays and the integer is invalid, and the caller keeps every pairing. */
function parseReply(
	response: Record<string, unknown> | null,
	entries: PeerRemovalLookupEntry[],
): PeerRemovalReply {
	const { version, revoked, removed, enrolled, removal_seq: removalSeq } = response ?? {};
	if (
		version !== 1 ||
		!Array.isArray(revoked) ||
		!Array.isArray(removed) ||
		!Array.isArray(enrolled) ||
		!Number.isSafeInteger(removalSeq) ||
		(removalSeq as number) < 0
	)
		throw new Error("peer_revocation_response_invalid");
	const sent = new Set(entries.map((entry) => entry.device_id));
	const blocked = sentIds(revoked, sent);
	const enrolledIds = sentIds(enrolled, sent);
	return {
		revoked: blocked,
		// A block outranks a removal when a reply lists an ID in both.
		removed: sentIds(removed, sent).filter((id) => !blocked.includes(id)),
		enrolled: enrolledIds,
		removalSeq: removalSeq as number,
		keyEnrolled: keyEnrolledIds(response?.key_evidence, entries, enrolledIds),
	};
}

async function checkBatch(
	store: StoreLike,
	config: CoordinatorSyncConfig,
	request: SignedRequest,
	entries: PeerRemovalLookupEntry[],
): Promise<PeerRemovalReply> {
	const body = { peers: entries };
	const bodyBytes = Buffer.from(JSON.stringify(body), "utf8");
	const url = `${buildBaseUrl(config.syncCoordinatorUrl)}/v1/peers/revocations?group_id=${encodeURIComponent(request.groupId)}`;
	const headers = buildAuthHeaders({
		deviceId: request.localDeviceId,
		dbPath: store.dbPath,
		method: "POST",
		url,
		bodyBytes,
		keysDir: request.keysDir,
	});
	const [status, response] = await requestJson("POST", url, {
		headers,
		body,
		bodyBytes,
		timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
		redirect: request.redirect,
	});
	if (status === 403 && response?.error === "device_removed")
		request.removedFromGroups?.push(request.groupId);
	if (status !== 200) throw new CheckStatusError(status);
	return parseReply(response, entries);
}

type FirstAnswer =
	| { kind: "answered"; groupId: string; reply: PeerRemovalReply }
	| { kind: "unsupported" }
	| { kind: "refused" };

/**
 * How one group turned the check away. A disabled, removed, or archived
 * enrollment in a group still leaves the others, so those answers let the caller
 * try the next group. Any other failure is `failed`, and the caller ends the lookup.
 */
function groupRefusal(error: unknown): "unsupported" | "refused" | "failed" {
	if (!(error instanceof CheckStatusError)) return "failed";
	if (error.status === 404) return "unsupported";
	if (error.status !== 401 && error.status !== 403 && error.status !== 409) return "failed";
	return "refused";
}

/** Finds an authorized group, recording confirmed removals even if a later request fails. */
async function firstAuthorizedGroup(
	store: StoreLike,
	config: CoordinatorSyncConfig,
	options: { localDeviceId: string; keysDir?: string },
	firstBatch: PeerRemovalLookupEntry[],
	removedFromGroups?: string[],
): Promise<FirstAnswer> {
	for (const groupId of config.syncCoordinatorGroups) {
		try {
			const reply = await checkBatch(
				store,
				config,
				{ ...options, groupId, removedFromGroups },
				firstBatch,
			);
			return { kind: "answered", groupId, reply };
		} catch (error) {
			const refusal = groupRefusal(error);
			if (refusal === "failed") throw error;
			if (refusal === "unsupported") return { kind: "unsupported" };
		}
	}
	return { kind: "refused" };
}

function batchesOf(entries: PeerRemovalLookupEntry[]): PeerRemovalLookupEntry[][] {
	// A device with nothing to ask about still sends one request, to learn `removal_seq`.
	if (entries.length === 0) return [[]];
	const batches: PeerRemovalLookupEntry[][] = [];
	for (let start = 0; start < entries.length; start += CHECK_BATCH_SIZE) {
		batches.push(entries.slice(start, start + CHECK_BATCH_SIZE));
	}
	return batches;
}

function unanswered(
	status: PeerRevocationCheckStatus,
	generation: number | null,
	removedFromGroups: string[] = [],
): PeerRemovalLookup {
	return {
		status,
		revoked: [],
		removed: [],
		enrolled: [],
		removalSeq: null,
		generation,
		removedFromGroups,
	};
}

/**
 * Asks the coordinator which of this device's pairings and bound devices it has
 * blocked, removed, or still holds an enrollment for. Any failure keeps every
 * pairing: the lists are empty and `removalSeq` is null unless every batch
 * returned a valid reply. It changes no local state.
 */
export async function fetchPeerRemovalLookup(
	store: StoreLike,
	config: CoordinatorSyncConfig,
	options: { localDeviceId: string; keysDir?: string },
): Promise<PeerRemovalLookup> {
	// One read transaction, so the counter describes exactly these entries.
	const { entries, omitted, generation } = store.db.transaction(() => ({
		...lookupEntries(store.db, options.localDeviceId),
		generation: readPeerRemovalCheckState(store.db)?.generation ?? null,
	}))();
	const removedFromGroups: string[] = [];
	try {
		const [firstBatch = [], ...laterBatches] = batchesOf(entries);
		const first = await firstAuthorizedGroup(store, config, options, firstBatch, removedFromGroups);
		if (first.kind === "unsupported")
			return unanswered("unsupported", generation, removedFromGroups);
		if (first.kind === "refused") return unanswered("failed", generation, removedFromGroups);
		const replies = [first.reply];
		const request = { ...options, groupId: first.groupId, removedFromGroups };
		for (const batch of laterBatches) {
			replies.push(await checkBatch(store, config, request, batch));
		}
		return {
			status: "checked",
			revoked: replies.flatMap((reply) => reply.revoked),
			removed: replies.flatMap((reply) => reply.removed),
			enrolled: replies.flatMap((reply) => reply.enrolled),
			keyEnrolled: replies.flatMap((reply) => reply.keyEnrolled),
			// A removal recorded between two requests is above the lowest number, so it is not counted.
			// With a pairing or binding left out, no number describes everything this device holds.
			removalSeq: omitted ? null : Math.min(...replies.map((reply) => reply.removalSeq)),
			generation,
			removedFromGroups: [],
		};
	} catch {
		return unanswered("failed", generation, removedFromGroups);
	}
}

/**
 * Asks the coordinator about one device. No answer covers every case in which
 * the caller must not guess: the coordinator cannot be reached, predates the
 * check, replies with anything but a valid 200, or refuses this device in every
 * configured group. It changes no local state.
 */
export async function queryPeerRemoval(
	store: StoreLike,
	config: CoordinatorSyncConfig,
	options: { localDeviceId: string; keysDir?: string; deviceId: string; publicKey?: string },
): Promise<PeerRemovalAnswer> {
	// A key the caller names but the coordinator would reject cannot be asked about.
	const keyUnusable = options.publicKey !== undefined && usableKey(options.publicKey) === undefined;
	if (!isAuthControllerId(options.deviceId) || keyUnusable) return { answered: false };
	const entry = lookupEntry(options.deviceId, options.publicKey);
	try {
		const first = await firstAuthorizedGroup(store, config, options, [entry]);
		if (first.kind !== "answered") return { answered: false };
		return {
			answered: true,
			enrolled: first.reply.enrolled.includes(options.deviceId),
			removed: first.reply.removed.includes(options.deviceId),
			revoked: first.reply.revoked.includes(options.deviceId),
		};
	} catch {
		return { answered: false };
	}
}

/**
 * Asks the coordinator, as a member of exactly this group, which of these
 * devices it blocks. Returns the blocked IDs among those sent. Unlike the
 * lookups above it does not try another group and does not follow a redirect,
 * and it throws unless every batch came back as a valid answer: the caller
 * records the coordinator and group it asked, and that must be who answered.
 */
export async function fetchBlockedDeviceIdsForGroup(
	store: StoreLike,
	config: CoordinatorSyncConfig,
	request: { localDeviceId: string; keysDir?: string; groupId: string },
	peers: readonly PeerRemovalLookupEntry[],
): Promise<string[]> {
	const entries = peers.map((peer) => {
		const key = usableKey(peer.public_key);
		// A device that cannot be asked about by ID and key cannot be cleared.
		if (!isAuthControllerId(peer.device_id) || key === undefined)
			throw new Error("peer_block_check_unaskable");
		return { device_id: peer.device_id, public_key: key };
	});
	const blocked: string[] = [];
	for (const batch of batchesOf(entries)) {
		const reply = await checkBatch(store, config, { ...request, redirect: "error" }, batch);
		blocked.push(...reply.revoked);
	}
	return blocked;
}
