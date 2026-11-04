import { relayDevice, relayExact, relayHex, relayInteger } from "./relay-control-codec.js";

/**
 * Bounded registration metadata that a hibernating host may store beside one socket.
 * It holds no packets, signatures, keys, routes, challenges, or queued frames.
 */
export interface RelayRegistrationSnapshot {
	readonly v: 1;
	readonly realmId: string;
	readonly deviceId: string;
	readonly keyId: string;
	readonly acceptedAtUtcMs: number;
	/**
	 * Renewal stays forbidden until this UTC time: `acceptedAtUtcMs + 720000`, with no guard.
	 * acceptedAtUtcMs is rounded up from the UTC instant the original check started, so on one
	 * host clock a restored socket never renews before Node would. Disagreement between two host
	 * clocks can move renewal up to 10 s earlier. That only shifts the renewal rate limit, because
	 * every renewal is a fresh single-use coordinator check that issues its own lease, while the
	 * existing lease stays bounded by restoreNotAfterUtcMs, which keeps the guard.
	 */
	readonly renewNotBeforeUtcMs: number;
	/** `utcSnapshot + effectiveRemainingMs - 10000` from the relay operations contract. */
	readonly restoreNotAfterUtcMs: number;
}

export interface RelayRestoredLease {
	readonly deviceId: string;
	readonly keyId: string;
	/** Time left before restoreNotAfterUtcMs, measured on the waking host's UTC clock. */
	readonly remainingMs: number;
	/** Time left before renewal is allowed, never negative. */
	readonly renewInMs: number;
}

/** Covers two host clocks that are each within five seconds of UTC. */
export const RELAY_RESTORE_GUARD_MS = 10_000;
export const RELAY_RENEW_AFTER_MS = 720_000;
const MAX_LEASE_MS = 900_000;
const FIELDS = [
	"v",
	"realmId",
	"deviceId",
	"keyId",
	"acceptedAtUtcMs",
	"renewNotBeforeUtcMs",
	"restoreNotAfterUtcMs",
] as const;

function utcReading(value: number): number | null {
	return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Snapshots the remaining monotonic lease and the host UTC clock in the same synchronous turn.
 * Returns null when there is no restorable lease: the UTC clock is unusable, or no more than
 * the 10 s guard remains.
 */
export function snapshotRelayRegistration(input: {
	readonly realmId: string;
	readonly deviceId: string;
	readonly keyId: string;
	readonly startedMs: number;
	readonly expiresMs: number;
	readonly nowMs: number;
	readonly utcMs: number;
}): RelayRegistrationSnapshot | null {
	const utc = utcReading(input.utcMs);
	if (utc === null || input.expiresMs - input.nowMs <= RELAY_RESTORE_GUARD_MS) return null;
	// Rounding moves acceptance later and the restore bound earlier, never the other way.
	const acceptedAtUtcMs = Math.ceil(utc - (input.nowMs - input.startedMs));
	const snapshot: RelayRegistrationSnapshot = {
		v: 1,
		realmId: input.realmId,
		deviceId: input.deviceId,
		keyId: input.keyId,
		acceptedAtUtcMs,
		renewNotBeforeUtcMs: acceptedAtUtcMs + RELAY_RENEW_AFTER_MS,
		restoreNotAfterUtcMs: Math.floor(
			utc + (input.expiresMs - input.nowMs) - RELAY_RESTORE_GUARD_MS,
		),
	};
	return validSnapshot(snapshot, input.realmId) ? snapshot : null;
}

function validSnapshot(value: unknown, realmId: string): value is RelayRegistrationSnapshot {
	if (!relayExact(value, FIELDS)) return false;
	const accepted = value.acceptedAtUtcMs;
	const restoreBy = value.restoreNotAfterUtcMs;
	return (
		value.v === 1 &&
		value.realmId === realmId &&
		relayDevice(value.deviceId) &&
		relayHex(value.keyId) &&
		relayInteger(accepted) &&
		relayInteger(restoreBy) &&
		value.renewNotBeforeUtcMs === accepted + RELAY_RENEW_AFTER_MS &&
		restoreBy > accepted &&
		restoreBy - accepted <= MAX_LEASE_MS - RELAY_RESTORE_GUARD_MS
	);
}

/**
 * Reads untrusted host metadata for one socket. Any malformed, foreign, future-dated,
 * or expired snapshot returns null. Remaining time never exceeds the stored UTC bound.
 */
export function readRelayRegistrationSnapshot(
	value: unknown,
	context: { readonly realmId: string; readonly utcMs: number },
): RelayRestoredLease | null {
	const utc = utcReading(context.utcMs);
	if (utc === null || !validSnapshot(value, context.realmId)) return null;
	if (value.acceptedAtUtcMs > utc + RELAY_RESTORE_GUARD_MS) return null;
	const remainingMs = value.restoreNotAfterUtcMs - utc;
	if (remainingMs <= 0) return null;
	return {
		deviceId: value.deviceId,
		keyId: value.keyId,
		remainingMs,
		renewInMs: Math.max(0, value.renewNotBeforeUtcMs - utc),
	};
}
