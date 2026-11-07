import { afterEach, expect, it, vi } from "vitest";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import {
	getSyncChannelProgress,
	saveSyncChannelCompletedBoundary,
} from "../../core/src/sync-channel-progress.js";
import { getSyncResetState } from "../../core/src/sync-replication.js";
import {
	readPeerSyncActivity,
	recordSyncTransferObservation,
} from "../../core/src/sync-transfer-activity.js";
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
		`records a failed receive after ${failure} failure without replacing prior %s`,
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
			// Assert: a final failure remains visible even when the pull returns a failed result.
			expect(result).toMatchObject({
				ok: false,
				error: failure === "pull" ? "channel pull failed" : "scoped channel exchange failed",
			});
			expect(readPeerSyncActivity(f.client.db, [peer]).get(peer)).toMatchObject({
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
