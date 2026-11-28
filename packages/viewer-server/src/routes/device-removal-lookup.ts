import { createHash } from "node:crypto";
import {
	canonicalKeyId,
	fingerprintPublicKey,
	type MemoryStore,
	normalizeCoordinatorAccountLinkOrigin,
	queryPeerRemoval,
	type readCoordinatorSyncConfig,
	readUnpairedPeerPin,
	verifiedLocalKeyId,
} from "@codemem/core";

type RemovalStore = Pick<MemoryStore, "db" | "dbPath" | "deviceId">;
type ConfigReader = typeof readCoordinatorSyncConfig;
type Refusal = { error: string; status: 400 | 404 | 409 | 503 };
type PairingPin = {
	public_key: string | null;
	pinned_fingerprint: string | null;
	created_at: string;
};
type Subject = { localId: string; localKeyId: string; pin?: PairingPin; binding: unknown };
type LookupContext = { subject: Subject; config: ReturnType<ConfigReader>; digest: string };
type LookupResult =
	| Refusal
	| { mode: "coordinator"; context: LookupContext }
	| {
			mode: "local" | "already_removed";
			expectedDigest: string;
			contextDigest: string;
			revoked: boolean;
	  };

/**
 * The pairing's pin, or the last verified pin kept when this device unpaired the device. The
 * coordinator is asked about the key either way, so a key-only revocation filed under another
 * device ID is found. The kept pin never authorizes sync.
 */
function readPin(store: RemovalStore, deviceId: string): PairingPin | undefined {
	const live = store.db
		.prepare(
			"SELECT public_key, pinned_fingerprint, created_at FROM sync_peers WHERE peer_device_id = ?",
		)
		.get(deviceId) as PairingPin | undefined;
	if (live) return live;
	const kept = readUnpairedPeerPin(store.db, {
		localDeviceId: store.deviceId,
		peerDeviceId: deviceId,
	});
	return kept
		? {
				public_key: kept.publicKey,
				pinned_fingerprint: kept.pinnedFingerprint,
				created_at: kept.recordedAt,
			}
		: undefined;
}

function readSubject(store: RemovalStore, deviceId: string): Subject | Refusal {
	const configKey = verifiedLocalKeyId(store.db, store.deviceId);
	if (deviceId === store.deviceId)
		return { error: "cannot_remove_this_device", status: 400 } as const;
	if (!configKey) return { error: "local_identity_unverified", status: 409 } as const;
	const pin = readPin(store, deviceId);
	const key = pin?.public_key;
	if (key && canonicalKeyId(key) === configKey)
		return { error: "cannot_remove_this_device", status: 400 } as const;
	if (pin && (!key || !canonicalKeyId(key) || fingerprintPublicKey(key) !== pin.pinned_fingerprint))
		return { error: "removal_target_unavailable", status: 409 } as const;
	const binding = store.db
		.prepare("SELECT identity_id, status, revision FROM identity_devices WHERE device_id = ?")
		.get(deviceId);
	return { localId: store.deviceId, localKeyId: configKey, pin, binding };
}

function lookupContext(
	store: RemovalStore,
	deviceId: string,
	readConfig: ConfigReader,
): LookupContext | Refusal {
	const subject = readSubject(store, deviceId);
	if ("error" in subject) return subject;
	const config = readConfig();
	const origin = normalizeCoordinatorAccountLinkOrigin(config.syncCoordinatorUrl);
	if (!origin || !config.syncCoordinatorGroups.length)
		return { error: "device_removal_unavailable", status: 503 } as const;
	const digest = createHash("sha256")
		.update(JSON.stringify([deviceId, subject, origin, config.syncCoordinatorGroups]))
		.digest("hex");
	return { subject, config: { ...config, syncCoordinatorUrl: origin }, digest };
}

/** Signed global evidence, without a fallback to the list of enabled peers. */
export async function lookupViewerRemoval(
	store: RemovalStore,
	deviceId: string,
	readConfig: ConfigReader,
): Promise<LookupResult> {
	const context = lookupContext(store, deviceId, readConfig);
	if ("error" in context) return context;
	const answer = await queryPeerRemoval(store, context.config, {
		localDeviceId: context.subject.localId,
		keysDir: process.env.CODEMEM_KEYS_DIR?.trim() || undefined,
		deviceId,
		publicKey: context.subject.pin?.public_key ?? undefined,
	});
	const current = lookupContext(store, deviceId, readConfig);
	if ("error" in current || current.digest !== context.digest)
		return { error: "removal_preview_stale", status: 409 } as const;
	if (!answer.answered) return { error: "device_removal_unavailable", status: 503 } as const;
	if (answer.revoked || answer.removed)
		return localEvidence(context, "already_removed", { revoked: answer.revoked });
	if (answer.enrolled) return { mode: "coordinator", context } as const;
	return localEvidence(context, "local");
}

function localEvidence(
	context: LookupContext,
	mode: "local" | "already_removed",
	answer?: { revoked: boolean },
) {
	if (!context.subject.pin && !context.subject.binding)
		return { error: "removal_target_not_enrolled", status: 404 } as const;
	const expectedDigest = createHash("sha256").update(`${mode}:${context.digest}`).digest("hex");
	return { mode, expectedDigest, contextDigest: context.digest, revoked: answer?.revoked === true };
}

export function matchesViewerRemovalContext(
	store: RemovalStore,
	deviceId: string,
	readConfig: ConfigReader,
	digest: string,
) {
	const current = lookupContext(store, deviceId, readConfig);
	return !("error" in current) && current.digest === digest;
}
