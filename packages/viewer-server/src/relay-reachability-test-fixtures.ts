import { createPrivateKey } from "node:crypto";
import { createServer } from "node:net";
import type { Database } from "@codemem/core";
import {
	canonicalRelayServiceKey,
	type RelayGroupClientConfig,
	type RelayGroupResolution,
	reconcileRelayServicePin,
} from "@codemem/core/internal/relay-runtime";
import {
	admissionPath,
	type relayClientFixture,
} from "../../core/src/relay-peer-client-test-fixtures.js";
import { loadPrivateKey } from "../../core/src/sync-identity.js";

export const COORDINATOR = "https://coord.example";

type FixtureRelay = Awaited<ReturnType<typeof relayClientFixture>>;

export function identity(keysDir: string, expectedPin: string) {
	const key = loadPrivateKey(keysDir);
	if (!key) throw new Error("Missing disposable identity");
	return { key: createPrivateKey(key), expectedPin };
}

/** Ready client options that point at a loopback relay fixture. */
export function relayConfig(
	relay: FixtureRelay,
	groupId: string,
	servicePublicKey: string,
): RelayGroupClientConfig {
	return {
		coordinatorId: COORDINATOR,
		groupId,
		url: relay.url,
		admissionUrl: relay.admissionUrl,
		externalPathname: admissionPath,
		authorityId: relay.namespace.authorityId,
		relayAudienceId: relay.namespace.relayAudienceId,
		servicePublicKey,
	};
}

/**
 * Stands in for the coordinator fetch. It reconciles the advertised key with
 * the real pin store, so pausing and approval behave as in production.
 */
export function resolver(
	relays: Record<string, FixtureRelay>,
	advertised: Record<string, string> = {},
) {
	return async (db: Database, groupId: string): Promise<RelayGroupResolution> => {
		const relay = relays[groupId];
		if (!relay) throw new Error(`No relay for ${groupId}`);
		const pin = reconcileRelayServicePin(db, {
			coordinatorId: COORDINATOR,
			groupId,
			advertisedKey: canonicalRelayServiceKey(advertised[groupId] ?? relay.servicePublicKey) ?? "",
		});
		if (pin.status === "paused") return { ...pin, groupId };
		return { status: "ready", config: relayConfig(relay, groupId, pin.key) };
	};
}

export async function closedLoopbackUrl() {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing disposable listener");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${address.port}`;
}
