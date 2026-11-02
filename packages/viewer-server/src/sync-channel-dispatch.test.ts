import * as core from "@codemem/core";
import { fingerprintPublicKey, LOCAL_SYNC_CAPABILITY, type MemoryStore } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { createSyncApp } from "./index.js";
import { createSyncChannelDispatcher, type SyncChannelRequest } from "./sync-channel-dispatch.js";
import {
	bytes,
	channelStore,
	json,
	memoryOp,
	nonceCount,
	ORIGIN,
	SCOPE,
	signedRequest,
	TARGET,
} from "./sync-channel-dispatch-test-fixtures.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
async function fixture(options?: Parameters<typeof channelStore>[0]) {
	const f = await channelStore(options);
	cleanups.push(f.cleanup);
	return { ...f, dispatch: createSyncChannelDispatcher({ storeFactory: f.storeFactory }) };
}

it("serves exact signed query encoding and records one nonce, then rejects replay", async () => {
	// Arrange
	const f = await fixture();
	const request = signedRequest(f);
	// Act
	const first = await f.dispatch(request);
	const replay = await f.dispatch(request);
	// Assert: the private Request binding must survive the mounted Hono route.
	expect(first.status, JSON.stringify(json(first))).toBe(200);
	expect(json(first)).toMatchObject({ scope_id: SCOPE, ops: [] });
	expect(replay.status).toBe(401);
	expect(json(replay)).toEqual({ error: "unauthorized" });
	expect(nonceCount(f)).toBe(1);
});

it("verifies raw POST whitespace and non-ASCII bytes before applying one authorized op", async () => {
	// Arrange
	const f = await fixture();
	const bodyBytes = Buffer.concat([
		Buffer.from(" \t"),
		bytes({
			scope_id: SCOPE,
			sync_capability: LOCAL_SYNC_CAPABILITY,
			ops: [memoryOp(f)],
			note: "héllo 🌲",
		}),
		Buffer.from("\r\n"),
	]);
	const request = signedRequest(f, { method: "POST", target: "/v1/ops", bodyBytes });
	// Act
	const response = await f.dispatch(request);
	// Assert
	expect(response.status).toBe(200);
	expect(json(response)).toMatchObject({ applied: 1, rejected: 0, scope_id: SCOPE });
	expect(
		f.store.db
			.prepare("SELECT title, scope_id FROM memory_items WHERE import_key = ?")
			.get("channel-item"),
	).toMatchObject({ title: "Channel memory", scope_id: SCOPE });
	expect(nonceCount(f)).toBe(1);
});

it("rejects a wrong channel pin before nonce use and ignores a forged pin header", async () => {
	// Arrange
	const f = await fixture();
	const verifyV2 = vi.spyOn(core, "verifySignature");
	const verifyV3 = vi.spyOn(core, "verifyDirectPeerSignature");
	const request = signedRequest(f);
	const wrong = {
		...request,
		peerPin: f.localPublicKey.trim().split(/\s+/).slice(0, 2).join(" "),
		headers: { ...request.headers, "X-Peer-Pin": f.peerPin, peerPin: f.peerPin },
	};
	// Act
	const denied = await f.dispatch(wrong);
	const unused = nonceCount(f);
	const attemptsBeforePinMatch = [verifyV2.mock.calls.length, verifyV3.mock.calls.length];
	const accepted = await f.dispatch(request);
	// Assert
	expect(denied.status).toBe(401);
	expect(json(denied)).toEqual({ error: "unauthorized" });
	expect(unused).toBe(0);
	expect(attemptsBeforePinMatch).toEqual([0, 0]);
	expect(accepted.status).toBe(200);
	expect(nonceCount(f)).toBe(1);
});

it("compares canonical key fields while retaining the fingerprint of the complete stored key text", async () => {
	// Arrange
	const f = await fixture();
	const formatted = `${f.peerPin.replace("ssh-ed25519 ", "ssh-ed25519\t  ")} unverified-comment`;
	f.store.db
		.prepare(
			"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = ?",
		)
		.run(formatted, fingerprintPublicKey(formatted), f.peerDeviceId);
	// Act
	const response = await f.dispatch(signedRequest(f));
	// Assert
	expect(response.status).toBe(200);
	expect(nonceCount(f)).toBe(1);
});

