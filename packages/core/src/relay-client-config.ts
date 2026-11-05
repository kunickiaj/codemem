import type { RelayClientSettings } from "./coordinator-sync-config.js";
import type { Database } from "./db.js";
import { canonicalRelayServiceKey, parseRelayEd25519PublicKey } from "./relay-ed25519.js";
import { reconcileRelayServicePin } from "./relay-service-pin-store.js";
import {
	relayAudienceId,
	relayAuthorityId,
	relayBodyDigest,
	relayRealmId,
} from "./relay-service-proof.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { buildBaseUrl, type RequestJsonExecutor, requestJson } from "./sync-http-client.js";

export { canonicalRelayServiceKey } from "./relay-ed25519.js";

/** Admission pathname the coordinator serves at its root. */
export const RELAY_ADMISSION_PATH = "/v1/relay/admission-check";

/**
 * Synthetic origin for relayed sync requests. The source pass and the target
 * dispatcher must use this same value. It is never dialed or persisted.
 */
export const RELAY_LOGICAL_ORIGIN = "https://relay.codemem.invalid";

const RELAY_INFO_MAX_BYTES = 4096;

/** Relay endpoints derived only from the configured coordinator URL. */
export interface RelayCoordinatorEndpoint {
	/** Same value the coordinator runtime stores as `coordinator_id`. */
	readonly coordinatorId: string;
	readonly origin: string;
	readonly authorityId: string;
	readonly admissionUrl: string;
	/** `wss://<host>`, the origin that the relay audience ID hashes. */
	readonly audienceOrigin: string;
}

/** Options for `createRelayPeerClient` and `createRelayCoordinatorClient` for one group. */
export interface RelayGroupClientConfig {
	readonly coordinatorId: string;
	readonly groupId: string;
	readonly url: string;
	readonly admissionUrl: string;
	readonly externalPathname: string;
	readonly authorityId: string;
	readonly relayAudienceId: string;
	readonly servicePublicKey: string;
}

export type RelayDisabledReason =
	| "relay_opt_out"
	| "coordinator_url_unsupported"
	| "service_key_invalid"
	| "info_unavailable"
	| "info_invalid";

export type RelayInfoResult =
	| { readonly ok: true; readonly servicePublicKey: string }
	| { readonly ok: false; readonly reason: RelayDisabledReason };

export type RelayGroupResolution =
	| { readonly status: "ready"; readonly config: RelayGroupClientConfig }
	| {
			readonly status: "paused";
			readonly groupId: string;
			readonly pinnedKey: string;
			readonly candidateKey: string;
	  }
	| { readonly status: "disabled"; readonly groupId: string; readonly reason: RelayDisabledReason };

/**
 * Relay needs an explicit `https://` coordinator URL with no path, query,
 * fragment, or credentials, because the authority ID hashes the URL and the
 * coordinator serves relay from its root. Returns null for any other URL.
 */
