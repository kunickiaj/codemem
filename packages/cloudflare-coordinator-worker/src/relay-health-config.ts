import type { RelayHealthClockStamp } from "@codemem/core/internal/cloudflare-coordinator";
import { captureRelayEnv, type RelayRealmConfig, readRelayConfig } from "./relay-config.js";

/**
 * The only env keys relay health reads besides the relay keys. The probe key is a
 * Worker secret: base64 PKCS#8 Ed25519, the private key of an enrolled
 * low-privilege device. The scopes map each configured group to its synthetic scope.
 */
export const RELAY_HEALTH_ENV_KEYS = [
	"CODEMEM_RELAY_HEALTH_PROBE_DEVICE",
	"CODEMEM_RELAY_HEALTH_PROBE_KEY",
	"CODEMEM_RELAY_HEALTH_SCOPES",
] as const;
type RelayHealthEnvKey = (typeof RELAY_HEALTH_ENV_KEYS)[number];

/** Alarm cadence, the contract's default of two probe cycles per minute per realm. */
export const RELAY_HEALTH_INTERVAL_MS = 30_000;
/** One health object per Worker. It resets its windows when the authority changes. */
export const RELAY_HEALTH_OBJECT_NAME = "relay-health";

export interface RelayHealthConfig {
	readonly relay: RelayRealmConfig;
	/** HTTPS coordinator origin with a "/" path, which the probe requires. */
	readonly origin: string;
	readonly probeDeviceId: string;
	/** Decoded PKCS#8 bytes. Only WebCrypto import shows whether they hold a usable key. */
	readonly probeKey: Uint8Array<ArrayBuffer>;
	/** Group ID to synthetic scope ID, for every configured group. */
	readonly scopes: ReadonlyMap<string, string>;
}

const isId = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();

function readScopes(
	json: string | undefined,
	groups: readonly string[],
): Map<string, string> | null {
	let value: unknown;
	try {
		value = JSON.parse(json ?? "");
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const scopes = groups.map((group) => [group, record[group]] as const);
	if (!scopes.every(([, scope]) => isId(scope))) return null;
	return new Map(scopes as [string, string][]);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeKey(value: unknown): Uint8Array<ArrayBuffer> | null {
	if (typeof value !== "string" || !value || !BASE64.test(value)) return null;
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Null, meaning no health monitoring, unless relay is on and every health setting is valid. */
export function readRelayHealthConfig(
	env: Readonly<Record<string, unknown>>,
): RelayHealthConfig | null {
	const relay = readRelayConfig(captureRelayEnv(env));
	if (!relay) return null;
	const values: Partial<Record<RelayHealthEnvKey, unknown>> = {};
	for (const key of RELAY_HEALTH_ENV_KEYS) values[key] = env[key];
	const probeDeviceId = values.CODEMEM_RELAY_HEALTH_PROBE_DEVICE;
	const probeKey = decodeKey(values.CODEMEM_RELAY_HEALTH_PROBE_KEY);
	const scopes = readScopes(
		typeof values.CODEMEM_RELAY_HEALTH_SCOPES === "string"
			? values.CODEMEM_RELAY_HEALTH_SCOPES
			: undefined,
		[...relay.realms.values()],
	);
	const origin = new URL(relay.admissionUrl);
	if (!isId(probeDeviceId) || !probeKey || !scopes) return null;
	if (origin.protocol !== "https:") return null;
	return Object.freeze({ relay, origin: `${origin.origin}/`, probeDeviceId, probeKey, scopes });
}

/**
 * The Cloudflare host clock, treated as verified UTC by operator decision. The
 * error bound is an assumption, not a measurement: Cloudflare publishes no skew
 * figure. Workers timers also stand still during compute, which the bound absorbs.
 */
export function relayHealthClock(): RelayHealthClockStamp {
	return { utcMs: Math.floor(Date.now()), verified: true, maxErrorMs: 1000, resolutionMs: 1 };
}

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Normal v2 device signing for the probe: a fresh nonce per request and the real
 * UTC timestamp, which the coordinator checks against its own clock.
 */
export function createProbeSigner(deviceId: string, pkcs8: Uint8Array<ArrayBuffer>) {
	const key = crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
	// Config already rejected bad base64. Bytes that are not an Ed25519 PKCS#8 key fail
	// here, so every probe signature fails and readiness trips, instead of an unobserved rejection.
	key.catch(() => undefined);
	return async (input: { url: string; method: "GET"; body: Uint8Array }) => {
		const target = new URL(input.url);
		const timestamp = String(Math.floor(Date.now() / 1000));
		const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
		const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(input.body));
		const canonical = [
			input.method,
			target.pathname + target.search,
			timestamp,
			nonce,
			hex(new Uint8Array(digest)),
		].join("\n");
		const signature = await crypto.subtle.sign("Ed25519", await key, encoder.encode(canonical));
		return {
			"X-Opencode-Device": deviceId,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": nonce,
			"X-Opencode-Signature": `v2:${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
		};
	};
}