it("reads current peer key and fingerprint after dispatcher creation without consuming denied nonces", async () => {
	// Arrange
	const f = await fixture();
	const request = signedRequest(f);
	const update = f.store.db.prepare(
		"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = ?",
	);
	// Act: a consistent rotated record and an inconsistent fingerprint both deny.
	update.run(f.localPublicKey, fingerprintPublicKey(f.localPublicKey), f.peerDeviceId);
	const rotated = await f.dispatch(request);
	update.run(f.peerPublicKey, "wrong-fingerprint", f.peerDeviceId);
	const inconsistent = await f.dispatch(request);
	const unused = nonceCount(f);
	update.run(f.peerPublicKey, fingerprintPublicKey(f.peerPublicKey), f.peerDeviceId);
	const restored = await f.dispatch(request);
	// Assert
	expect([rotated.status, inconsistent.status, restored.status]).toEqual([401, 401, 200]);
	expect(unused).toBe(0);
	expect(nonceCount(f)).toBe(1);
});

it.each([
	"v2-only",
	"v2-missing-or-invalid",
	"wrong-recipient",
	"query-tamper",
	"body-tamper",
] as const)("denies %s before nonce use, even before sticky v3 adoption", async (mode) => {
	// Arrange
	const f = await fixture();
	let request = signedRequest(f);
	let original: SyncChannelRequest = request;
	if (mode === "wrong-recipient") request = signedRequest(f, { recipientId: "wrong-recipient" });
	if (mode === "body-tamper") {
		original = signedRequest(f, {
			method: "POST",
			target: "/v1/ops",
			bodyBytes: bytes({ scope_id: SCOPE, sync_capability: LOCAL_SYNC_CAPABILITY, ops: [] }),
		});
		request = {
			...original,
			bodyBytes: Buffer.from(`${new TextDecoder().decode(original.bodyBytes)} `),
		};
	}
	if (mode === "query-tamper")
		request = {
			...request,
			target: request.target.replaceAll("%2f", "%2F"),
			url: request.url.replaceAll("%2f", "%2F"),
		};
	const headers = { ...request.headers };
	if (mode === "v2-only") {
		delete headers["X-Codemem-Signature"];
		delete headers["X-Codemem-Recipient"];
	}
	if (mode === "v2-missing-or-invalid") delete headers["X-Opencode-Signature"];
	// Act
	const denied = await f.dispatch({ ...request, headers });
	let invalidV2: number | undefined;
	if (mode === "v2-missing-or-invalid")
		invalidV2 = (
			await f.dispatch({
				...request,
				headers: {
					...request.headers,
					"X-Opencode-Signature": `v2:${Buffer.alloc(64).toString("base64")}`,
				},
			})
		).status;
	const unused = nonceCount(f);
	const accepted = await f.dispatch(original);
	// Assert
	expect(denied.status).toBe(401);
	if (invalidV2 !== undefined) expect(invalidV2).toBe(401);
	expect(unused).toBe(0);
	expect(accepted.status).toBe(200);
	expect(nonceCount(f)).toBe(1);
});

it.each([
	"missing-or-empty-get",
	"missing-post",
	"unsupported-post",
	"ungranted-post",
	"revoked-peer",
	"local-key-mismatch",
	"peer-key-mismatch",
	"stale-epoch",
	"passive-only",
] as const)("rejects scope state %s without reading or applying legacy ops", async (mode) => {
	// Arrange
	const f = await fixture({ passiveOnly: mode === "passive-only" });
	let request = signedRequest(f);
	if (mode === "missing-or-empty-get") request = signedRequest(f, { target: "/v1/ops" });
	if (mode === "missing-post")
		request = signedRequest(f, {
			method: "POST",
			target: "/v1/ops",
			bodyBytes: bytes({ ops: [memoryOp(f)] }),
		});
	if (mode === "unsupported-post")
		request = signedRequest(f, {
			method: "POST",
			target: "/v1/ops",
			bodyBytes: bytes({ scope_id: "not-granted", ops: [memoryOp(f)] }),
		});
	if (mode === "ungranted-post")
		request = signedRequest(f, {
			method: "POST",
			target: "/v1/ops",
			bodyBytes: bytes({
				scope_id: "not-granted",
				sync_capability: LOCAL_SYNC_CAPABILITY,
				ops: [memoryOp(f)],
			}),
		});
	if (mode === "revoked-peer")
		f.store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ?")
			.run(f.peerDeviceId);
	if (mode === "local-key-mismatch")
		await refreshTestScopeRows(f.store.db, {
			[f.localDeviceId]: f.peerPublicKey,
			[f.peerDeviceId]: f.peerPublicKey,
		});
	if (mode === "peer-key-mismatch")
		await refreshTestScopeRows(f.store.db, {
			[f.localDeviceId]: f.localPublicKey,
			[f.peerDeviceId]: f.localPublicKey,
		});
	if (mode === "stale-epoch")
		f.store.db
			.prepare(
				"UPDATE replication_scopes SET membership_epoch = membership_epoch + 1 WHERE scope_id = ?",
			)
			.run(SCOPE);
	const before = f.store.db.prepare("SELECT * FROM replication_ops").all();
	// Act
	const response = await f.dispatch(request);
	let blankStatus: number | undefined;
	if (mode === "missing-or-empty-get")
		blankStatus = (await f.dispatch(signedRequest(f, { target: "/v1/ops?scope_id=" }))).status;
	// Assert
	expect(response.status).toBe(409);
	if (blankStatus !== undefined) expect(blankStatus).toBe(409);
	expect(json(response)).toMatchObject({ error: "reset_required" });
	expect(json(response)).not.toHaveProperty("ops");
	if (mode.startsWith("missing") || mode === "ungranted-post")
		expect(json(response)).toHaveProperty("reason", "missing_scope");
	expect(f.store.db.prepare("SELECT * FROM replication_ops").all()).toEqual(before);
	expect(
		f.store.db.prepare("SELECT 1 FROM memory_items WHERE import_key = 'channel-item'").get(),
	).toBeUndefined();
});