export function relayCoordinatorEndpoint(configuredUrl: string): RelayCoordinatorEndpoint | null {
	const trimmed = configuredUrl.trim();
	// A missing scheme would otherwise become http:// through buildBaseUrl.
	if (!/^https:\/\//i.test(trimmed) || /[?#]/.test(trimmed)) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/")
		return null;
	return {
		coordinatorId: buildBaseUrl(trimmed),
		origin: url.origin,
		authorityId: relayAuthorityId(url.href),
		admissionUrl: `${url.origin}${RELAY_ADMISSION_PATH}`,
		audienceOrigin: `wss://${url.host}`,
	};
}

export function relayRealmPath(authorityId: string, groupId: string): string {
	return `/v1/relay/${relayRealmId(authorityId, groupId)}`;
}

/** Any mismatch with locally computed values disables relay for the group. */
export function validateRelayInfo(
	endpoint: RelayCoordinatorEndpoint,
	groupId: string,
	status: number,
	body: Record<string, unknown> | null,
): RelayInfoResult {
	if (status !== 200 || !body) return { ok: false, reason: "info_unavailable" };
	const key =
		typeof body.service_public_key === "string"
			? canonicalRelayServiceKey(body.service_public_key)
			: null;
	if (
		body.group_id !== groupId ||
		!key ||
		body.relay_path !== relayRealmPath(endpoint.authorityId, groupId) ||
		body.admission_path !== RELAY_ADMISSION_PATH
	)
		return { ok: false, reason: "info_invalid" };
	return { ok: true, servicePublicKey: key };
}

export interface RelayInfoFetchOptions {
	readonly endpoint: RelayCoordinatorEndpoint;
	readonly groupId: string;
	readonly deviceId: string;
	readonly dbPath?: string;
	readonly keysDir?: string;
	readonly timeoutS?: number;
	readonly signal?: AbortSignal;
	/** Test seam. Defaults to the shared coordinator JSON request helper. */
	readonly request?: RequestJsonExecutor;
}

/** Device-signed `GET /v1/relay/info`, signed the same way as `/v1/peers`. Never follows redirects. */
export async function fetchRelayInfo(options: RelayInfoFetchOptions): Promise<RelayInfoResult> {
	const { endpoint, groupId } = options;
	const url = `${endpoint.origin}/v1/relay/info?group_id=${encodeURIComponent(groupId)}`;
	try {
		const headers = buildAuthHeaders({
			deviceId: options.deviceId,
			dbPath: options.dbPath,
			method: "GET",
			url,
			bodyBytes: Buffer.alloc(0),
			keysDir: options.keysDir,
		});
		const [status, body] = await (options.request ?? requestJson)("GET", url, {
			headers,
			timeoutS: Math.max(1, options.timeoutS ?? 3),
			maxResponseBytes: RELAY_INFO_MAX_BYTES,
			redirect: "error",
			signal: options.signal,
		});
		return validateRelayInfo(endpoint, groupId, status, body);
	} catch {
		return { ok: false, reason: "info_unavailable" };
	}
}

export function relayGroupClientConfig(
	endpoint: RelayCoordinatorEndpoint,
	groupId: string,
	servicePublicKey: string,
): RelayGroupClientConfig {
	const keyId = relayBodyDigest(parseRelayEd25519PublicKey(servicePublicKey).wireKey);
	return {
		coordinatorId: endpoint.coordinatorId,
		groupId,
		// relay_path resolves against the configured origin, never a redirect or Host value.
		url: `${endpoint.audienceOrigin}${relayRealmPath(endpoint.authorityId, groupId)}`,
		admissionUrl: endpoint.admissionUrl,
		externalPathname: RELAY_ADMISSION_PATH,
		authorityId: endpoint.authorityId,
		relayAudienceId: relayAudienceId(endpoint.audienceOrigin, keyId),
		servicePublicKey,
	};
}

export interface ResolveRelayGroupOptions extends Omit<RelayInfoFetchOptions, "endpoint"> {
	readonly coordinatorUrl: string;
	readonly settings: RelayClientSettings;
	readonly now?: Date;
}

/**
 * Decide whether relay can run for one coordinator group: fetch and validate
 * the advertised info, then reconcile the service key with the local pin.
 */
export async function resolveRelayGroup(
	db: Database,
	options: ResolveRelayGroupOptions,
): Promise<RelayGroupResolution> {
	const { groupId, settings } = options;
	const disabled = (reason: RelayDisabledReason): RelayGroupResolution => ({
		status: "disabled",
		groupId,
		reason,
	});
	if (!settings.enabled) return disabled("relay_opt_out");
	const endpoint = relayCoordinatorEndpoint(options.coordinatorUrl);
	if (!endpoint) return disabled("coordinator_url_unsupported");
	const operatorKey = settings.serviceKey ? canonicalRelayServiceKey(settings.serviceKey) : null;
	if (settings.serviceKey && !operatorKey) return disabled("service_key_invalid");
	const info = await fetchRelayInfo({ ...options, endpoint });
	if (!info.ok) return disabled(info.reason);
	const pin = reconcileRelayServicePin(db, {
		coordinatorId: endpoint.coordinatorId,
		groupId,
		advertisedKey: info.servicePublicKey,
		operatorKey: operatorKey ?? undefined,
		now: options.now,
	});
	if (pin.status === "paused") return { ...pin, groupId };
	return { status: "ready", config: relayGroupClientConfig(endpoint, groupId, pin.key) };
}
