import {
	type CoordinatorRelayAdmissionRuntimeOptions,
	consistentRelayNamespaces,
} from "./coordinator-relay-admission-route.js";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";
import { relayRealmId } from "./relay-service-proof.js";

/** Body of `GET /v1/relay/info` for one served group. */
export interface CoordinatorRelayInfo {
	readonly group_id: string;
	/** SSH text without a comment, so devices compare and pin one canonical form. */
	readonly service_public_key: string;
	readonly relay_path: string;
	readonly admission_path: string;
}

/** Canonical `ssh-ed25519 <base64>` text, or null when the key does not parse. */
function canonicalServiceKey(publicKey: string | undefined): string | null {
	if (publicKey === undefined) return null;
	try {
		const { wireKey } = parseRelayEd25519PublicKey(publicKey);
		return `ssh-ed25519 ${btoa(String.fromCharCode(...wireKey))}`;
	} catch {
		return null;
	}
}

function capturedNamespaces(options: CoordinatorRelayAdmissionRuntimeOptions) {
	try {
		return consistentRelayNamespaces(options.namespaces);
	} catch {
		return null;
	}
}

/**
 * Server-owned relay info per served group, computed once from the admission
 * options. Relay off, a missing or invalid service key, or namespaces the
 * admission route would refuse all give an empty map, so no group is served.
 */
export function relayInfoByGroup(
	options: CoordinatorRelayAdmissionRuntimeOptions | undefined,
): ReadonlyMap<string, CoordinatorRelayInfo> {
	if (!options) return new Map();
	const servicePublicKey = canonicalServiceKey(options.servicePublicKey);
	const namespaces = capturedNamespaces(options);
	if (!servicePublicKey || !namespaces) return new Map();
	try {
		return new Map(
			[...namespaces.values()].map(({ authorityId, groupId }) => [
				groupId,
				Object.freeze({
					group_id: groupId,
					service_public_key: servicePublicKey,
					relay_path: `/v1/relay/${relayRealmId(authorityId, groupId)}`,
					admission_path: options.externalPathname,
				}),
			]),
		);
	} catch {
		// relayRealmId rejects a malformed authority ID. Serve no group rather than one.
		return new Map();
	}
}
