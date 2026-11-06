import { createPrivateKey, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { applyReplicationOps } from "@codemem/core";
// Named here so the inferred fixture type can appear in this file's emitted declarations.
import type BetterSqlite3 from "better-sqlite3";
import { vi } from "vitest";
import type { OwnedPeerHttpConnection } from "../../core/src/peer-http-client.js";
import type { RelayCheckPacket } from "../../core/src/relay-admission-codec.js";
import type {
	RelayFaultAction,
	RelayFaultFrame,
	RelayFaultRule,
} from "../../core/src/relay-fault-proxy-test-fixtures.js";
import { simulatedRelayPairPacing } from "../../core/src/relay-pair-pacing-test-fixtures.js";
import {
	type RelayClientTestOptions,
	relayClientFixture,
} from "../../core/src/relay-peer-client-test-fixtures.js";
import type { SecretScanner } from "../../core/src/secret-scanner.js";
import { loadPrivateKey } from "../../core/src/sync-identity.js";
import { createSyncChannelDispatcher } from "./sync-channel-dispatch.js";
import { ORIGIN, SCOPE } from "./sync-channel-dispatch-test-fixtures.js";
import { passFixture } from "./sync-channel-pass-test-fixtures.js";

/** Disposers for fixtures built in the current test. Callers drain it in afterEach. */
export const relaySyncCleanups: (() => Promise<unknown>)[] = [];

export async function runRelaySyncCleanups(): Promise<void> {
	for (const cleanup of relaySyncCleanups.splice(0).reverse()) await cleanup();
}

function identity(keysDir: string, expectedPin: string) {
	const key = loadPrivateKey(keysDir);
	if (!key) throw new Error("Missing disposable identity");
	return { key: createPrivateKey(key), expectedPin };
}
export async function relaySyncFixture(relayOptions: RelayClientTestOptions = {}) {
	const stores = await passFixture();
	relaySyncCleanups.push(stores.cleanup);
	const { remote } = stores;
	const serverKeys = join(dirname(remote.peerKeysDir), "local-keys");
	const relay = await relayClientFixture(
		{
			source: identity(remote.peerKeysDir, remote.peerPublicKey),
			target: identity(serverKeys, remote.localPublicKey),
		},
		{ source: remote.peerDeviceId, target: remote.localDeviceId },
		{ simulatedPairPacing: simulatedRelayPairPacing(), ...relayOptions },
	);
	relaySyncCleanups.push(() => relay.dispose());
	const dispatch = createSyncChannelDispatcher({ storeFactory: remote.storeFactory });
	const control = { interruptPost: false };
	const target = relay.client("target", {
		onInbound: async (_connection, context) =>
			context.serve({
				origin: ORIGIN,
				dispatch: async (request) => {
					vi.stubEnv("CODEMEM_KEYS_DIR", serverKeys);
					const response = await dispatch(request);
					if (control.interruptPost && request.method === "POST") await source.close();
					return response;
				},
			}),
	});
	const source = relay.client("source");
	const original = source.factory(remote.localDeviceId, remote.localPublicKey);
	const factory = {
		open: vi.fn(original.open),
		failureReason: original.failureReason,
	};
	const options = { ...stores.options, factory };
	return { ...stores, relay, source, target, options, factory, control };
}

export type RelaySyncFixture = Awaited<ReturnType<typeof relaySyncFixture>>;
// Re-exported so the declaration emit can name the fixture's inferred types.
export type { BetterSqlite3, OwnedPeerHttpConnection, RelayCheckPacket, SecretScanner };

export function titles(f: RelaySyncFixture, side: "client" | "remote") {
	const store = side === "client" ? f.client : f.remote.store;
	return store.db
		.prepare("SELECT title FROM memory_items WHERE scope_id = ? ORDER BY title")
		.pluck()
		.all(SCOPE);
}

export function seedOtherSpace(f: RelaySyncFixture, authored: ReturnType<typeof f.seed>) {
	const scope = f.client.db
		.prepare("SELECT * FROM replication_scopes WHERE scope_id = ?")
		.get(SCOPE) as Record<string, unknown>;
	const columns = Object.keys(scope);
	f.client.db
		.prepare(
			`INSERT INTO replication_scopes (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		)
		.run(...Object.values({ ...scope, scope_id: "other-space" }));
	const op = {
		...authored,
		op_id: "other-space-op",
		entity_id: `memory-source-v1:${Buffer.from(f.remote.peerDeviceId).toString("base64url")}:${randomUUID()}`,
		scope_id: "other-space",
		payload_json: JSON.stringify({
			...JSON.parse(authored.payload_json),
			scope_id: "other-space",
			title: "other-space-item",
		}),
	};
	const result = applyReplicationOps(f.client.db, [op], f.remote.localDeviceId, f.client.scanner);
	if (result.applied !== 1 || result.errors.length) throw new Error(JSON.stringify(result));
}

/** Applies `action` to the nth frame toward the source socket that `matches` selects. */
export function onSourceFrame(
	matches: (frame: RelayFaultFrame) => boolean,
	nth: number,
	action: RelayFaultAction,
): RelayFaultRule {
	let seen = 0;
	return (frame) => {
		// The target registers first, so the source owns proxy socket 1.
		if (frame.socket !== 1 || frame.direction !== "toPeer" || !matches(frame)) return;
		return seen++ === nth ? action : undefined;
	};
}
