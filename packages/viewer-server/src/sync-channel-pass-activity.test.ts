import { createPrivateKey } from "node:crypto";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseRelayEd25519PublicKey } from "../../core/src/relay-ed25519.js";
import * as relayNoise from "../../core/src/relay-noise.js";
import { createRelayPeerClient } from "../../core/src/relay-peer-client.js";
import {
	disposableIdentity,
	relayClientFixture,
	relayDeadline,
} from "../../core/src/relay-peer-client-test-fixtures.js";
import { relayAudienceId, relayBodyDigest } from "../../core/src/relay-service-proof.js";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import {
	getSyncChannelProgress,
	saveSyncChannelCompletedBoundary,
} from "../../core/src/sync-channel-progress.js";
import { loadPrivateKey } from "../../core/src/sync-identity.js";
import { runSyncPass } from "../../core/src/sync-orchestration.js";
import { recordSyncAttempt } from "../../core/src/sync-pass.js";
import { getSyncResetState } from "../../core/src/sync-replication.js";
import {
	readPeerSyncActivity,
	recordSyncTransferObservation,
} from "../../core/src/sync-transfer-activity.js";
import { overallSyncHealth, readPeerSyncHealth } from "./application/sync-health.js";
import { bytes } from "./sync-channel-dispatch-test-fixtures.js";
import { passFixture } from "./sync-channel-pass-test-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function fixture() {
	const f = await passFixture();
	cleanups.push(f.cleanup);
	return f;
}

for (const failure of ["open", "status", "pull"] as const) {
	it.each([undefined, "exchange_failed", "apply_failed", "scope_rejected"] as const)(
		`records ${failure} failure only after status succeeds, preserving prior %s`,
		async (previousError) => {
			// Arrange: fail the selected channel stage without changing earlier replies.
			const f = await fixture();
			const peer = f.remote.localDeviceId;
			if (failure === "pull")
				saveSyncChannelCompletedBoundary(f.client.db, {
					peerDeviceId: peer,
					scopeId: f.options.scopeId,
					boundary: getSyncResetState(f.remote.store.db, f.options.scopeId),
				});
			const progress = getSyncChannelProgress(f.client.db, peer, f.options.scopeId);
			if (previousError)
				recordSyncTransferObservation(f.client.db, peer, "receive", { errorCode: previousError });
			const before = readPeerSyncActivity(f.client.db, [peer]).get(peer);
			if (failure === "open") {
				f.factory.open.mockRejectedValue(new Error("Controlled route failure"));
			} else {
				f.control.afterDispatch = (request, response) => {
					const path = failure === "pull" ? "/v1/ops" : "/v1/status";
					if (new URL(request.url).pathname !== path) return response;
					return { status: 500, bodyBytes: bytes({ error: "controlled_failure" }) };
				};
			}
			// Act.
			const result = await syncScopedChannelOnce(f.options);
			// Assert: only an established exchange can change directional observations.
			expect(result).toMatchObject({
				ok: false,
				error: failure === "pull" ? "channel pull failed" : "scoped channel exchange failed",
			});
			const activity = readPeerSyncActivity(f.client.db, [peer]).get(peer);
			if (failure !== "pull") expect(activity).toEqual(before);
			else
				expect(activity).toMatchObject({
					receive: {
						errorCode: previousError ?? "exchange_failed",
						lastAttemptAt: expect.any(String),
						lastSuccessAt: null,
					},
					send: { errorCode: null, lastAttemptAt: null },
				});
			const expectedRequests = {
				open: [],
				status: ["/v1/status"],
				pull: ["/v1/status", "/v1/ops"],
			};
			expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(
				expectedRequests[failure],
			);
			expect(getSyncChannelProgress(f.client.db, peer, f.options.scopeId)).toEqual(progress);
		},
	);
}