it("keeps construction inert and excludes status, snapshot, bootstrap and local routes before store access", async () => {
	// Arrange
	const storeFactory = vi.fn<() => MemoryStore>(() => {
		throw new Error("Store must remain unopened");
	});
	const dispatch = createSyncChannelDispatcher({ storeFactory });
	const app = createSyncApp({ storeFactory, syncChannelPeerPin: () => "not-used" });
	const base = {
		method: "GET" as const,
		bodyBytes: new Uint8Array(0),
		peerPin: "not-used",
		signal: new AbortController().signal,
		headers: { "X-Codemem-Bootstrap-Grant": "disposable-grant" },
	};
	expect(storeFactory).not.toHaveBeenCalled();
	// Act
	for (const target of ["/v1/status", "/v1/snapshot", "/v1/bootstrap-grants", "/api/sync/peers"]) {
		const response = await dispatch({ ...base, target, url: ORIGIN + target });
		const direct = await app.fetch(new Request(ORIGIN + target, { headers: base.headers }));
		// Assert
		expect(response.status).toBe(404);
		expect(json(response)).toEqual({ error: "not found" });
		expect(direct.status).toBe(404);
		expect(storeFactory).not.toHaveBeenCalled();
	}
});

it.each(["missing", "throws"] as const)(
	"denies a configured reader that %s, while ordinary v2 auth still works without it",
	async (mode) => {
		// Arrange
		const f = await fixture();
		const dto = signedRequest(f);
		const headers = { ...dto.headers };
		delete headers["X-Codemem-Signature"];
		delete headers["X-Codemem-Recipient"];
		const original = new Request(dto.url, { headers });
		const bindings = new WeakMap<Request, string>([[original, f.peerPin]]);
		const reader = vi.fn((request: Request) => {
			if (mode === "throws") throw new Error("private reader failure");
			return bindings.get(request) ?? null;
		});
		const channelApp = createSyncApp({ storeFactory: f.storeFactory, syncChannelPeerPin: reader });
		const ordinaryApp = createSyncApp({ storeFactory: f.storeFactory });
		const clone = original.clone();
		// Act
		const denied = await channelApp.fetch(clone);
		const unused = nonceCount(f);
		const ordinary = await ordinaryApp.fetch(original);
		// Assert
		expect(denied.status).toBe(401);
		expect(await denied.json()).toEqual({ error: "unauthorized" });
		expect(reader).toHaveBeenCalledWith(clone);
		expect(unused).toBe(0);
		expect(ordinary.status).toBe(200);
		expect(nonceCount(f)).toBe(1);
	},
);

it("rejects an aborted direct channel app request before store access or nonce use", async () => {
	// Arrange: bypass the bridge so this exercises the channel middleware's abort check.
	const f = await fixture();
	const dto = signedRequest(f);
	const controller = new AbortController();
	controller.abort();
	const app = createSyncApp({ storeFactory: f.storeFactory, syncChannelPeerPin: () => f.peerPin });
	const request = new Request(dto.url, {
		method: "GET",
		headers: dto.headers,
		signal: controller.signal,
	});
	// Act
	const response = await app.fetch(request);
	// Assert
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: "unauthorized" });
	expect(f.storeFactory).not.toHaveBeenCalled();
	expect(nonceCount(f)).toBe(0);
});

