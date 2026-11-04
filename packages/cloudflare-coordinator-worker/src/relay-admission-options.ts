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

let cachedKeyId: { readonly serviceKey: string; readonly keyId: Promise<string> } | undefined;

/** The service key ID only changes with the secret, so one import per isolate is enough. */
function serviceKeyId(serviceKey: string): Promise<string> {
	if (cachedKeyId?.serviceKey !== serviceKey) {
		const keyId = importRelayServiceSigner(serviceKey).then((signer) => signer.keyId);
		// A failed import is retried on the next check.
		keyId.catch(() => {
			if (cachedKeyId?.keyId === keyId) cachedKeyId = undefined;
		});
		cachedKeyId = { serviceKey, keyId };
	}
	return cachedKeyId.keyId;
}

/** One server-owned namespace per group. Every group shares the authority and relay audience. */
export async function relayAdmissionOptions(
	config: RelayRealmConfig,
	groupIds: readonly string[],
	ingressKey: string,
): Promise<RelayAdmissionOptions> {
	const keyId = await serviceKeyId(config.serviceKey);
	const audience = relayAudienceId(config.audienceOrigin, keyId);
	return {
		namespaces: new Map(
			groupIds.map((groupId) => [
				groupId,
				{ authorityId: config.authorityId, groupId, relayAudienceId: audience },
			]),
		),
		externalPathname: RELAY_ADMISSION_PATH,
		ingressKey,
	};
}

/**
 * Admission options for the public coordinator route, or undefined to leave the
 * route off. The route serves every configured realm and selects the namespace
 * by the group ID in the device-signed packet body.
 */
export async function publicRelayAdmission(
	env: Readonly<Record<string, unknown>>,
): Promise<RelayAdmissionOptions | undefined> {
	const config = readRelayConfig(captureRelayEnv(env));
	const groupIds = config ? [...config.realms.values()] : [];
	if (!config || groupIds.length === 0) return undefined;
	return relayAdmissionOptions(config, groupIds, RELAY_INGRESS_PUBLIC).catch(() => undefined);
}