it.each(["relay_rejected", "relay_expired"] as const)(
	"keeps direct and relay unreachable health equivalent for %s, retaining diagnostics",
	async (reason) => {
		const f = await fixture();
		const peer = f.remote.localDeviceId;
		const old = new Date(Date.now() - 3_600_000);
		for (const direction of ["send", "receive"] as const)
			recordSyncTransferObservation(f.client.db, peer, direction, { now: old });
		const before = readPeerSyncActivity(f.client.db, [peer]).get(peer);
		f.client.db
			.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = ?")
			.run(JSON.stringify(["http://127.0.0.1:19001"]), peer);
		const requestExecutor = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
		const direct = await runSyncPass(f.client.db, peer, { ...f.options, requestExecutor });
		const directHealth = readPeerSyncHealth(f.client, [peer]).get(peer);
		expect(direct).toMatchObject({ ok: false, failureCategory: "connectivity" });
		expect(readPeerSyncActivity(f.client.db, [peer]).get(peer)).toEqual(before);

		const key = loadPrivateKey(f.remote.peerKeysDir);
		if (!key) throw new Error("Missing fixture key");
		const relay = createRelayPeerClient({
			enabled: false,
			url: "wss://relay.invalid/v1/relay",
			servicePublicKey: f.remote.localPublicKey,
			deviceId: f.remote.peerDeviceId,
			localIdentity: { key: createPrivateKey(key), expectedPin: f.remote.peerPublicKey },
			authorityId: "authority",
			groupId: "group",
			relayAudienceId: relayAudienceId(
				"wss://relay.invalid",
				relayBodyDigest(parseRelayEd25519PublicKey(f.remote.localPublicKey).wireKey),
			),
			externalPathname: "/v1/relay/admission-check",
			coordinator: { check: vi.fn(async () => null) },
			resolvePeerPin: () => f.remote.localPublicKey,
			validateLocal: () => true,
			onInbound: vi.fn(async () => {}),
		});
		cleanups.push(async () => {
			await relay.close();
		});
		f.factory.open.mockRejectedValue(new Error("Controlled route failure"));
		vi.spyOn(relay, "factory").mockReturnValue({ ...f.factory, failureReason: () => reason });

		const result = await runSyncPass(f.client.db, peer, {
			...f.options,
			requestExecutor,
			reachability: { scopeId: f.options.scopeId, logicalOrigin: f.options.logicalOrigin, relay },
		});
		const relayHealth = readPeerSyncHealth(f.client, [peer]).get(peer);

		expect(result).toMatchObject({
			ok: false,
			transport: "relay",
			error: `scoped channel exchange failed: ${reason}`,
			perScopeResults: [{ relayFailureReason: reason }],
		});
		expect(readPeerSyncActivity(f.client.db, [peer]).get(peer)).toEqual(before);
		expect(relayHealth).toEqual(directHealth);
		expect(relayHealth).toMatchObject({ state: "stale" });
		expect(
			overallSyncHealth([{ pinned: true, sync_health: relayHealth }], { enabled: true }),
		).toMatchObject({ attention_count: 0, stale_count: 1 });
		expect(
			f.client.db
				.prepare(
					"SELECT ok, transport, failure_category, error FROM sync_attempts WHERE peer_device_id = ? ORDER BY id",
				)
				.all(peer),
		).toEqual([
			{ ok: 0, transport: "direct", failure_category: "connectivity", error: expect.any(String) },
			{
				ok: 0,
				transport: "relay",
				failure_category: "other",
				error: `scoped channel exchange failed: ${reason}`,
			},
		]);
		const backoff = f.client.db
			.prepare(
				"SELECT relay_rejections, relay_retry_after FROM sync_peers WHERE peer_device_id = ?",
			)
			.get(peer);
		expect(backoff).toMatchObject({
			relay_rejections: reason === "relay_rejected" ? 1 : 0,
			relay_retry_after: reason === "relay_rejected" ? expect.any(String) : null,
		});
	},
);