it("rejects normalized targets and nonempty GET bodies without store access or a silent method fallback", async () => {
	// Arrange
	const f = await fixture();
	const request = signedRequest(f);
	const bad = [
		{ ...request, target: "/a/../v1/ops", url: `${ORIGIN}/a/../v1/ops` },
		{ ...request, target: TARGET, url: `${ORIGIN}/v1/ops` },
		{ ...request, target: "//v1/ops", url: `${ORIGIN}//v1/ops` },
		{ ...request, bodyBytes: Buffer.from("body") },
		{ ...request, url: `https://user:pass@peer.invalid${TARGET}` },
		{ ...request, url: `${request.url}#fragment` },
	];
	// Act
	const responses = await Promise.all(bad.map((input) => f.dispatch(input)));
	const invalidMethod = Object.assign({}, request, { method: "PUT" });
	const methodResponse = await f.dispatch(invalidMethod as SyncChannelRequest);
	// Assert
	expect(responses.map((response: { status: number }) => response.status)).toEqual(
		bad.map(() => 400),
	);
	expect(methodResponse.status).toBe(404);
	expect(f.storeFactory).not.toHaveBeenCalled();
});

it("accepts the exact 1 MiB raw POST boundary and rejects one extra byte before store access", async () => {
	// Arrange
	const f = await fixture();
	const prefix = JSON.stringify({
		scope_id: SCOPE,
		sync_capability: LOCAL_SYNC_CAPABILITY,
		ops: [],
	});
	const bodyBytes = Buffer.from(prefix.padEnd(1048576));
	const request = signedRequest(f, { method: "POST", target: "/v1/ops", bodyBytes });
	// Act
	const tooLarge = await f.dispatch({ ...request, bodyBytes: Buffer.alloc(1048577) });
	const unopened = f.storeFactory.mock.calls.length;
	const accepted = await f.dispatch(request);
	// Assert
	expect(tooLarge.status).toBe(413);
	expect(unopened).toBe(0);
	expect(accepted.status).toBe(200);
	expect(nonceCount(f)).toBe(1);
});

it("rejects an already aborted dispatch without reading the store or consuming a nonce", async () => {
	// Arrange
	const f = await fixture();
	const controller = new AbortController();
	controller.abort();
	const request = { ...signedRequest(f), signal: controller.signal };
	// Act / Assert: cancellation rejects instead of returning a success-shaped DTO.
	await expect(f.dispatch(request)).rejects.toBeInstanceOf(Error);
	expect(f.storeFactory).not.toHaveBeenCalled();
	expect(nonceCount(f)).toBe(0);
});

it("cancels response collection above 16 MiB instead of returning an unbounded DTO", async () => {
	// Arrange: retain real route authentication, substituting only its response body stream.
	const f = await fixture();
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			controller.enqueue(new Uint8Array(16777216));
			controller.enqueue(Uint8Array.of(1));
		},
		cancel,
	});
	vi.spyOn(Response.prototype, "body", "get").mockReturnValue(body);
	// Act
	const pending = f.dispatch(signedRequest(f));
	// Assert
	await expect(pending).rejects.toBeInstanceOf(Error);
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(nonceCount(f)).toBe(1);
});

it("collects an exact 16 MiB response without changing its boundary bytes", async () => {
	// Arrange: substitute only the response stream after real scoped authentication.
	const f = await fixture();
	const payload = new Uint8Array(16777216).fill(90);
	payload[0] = 17;
	payload[payload.length - 1] = 239;
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			controller.enqueue(payload);
			controller.close();
		},
		cancel,
	});
	vi.spyOn(Response.prototype, "body", "get").mockReturnValue(body);
	// Act
	const response = await f.dispatch(signedRequest(f));
	// Assert
	expect(response.status).toBe(200);
	expect(response.bodyBytes.byteLength).toBe(16777216);
	expect(response.bodyBytes[0]).toBe(17);
	expect(response.bodyBytes[response.bodyBytes.length - 1]).toBe(239);
	expect(cancel).not.toHaveBeenCalled();
	expect(nonceCount(f)).toBe(1);
});

it("cancels a stalled response read once without retrying the authenticated request", async () => {
	// Arrange: zero high-water mark prevents a pull before the dispatcher starts reading.
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const stalled = Promise.withResolvers<void>();
	const controller = new AbortController();
	const cancel = vi.fn(() => stalled.resolve());
	const body = new ReadableStream<Uint8Array<ArrayBuffer>>(
		{
			pull() {
				entered.resolve();
				return stalled.promise;
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	vi.spyOn(Response.prototype, "body", "get").mockReturnValue(body);
	// Act
	const pending = f.dispatch({ ...signedRequest(f), signal: controller.signal });
	void pending.catch(() => {});
	await entered.promise;
	const storeCallsBeforeAbort = f.storeFactory.mock.calls.length;
	controller.abort();
	// Assert
	await expect(pending).rejects.toBeInstanceOf(Error);
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(nonceCount(f)).toBe(1);
	expect(storeCallsBeforeAbort).toBe(1);
	expect(f.storeFactory).toHaveBeenCalledTimes(storeCallsBeforeAbort);
});
