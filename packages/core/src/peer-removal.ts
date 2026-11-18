import {
	type CoordinatorSyncConfig,
	coordinatorAdminReadiness,
	isCoordinatorAdminDevice,
	readCoordinatorSyncConfig,
} from "./coordinator-sync-config.js";
import type { Database } from "./db.js";
import { getCodememConfigPath, readCodememConfigFileForMutation } from "./observer-config.js";
import { type PairingRemovalCounts, removePairingState } from "./pairing-removal.js";

/** What the coordinator says about a device. `unknown` covers every case without an answer. */
export type CoordinatorDeviceAnswer =
	| "removed"
	| "revoked"
	| "not_enrolled"
	| "enrolled"
	| "unknown";

export type CoordinatorDeviceAnswerLookup = (deviceId: string) => Promise<CoordinatorDeviceAnswer>;

/** Nothing asks the coordinator about a single device yet, so there is no answer. */
export const noCoordinatorDeviceAnswer: CoordinatorDeviceAnswerLookup = async () => "unknown";

export type PeerBindingOutcome = "ended" | "kept";

export interface PeerBindingDecisionInput {
	/** This device is ready and holds the coordinator admin secret. */
	isAdminDevice: boolean;
	coordinatorConfigured: boolean;
	coordinatorAnswer: CoordinatorDeviceAnswer;
}

/** The coordinator gives such a device no access, so ending its binding takes none away. */
const ANSWERS_WITHOUT_ACCESS: ReadonlySet<string> = new Set<CoordinatorDeviceAnswer>([
	"removed",
	"revoked",
	"not_enrolled",
]);

/** Whether disconnecting also ends the other device's binding under ADR 0007 Decision 4. */
export function decidePeerBinding(input: PeerBindingDecisionInput): PeerBindingOutcome {
	if (input.isAdminDevice) return "ended";
	if (!input.coordinatorConfigured) return "ended";
	if (ANSWERS_WITHOUT_ACCESS.has(input.coordinatorAnswer)) return "ended";
	return "kept";
}

export interface PeerRemovalOptions {
	localDeviceId: string;
	peerDeviceId: string;
	readConfig?: () => CoordinatorSyncConfig;
	lookupCoordinatorAnswer?: CoordinatorDeviceAnswerLookup;
}

export interface PeerRemovalResult {
	binding: PeerBindingOutcome;
	removed: PairingRemovalCounts;
}

async function coordinatorAnswerFor(
	lookup: CoordinatorDeviceAnswerLookup,
	deviceId: string,
): Promise<CoordinatorDeviceAnswer> {
	try {
		return await lookup(deviceId);
	} catch {
		return "unknown";
	}
}

/** A damaged config must not look like a device with no coordinator. */
function readPeerRemovalConfig(): CoordinatorSyncConfig {
	const result = readCodememConfigFileForMutation(getCodememConfigPath());
	if (result.status === "invalid" || result.status === "unreadable") {
		throw new Error("peer_removal_config_unavailable");
	}
	return readCoordinatorSyncConfig(result.status === "valid" ? result.data : {});
}

/** Settings that cannot be read count as a configured coordinator without the admin secret. */
function coordinatorStanding(
	readConfig: () => CoordinatorSyncConfig,
): Pick<PeerBindingDecisionInput, "isAdminDevice" | "coordinatorConfigured"> {
	try {
		const config = readConfig();
		return {
			isAdminDevice: isCoordinatorAdminDevice(config),
			coordinatorConfigured: coordinatorAdminReadiness(config) !== "not_configured",
		};
	} catch {
		return { isAdminDevice: false, coordinatorConfigured: true };
	}
}

/**
 * Deletes this device's pairing with the peer and its sync progress, and ends the
 * peer's Identity binding only when `decidePeerBinding` allows it. One transaction:
 * a failure leaves every table unchanged.
 */
export async function removePeerFromThisDevice(
	db: Database,
	options: PeerRemovalOptions,
): Promise<PeerRemovalResult> {
	const coordinatorAnswer = await coordinatorAnswerFor(
		options.lookupCoordinatorAnswer ?? noCoordinatorDeviceAnswer,
		options.peerDeviceId,
	);
	// No await from here to the write, so a settings change cannot land between them.
	const decision = decidePeerBinding({
		...coordinatorStanding(options.readConfig ?? readPeerRemovalConfig),
		coordinatorAnswer,
	});
	// This device's own binding is never ended by removing a pairing.
	const binding = options.peerDeviceId === options.localDeviceId ? "kept" : decision;
	const removed = removePairingState(db, {
		localDeviceId: options.localDeviceId,
		reason: binding === "ended" ? "local" : "disconnect",
		deviceIds: [options.peerDeviceId],
	});
	return { binding, removed };
}