it.each(["receive", "send"] as const)(
	"records an established %s failure even when its reason is relay_expired",
	async (direction) => {
		const f = await fixture();
		const peer = f.remote.localDeviceId;
		saveSyncChannelCompletedBoundary(f.client.db, {
			peerDeviceId: peer,
			scopeId: f.options.scopeId,
			boundary: getSyncResetState(f.remote.store.db, f.options.scopeId),
		});
		if (direction === "send") f.seed("client", "outbound");
		f.control.afterDispatch = (request, response) => {
			const method = direction === "send" ? "POST" : "GET";
			if (request.method !== method || new URL(request.url).pathname !== "/v1/ops") return response;
			return { status: 500, bodyBytes: bytes({ error: "controlled_failure" }) };
		};

		const result = await syncScopedChannelOnce({
			...f.options,
			factory: { ...f.factory, failureReason: () => "relay_expired" },
		});

		expect(result).toMatchObject({ ok: false, relayFailureReason: "relay_expired" });
		expect(readPeerSyncActivity(f.client.db, [peer]).get(peer)?.[direction]).toMatchObject({
			errorCode: "exchange_failed",
			lastAttemptAt: expect.any(String),
			lastSuccessAt: null,
		});
		expect(readPeerSyncHealth(f.client, [peer]).get(peer)?.state).toBe("needs_attention");
	},
);

it.each([
	{ rejection: "unauthorized", category: "trust" },
	{ rejection: "missing_scope", category: "scope" },
	{ rejection: "stale_epoch", category: "scope" },
	{ rejection: "protocol", category: "compatibility" },
	{ rejection: "fingerprint", category: "trust" },
	{ rejection: "pin", category: "trust" },
] as const)(
	"keeps relay $rejection negotiation failures actionable without a directional error",
	async ({ rejection, category }) => {
		const f = await fixture();
		const peer = f.remote.localDeviceId;
		const before = readPeerSyncActivity(f.client.db, [peer]).get(peer);
		f.control.wrongPin = rejection === "pin";
		f.control.afterDispatch = (request, response) => {
			if (new URL(request.url).pathname !== "/v1/status") return response;
			if (rejection === "unauthorized")
				return { status: 401, bodyBytes: bytes({ error: "unauthorized" }) };
			if (rejection === "missing_scope" || rejection === "stale_epoch")
				return {
					status: 409,
					bodyBytes: bytes({ error: "reset_required", reset_required: true, reason: rejection }),
				};
			const payload = JSON.parse(Buffer.from(response.bodyBytes).toString());
			if (rejection === "protocol") payload.protocol_version = "3";
			if (rejection === "fingerprint") payload.fingerprint = "unexpected";
			return { ...response, bodyBytes: bytes(payload) };
		};

		const result = await syncScopedChannelOnce(f.options);
		recordSyncAttempt(f.client.db, peer, { ...result, transport: "relay" });
		const health = readPeerSyncHealth(f.client, [peer]).get(peer);

		expect(result).toMatchObject({
			ok: false,
			error: "scoped channel exchange failed",
			failureCategory: category,
		});
		expect(readPeerSyncActivity(f.client.db, [peer]).get(peer)).toEqual(before);
		expect(health).toMatchObject({
			state: "needs_attention",
			send: { state: "not_verified" },
			receive: { state: "not_verified" },
		});
		expect(
			f.client.db
				.prepare("SELECT failure_category, error FROM sync_attempts WHERE peer_device_id = ?")
				.get(peer),
		).toEqual({ failure_category: category, error: result.error });
	},
);

