import type { CreateD1CoordinatorAppOptions } from "@codemem/core/internal/cloudflare-coordinator";
import { relayAudienceId } from "@codemem/core/internal/relay-host";
import {
	captureRelayEnv,
	importRelayServiceSigner,
	RELAY_ADMISSION_PATH,
	type RelayRealmConfig,
	readRelayConfig,
} from "./relay-config.js";

export type RelayAdmissionOptions = NonNullable<CreateD1CoordinatorAppOptions["relayAdmission"]>;

/** Ingress labels. Checks the relay sends over the loopback never share the public label. */
export const RELAY_INGRESS_PUBLIC = "coordinator-public";
export const RELAY_INGRESS_LOOPBACK = "relay-loopback";

interface ServicePublicKey {
	readonly keyId: string;
	/** SSH text that `GET /v1/relay/info` advertises to enrolled devices. */
	readonly text: string;
}

let cachedKey: { readonly serviceKey: string; readonly key: Promise<ServicePublicKey> } | undefined;

/** The service public key only changes with the secret, so one import per isolate is enough. */
function servicePublicKey(serviceKey: string): Promise<ServicePublicKey> {
	if (cachedKey?.serviceKey !== serviceKey) {
		const key = importRelayServiceSigner(serviceKey).then((signer) => ({
			keyId: signer.keyId,
			text: signer.publicKey,
		}));
		// A failed import is retried on the next check.
		key.catch(() => {
			if (cachedKey?.key === key) cachedKey = undefined;
		});
		cachedKey = { serviceKey, key };
	}
	return cachedKey.key;
}

/** The relay audience every configured realm shares: the coordinator host and service key. */
export async function relayServiceAudienceId(config: RelayRealmConfig): Promise<string> {
	return relayAudienceId(config.audienceOrigin, (await servicePublicKey(config.serviceKey)).keyId);
}

/** One server-owned namespace per group. Every group shares the authority and relay audience. */
export async function relayAdmissionOptions(
	config: RelayRealmConfig,
	groupIds: readonly string[],
	ingressKey: string,
): Promise<RelayAdmissionOptions> {
	const key = await servicePublicKey(config.serviceKey);
	const audience = relayAudienceId(config.audienceOrigin, key.keyId);
	return {
		namespaces: new Map(
			groupIds.map((groupId) => [
				groupId,
				{ authorityId: config.authorityId, groupId, relayAudienceId: audience },
			]),
		),
		externalPathname: RELAY_ADMISSION_PATH,
		ingressKey,
		servicePublicKey: key.text,
	};
}

/**
 * Admission options for the public coordinator routes, or undefined to leave
 * relay off. The admission route serves every configured realm and selects the
 * namespace by the group ID in the device-signed packet body. The info route
 * reads the same namespaces and the service public key.
 */
export async function publicRelayAdmission(
	env: Readonly<Record<string, unknown>>,
): Promise<RelayAdmissionOptions | undefined> {
	const config = readRelayConfig(captureRelayEnv(env));
	const groupIds = config ? [...config.realms.values()] : [];
	if (!config || groupIds.length === 0) return undefined;
	return relayAdmissionOptions(config, groupIds, RELAY_INGRESS_PUBLIC).catch(() => undefined);
}
