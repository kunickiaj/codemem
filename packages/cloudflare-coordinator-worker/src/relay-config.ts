import {
	type RelayCoordinatorClientOptions,
	relayAuthorityId,
	relayBodyDigest,
	relayRealmId,
} from "@codemem/core/internal/relay-host";

/**
 * The only plain env keys the relay reads. The admission fetcher is the one other
 * value copied, from the binding that CODEMEM_RELAY_ADMISSION_BINDING names.
 * COORDINATOR_DB and every other coordinator binding stay out of relay code.
 */
export const RELAY_ENV_KEYS = [
	"CODEMEM_RELAY_ENABLED",
	"CODEMEM_RELAY_AUTHORITY_URL",
	"CODEMEM_RELAY_GROUPS",
	"CODEMEM_RELAY_SERVICE_KEY",
	"CODEMEM_RELAY_ADMISSION_BINDING",
] as const;
type RelayEnvKey = (typeof RELAY_ENV_KEYS)[number];
type RelayAdmissionFetcher = NonNullable<RelayCoordinatorClientOptions["fetcher"]>;

export interface RelayEnvSnapshot {
	readonly values: Readonly<Partial<Record<RelayEnvKey, string>>>;
	readonly admission?: RelayAdmissionFetcher;
}

export interface RelayRealmConfig {
	readonly authorityId: string;
	/** Full admission-check URL. The route compares its pathname, so it keeps any mount prefix. */
	readonly admissionUrl: string;
	/** `wss://` origin of the coordinator host. Every realm object shares one audience. */
	readonly audienceOrigin: string;
	/** Configured realm IDs mapped to their group IDs. */
	readonly realms: ReadonlyMap<string, string>;
	/** Base64 PKCS#8 Ed25519 private key, from a Worker secret. */
	readonly serviceKey: string;
	readonly admission: RelayAdmissionFetcher;
}

const BINDING_NAME = /^RELAY_[A-Z0-9_]{1,58}$/;
const MAX_REALMS = 64;
const encoder = new TextEncoder();

/** Copies only allowlisted keys. Callers must drop `env` after this returns. */
export function captureRelayEnv(env: Readonly<Record<string, unknown>>): RelayEnvSnapshot {
	const values: Partial<Record<RelayEnvKey, string>> = {};
	for (const key of RELAY_ENV_KEYS) {
		const value = env[key];
		if (typeof value === "string") values[key] = value;
	}
	const name = values.CODEMEM_RELAY_ADMISSION_BINDING;
	// The name pattern cannot match COORDINATOR_DB, so the D1 binding is never read.
	if (!name || !BINDING_NAME.test(name)) return Object.freeze({ values });
	const binding = env[name] as Partial<RelayAdmissionFetcher> | undefined;
	if (typeof binding?.fetch !== "function") return Object.freeze({ values });
	const fetcher = binding as RelayAdmissionFetcher;
	return Object.freeze({
		values,
		admission: Object.freeze({
			fetch: (url: string, init: RequestInit) => fetcher.fetch(url, init),
		}),
	});
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
	const { values, admission } = snapshot;
	if (values.CODEMEM_RELAY_ENABLED !== "true" || !admission || !values.CODEMEM_RELAY_SERVICE_KEY)
		return null;
	const groups = readGroups(values.CODEMEM_RELAY_GROUPS);
	if (!groups) return null;
	try {
		const authorityUrl = new URL(values.CODEMEM_RELAY_AUTHORITY_URL ?? "");
		const authorityId = relayAuthorityId(authorityUrl.href);
		const base = `${authorityUrl.origin}${authorityUrl.pathname}`.replace(/\/+$/, "");
		return Object.freeze({
			authorityId,
			admissionUrl: `${base}/v1/relay/admission-check`,
			audienceOrigin: `wss://${authorityUrl.host}`,
			realms: new Map(groups.map((group) => [relayRealmId(authorityId, group), group])),
			serviceKey: values.CODEMEM_RELAY_SERVICE_KEY,
			admission,
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
