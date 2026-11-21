import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";

export const DEVICE_REJOIN_MAX_BODY_BYTES = 4 * 1024;
const START_WINDOW_MS = 5 * 60 * 1000;
const START_FIELDS = [
	"device_id",
	"public_key",
	"attempt_id",
	"browser_start_hash",
	"loopback_redirect",
	"timestamp_ms",
	"signature",
] as const;

interface DeviceRejoinStartInput {
	deviceId: string;
	publicKey: string;
	attemptId: string;
	browserStartHash: string;
	loopbackRedirect: string;
	timestampMs: number;
	signature: string;
}

type DeviceRejoinStartBody =
	| { ok: true; input: DeviceRejoinStartInput }
	| { ok: false; error: "device_rejoin_invalid_input" | "body_too_large" };

function exactStartFields(raw: Uint8Array): Record<string, unknown> | null {
	try {
		const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		if (
			Object.keys(data).length !== START_FIELDS.length ||
			!START_FIELDS.every((field) => Object.hasOwn(data, field))
		)
			return null;
		return data as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Checks the five-minute clock window specified for rejoin start. */
export function isFreshDeviceRejoinStart(timestampMs: unknown, nowMs: unknown): boolean {
	return (
		isTimestamp(timestampMs) &&
		isTimestamp(nowMs) &&
		Math.abs(timestampMs - nowMs) <= START_WINDOW_MS
	);
}

/** Validates the wire shape without authenticating the key or signature. */
export function parseDeviceRejoinStartBody(raw: Uint8Array): DeviceRejoinStartBody {
	if (raw.byteLength > DEVICE_REJOIN_MAX_BODY_BYTES) return { ok: false, error: "body_too_large" };
	const invalid = { ok: false, error: "device_rejoin_invalid_input" } as const;
	const data = exactStartFields(raw);
	if (!data) return invalid;
	const {
		device_id: deviceId,
		public_key: publicKey,
		attempt_id: attemptId,
		browser_start_hash: browserStartHash,
		timestamp_ms: timestampMs,
		signature,
	} = data;
	if (
		!isAuthControllerId(deviceId) ||
		!isAuthControllerId(attemptId) ||
		typeof publicKey !== "string" ||
		typeof browserStartHash !== "string" ||
		browserStartHash.length !== 64 ||
		!/^[a-f0-9]+$/u.test(browserStartHash) ||
		!isTimestamp(timestampMs) ||
		typeof signature !== "string"
	)
		return invalid;
	const loopback = parseCoordinatorAuthLoopback(data.loopback_redirect);
	if (!loopback.ok) return invalid;
	return {
		ok: true,
		input: {
			deviceId,
			publicKey,
			attemptId,
			browserStartHash,
			loopbackRedirect: loopback.destination,
			timestampMs,
			signature,
		},
	};
}
