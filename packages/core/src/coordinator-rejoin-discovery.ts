import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { isRejoinTimestamp } from "./coordinator-rejoin-timestamp.js";
import type { CoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { requestJson } from "./sync-http-client.js";

type Options = {
	dbPath: string;
	deviceId: string;
	config: CoordinatorSyncConfig;
	peerIds: ReadonlySet<string>;
	signal?: AbortSignal;
};
type Proof = { fingerprint: string; rejoinedAtMs: number | null };

function capturedTarget(options: Options) {
	const origin = normalizeCoordinatorAccountLinkOrigin(options.config.syncCoordinatorUrl);
	const groups = [...new Set(options.config.syncCoordinatorGroups)];
	if (!origin || groups.length === 0 || groups.length > 25 || !groups.every(isAuthControllerId))
		return null;
	const device = readAccountLinkDevice(options.dbPath);
	if (device.deviceId !== options.deviceId) return null;
	return { origin, groups, device, keysDir: process.env.CODEMEM_KEYS_DIR?.trim() || undefined };
}

async function readGroup(
	options: Options,
	target: NonNullable<ReturnType<typeof capturedTarget>>,
	group: string,
) {
	const url = new URL("/v1/peers", target.origin);
	url.searchParams.set("group_id", group);
	const headers = signAccountLinkRequest({
		dbPath: options.dbPath,
		keysDir: target.keysDir,
		device: target.device,
		method: "GET",
		url: url.href,
		bodyBytes: Buffer.alloc(0),
	});
	const [status, body] = await requestJson("GET", url.href, {
		headers,
		redirect: "error",
		timeoutS: Math.max(1, options.config.syncCoordinatorTimeoutS),
		maxResponseBytes: 1024 * 1024,
		signal: options.signal,
	});
	if (status !== 200 || !Array.isArray(body?.items)) throw new Error("Discovery unavailable.");
	return body.items as unknown[];
}

async function extractPeerProof(record: Record<string, unknown>): Promise<Proof | null> {
	const { public_key: key, fingerprint, rejoined_at_ms: timestamp } = record;
	if (
		typeof key !== "string" ||
		typeof fingerprint !== "string" ||
		fingerprintPublicKey(key) !== fingerprint ||
		!(await ed25519KeyId(key))
	)
		return null;
	return { fingerprint, rejoinedAtMs: isRejoinTimestamp(timestamp) ? timestamp : null };
}

async function collectProofs(rows: unknown[], peerIds: ReadonlySet<string>) {
	const proofs = new Map<string, Proof | null>();
	for (const value of rows) {
		if (!value || typeof value !== "object") continue;
		const record = value as Record<string, unknown>;
		if (!isAuthControllerId(record.device_id)) continue;
		if (!peerIds.has(record.device_id)) continue;
		const proof = mergedProof(proofs.get(record.device_id), await extractPeerProof(record));
		proofs.set(record.device_id, proof);
	}
	return proofs;
}

function mergedProof(prior: Proof | null | undefined, proof: Proof | null): Proof | null {
	if (prior === null || !proof || (prior && prior.fingerprint !== proof.fingerprint)) return null;
	if (!prior) return proof;
	return (proof.rejoinedAtMs ?? -1) > (prior.rejoinedAtMs ?? -1) ? proof : prior;
}

/** Advisory evidence only. Its key digest is for internal comparison in the Viewer. */
export async function readCoordinatorRejoinDiscovery(options: Options) {
	try {
		const target = capturedTarget(options);
		if (!target) return new Map<string, Proof | null>();
		const rows = (
			await Promise.all(target.groups.map((group) => readGroup(options, target, group)))
		).flat();
		const proofs = await collectProofs(rows, options.peerIds);
		const current = readAccountLinkDevice(options.dbPath);
		if (
			options.signal?.aborted ||
			current.deviceId !== target.device.deviceId ||
			current.publicKey !== target.device.publicKey
		)
			return new Map<string, Proof | null>();
		return proofs;
	} catch {
		return new Map<string, Proof | null>();
	}
}