it("retains a trust failure from the real relay Noise handshake before a connection opens", async () => {
	const f = await fixture();
	const peer = f.remote.localDeviceId;
	const sourceKey = loadPrivateKey(f.remote.peerKeysDir);
	const targetKey = loadPrivateKey(join(dirname(f.remote.peerKeysDir), "local-keys"));
	if (!sourceKey || !targetKey) throw new Error("Missing fixture key");
	const relay = await relayClientFixture(
		{
			source: { key: createPrivateKey(sourceKey), expectedPin: f.remote.peerPublicKey },
			target: { key: createPrivateKey(targetKey), expectedPin: f.remote.localPublicKey },
		},
		{ source: f.remote.peerDeviceId, target: peer },
	);
	cleanups.push(() => relay.dispose());
	const inbound = vi.fn(async () => {});
	await relay
		.client("target", { onInbound: inbound })
		.connect(new AbortController().signal, relayDeadline());
	const accept = relayNoise.acceptRelayNoiseResponder;
	vi.spyOn(relayNoise, "acceptRelayNoiseResponder").mockImplementation((options) =>
		accept({ ...options, localIdentity: disposableIdentity(7) }),
	);
	const factory = relay.client("source").factory(peer, f.remote.localPublicKey);
	const before = readPeerSyncActivity(f.client.db, [peer]).get(peer);

	const result = await syncScopedChannelOnce({ ...f.options, factory });
	recordSyncAttempt(f.client.db, peer, { ...result, transport: "relay" });

	expect(result).toMatchObject({
		ok: false,
		failureCategory: "trust",
		relayFailureReason: "relay_handshake_failed",
	});
	expect(inbound).not.toHaveBeenCalled();
	expect(readPeerSyncActivity(f.client.db, [peer]).get(peer)).toEqual(before);
	expect(readPeerSyncHealth(f.client, [peer]).get(peer)?.state).toBe("needs_attention");
}, 15000);

it.each(["apply_failed", "scope_rejected"] as const)(
	"records %s from the actual failed pull result",
	async (errorCode) => {
		// Arrange: the channel accepts the envelope, then the real receive path rejects its payload.
		const f = await fixture();
		const peer = f.remote.localDeviceId;
		saveSyncChannelCompletedBoundary(f.client.db, {
			peerDeviceId: peer,
			scopeId: f.options.scopeId,
			boundary: getSyncResetState(f.remote.store.db, f.options.scopeId),
		});
		const op = f.seed("remote", "failed-inbound");
		op.payload_json = JSON.stringify(
			errorCode === "apply_failed"
				? "not-an-object"
				: { ...JSON.parse(op.payload_json), scope_id: "ungranted-scope" },
		);
		f.control.afterDispatch = (request, response) => {
			if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/ops") return response;
			const payload = JSON.parse(Buffer.from(response.bodyBytes).toString());
			return { ...response, bodyBytes: bytes({ ...payload, ops: [op] }) };
		};
		// Act.
		const result = await syncScopedChannelOnce(f.options);
		// Assert: returned failures must retain their specific receive diagnosis.
		expect(result).toMatchObject({
			ok: false,
			error: "channel pull failed",
			failureCategory: errorCode === "scope_rejected" ? "scope" : "other",
		});
		if (errorCode === "apply_failed") expect(result.receiveFailureCode).toBe("apply_failed");
		expect(readPeerSyncActivity(f.client.db, [peer]).get(peer)?.receive).toMatchObject({
			errorCode,
			lastAttemptAt: expect.any(String),
			lastSuccessAt: null,
		});
		expect(f.requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
			["GET", "/v1/status"],
			["GET", "/v1/ops"],
		]);
	},
);

it.each([
	{ errorCode: "exchange_failed", source: "initiated", expected: null },
	{ errorCode: "apply_failed", source: "initiated", expected: "apply_failed" },
	{ errorCode: "scope_rejected", source: "initiated", expected: "scope_rejected" },
	{ errorCode: "exchange_failed", source: "inbound", expected: "exchange_failed" },
	{ errorCode: "apply_failed", source: "inbound", expected: "apply_failed" },
	{ errorCode: "scope_rejected", source: "inbound", expected: "scope_rejected" },
] as const)(
	"actual scoped success preserves $source $errorCode according to source and scope",
	async ({ errorCode, source, expected }) => {
		// Arrange: real signed exchanges use an in-memory Noise connection, without network calls.
		const f = await fixture();
		const peer = f.remote.localDeviceId;
		recordSyncTransferObservation(f.client.db, peer, "receive", { errorCode, source });
		// Act.
		const result = await syncScopedChannelOnce(f.options);
		// Assert: success resolves only a generic initiated error, leaving other work unresolved.
		expect(result.ok).toBe(true);
		expect(readPeerSyncActivity(f.client.db, [peer]).get(peer)?.receive).toMatchObject({
			errorCode: expected,
			lastSuccessAt: expect.any(String),
		});
	},
);
