import { relayAuthorityId, relayBodyDigest, relayRealmId } from "@codemem/core/internal/relay-host";

/**
 * The only env keys the relay reads. Bindings are never copied: the admission
 * fetcher comes from the Worker's own `ctx.exports` loopback, so COORDINATOR_DB
 * and every other coordinator binding stay out of relay code.
 */
export const RELAY_ENV_KEYS = [
	"CODEMEM_RELAY_ENABLED",
	"CODEMEM_RELAY_AUTHORITY_URL",
	"CODEMEM_RELAY_GROUPS",
	"CODEMEM_RELAY_SERVICE_KEY",
] as const;
type RelayEnvKey = (typeof RELAY_ENV_KEYS)[number];

/** The coordinator app serves this exact path. The Worker has no mount prefix. */
export const RELAY_ADMISSION_PATH = "/v1/relay/admission-check";

export interface RelayEnvSnapshot {
	readonly values: Readonly<Partial<Record<RelayEnvKey, string>>>;
}

export interface RelayRealmConfig {
	readonly authorityId: string;
	/** Full admission-check URL on the coordinator origin. */
	readonly admissionUrl: string;
	/** `wss://` origin of the coordinator host. Every realm object shares one audience. */
	readonly audienceOrigin: string;
	/** Configured realm IDs mapped to their group IDs. */
	readonly realms: ReadonlyMap<string, string>;
	/** Base64 PKCS#8 Ed25519 private key, from a Worker secret. */
	readonly serviceKey: string;
}

const MAX_REALMS = 64;
const encoder = new TextEncoder();

/** Copies only allowlisted string keys. Callers must drop `env` after this returns. */
export function captureRelayEnv(env: Readonly<Record<string, unknown>>): RelayEnvSnapshot {
	const values: Partial<Record<RelayEnvKey, string>> = {};
	for (const key of RELAY_ENV_KEYS) {
		const value = env[key];
		if (typeof value === "string") values[key] = value;
	}
	return Object.freeze({ values });
}

function readGroups(json: string | undefined): string[] | null {
	if (!json) return null;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REALMS) return null;
	const groups = value.filter(
		(group): group is string =>
			typeof group === "string" &&
			group === group.trim() &&
			encoder.encode(group).length >= 1 &&
			encoder.encode(group).length <= 128,
	);
	return groups.length === value.length && new Set(groups).size === groups.length ? groups : null;
}

/** Returns null, meaning relay disabled, unless the switch is on and every setting is valid. */
export function readRelayConfig(snapshot: RelayEnvSnapshot): RelayRealmConfig | null {
	const { values } = snapshot;
	if (values.CODEMEM_RELAY_ENABLED !== "true" || !values.CODEMEM_RELAY_SERVICE_KEY) return null;
	const groups = readGroups(values.CODEMEM_RELAY_GROUPS);
	if (!groups) return null;
	try {
		const authorityUrl = new URL(values.CODEMEM_RELAY_AUTHORITY_URL ?? "");
		// The Worker routes the coordinator from the root, so a path would sign an
		// admission pathname that no route serves.
		if (authorityUrl.pathname !== "/") return null;
		const authorityId = relayAuthorityId(authorityUrl.href);
		return Object.freeze({
			authorityId,
			admissionUrl: `${authorityUrl.origin}${RELAY_ADMISSION_PATH}`,
			audienceOrigin: `wss://${authorityUrl.host}`,
			realms: new Map(groups.map((group) => [relayRealmId(authorityId, group), group])),
			serviceKey: values.CODEMEM_RELAY_SERVICE_KEY,
		});
	} catch {
		return null;
	}
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** SSH wire prefix for an Ed25519 public key: length-prefixed "ssh-ed25519", then a 32-byte length. */
const SSH_ED25519_PREFIX = Uint8Array.from([
	0, 0, 0, 11, 115, 115, 104, 45, 101, 100, 50, 53, 53, 49, 57, 0, 0, 0, 32,
]);

/**
 * Imports the service key with WebCrypto. The key ID hashes the SSH wire form of
 * the public key, as relayEd25519KeyId does. Only a non-extractable copy is kept.
 */
export async function importRelayServiceSigner(pkcs8Base64: string) {
	const der = decodeBase64(pkcs8Base64);
	const algorithm = { name: "Ed25519" };
	const exportable = await crypto.subtle.importKey("pkcs8", der, algorithm, true, ["sign"]);
	const jwk = (await crypto.subtle.exportKey("jwk", exportable)) as JsonWebKey;
	const raw = decodeBase64(jwk.x ?? "");
	if (raw.length !== 32) throw new Error("Invalid relay service key");
	const wire = new Uint8Array(SSH_ED25519_PREFIX.length + raw.length);
	wire.set(SSH_ED25519_PREFIX);
	wire.set(raw, SSH_ED25519_PREFIX.length);
	const key = await crypto.subtle.importKey("pkcs8", der, algorithm, false, ["sign"]);
	return Object.freeze({
		keyId: relayBodyDigest(wire),
		sign: async (bytes: Uint8Array) =>
			new Uint8Array(await crypto.subtle.sign(algorithm, key, new Uint8Array(bytes))),
	});
}
