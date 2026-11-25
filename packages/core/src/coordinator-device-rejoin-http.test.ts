import { sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as proof from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { generateDeviceKey } from "../../cloudflare-coordinator-worker/test/device-rejoin-ceremony-fixture.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { confirmationScope as scope } from "./coordinator-device-rejoin-confirmation-test-harness.js";
import { signedFinalize } from "./coordinator-device-rejoin-finalize-test-harness.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { buildCanonicalRequest, SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";

const path = `/v1/auth/rejoin-attempts/${scope.attemptId}/finalize`;
const adminSecret = "rejoin-display-fixture";
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	vi.restoreAllMocks();
});

async function fixture(kind: Backend) {
	const clock = vi.spyOn(Date, "now").mockReturnValue(scope.now);
	const { db, store } = setupStore(kind, { authClock: () => Date.now() });
	closers.push(() => {
		if (db.open) db.close();
	});
	vi.spyOn(store, "close").mockResolvedValue(undefined);
	const readRejoin = vi.spyOn(store, "readDeviceRejoinBackend");
	const input = await signedFinalize({
		proof,
		first: async <T>({ sql, values }: AuthLinkStatement) =>
			(db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: async (sql, ...values) => db.prepare(sql).run(...values),
		changed: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
	});
	const storeFactory = vi.fn(() => store);
	const requestVerifier = vi.fn<Parameters<typeof createCoordinatorApp>[0]["requestVerifier"]>(
		(input) => verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
	);
	const limiter = createInMemoryRequestRateLimiter({ now: Date.now });
	const rate = vi.fn(limiter.check.bind(limiter));
	const clientKey = vi.fn<() => string | null>(() => "fixture-a");
	const app = createCoordinatorApp({
		storeFactory,
		requestVerifier,
		runtime: { adminSecret: () => adminSecret, now: () => new Date(Date.now()).toISOString() },
		requestRateLimit: { limiter: { check: rate }, unauthenticatedMutationLimit: 10 },
		browserAuth: {
			kind: "ready",
			auth: {
				storeConfig: {
					enabled: true,
					coordinatorId: scope.coordinatorId,
					issuer: scope.issuer,
					revision: scope.authConfigRevision,
					redirectUri: scope.redirectUri,
				},
				register: () => {},
			},
			storeFactory,
			clientKey,
		},
	});
	const body = {
		device_id: input.deviceId,
		completion: input.completion,
		signature: input.signature,
	};
	const send = (data: string | object = body, url = `${scope.origin}${path}`) =>
		app.request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof data === "string" ? data : JSON.stringify(data),
		});
	return {
		app,
		store,
		db,
		clock,
		readRejoin,
		requestVerifier,
		rate,
		clientKey,
		storeFactory,
		body,
		send,
	};
}

async function observer(f: Awaited<ReturnType<typeof fixture>>) {
	const key = generateDeviceKey();
	await f.store.enrollDevice("group-a", {
		deviceId: "observer",
		publicKey: key.publicKey,
		fingerprint: key.fingerprint,
	});
	return {
		key,
		get: (peerPath = "/v1/peers?group_id=group-a") => {
			const timestamp = String(Math.floor(Date.now() / 1000));
			const nonce = crypto.randomUUID();
			const canonical = buildCanonicalRequest("GET", peerPath, timestamp, nonce, Buffer.alloc(0));
			return f.app.request(`${scope.origin}${peerPath}`, {
				headers: {
					"x-opencode-device": "observer",
					"x-opencode-timestamp": timestamp,
					"x-opencode-nonce": nonce,
					"x-opencode-signature": `${SIGNATURE_VERSION}:${sign(null, canonical, key.privateKey).toString("base64")}`,
				},
			});
		},
	};
}

it.each(["SQLite", "D1"] as const)(
	"shows a rejoin to signed peers and the operator after eight days (%s)",
	async (kind) => {
		const f = await fixture(kind);
		const viewer = await observer(f);
		expect((await f.send()).status).toBe(200);
		f.clock.mockReturnValue(scope.now + 8 * 86_400_000);

		const admin = await f.app.request(`${scope.origin}/v1/admin/devices?group_id=group-a`, {
			headers: { "x-codemem-coordinator-admin": adminSecret },
		});
		expect(admin.status).toBe(200);
		const body = await admin.json<{ items: { device_id: string; rejoined_at_ms?: number }[] }>();
		expect(body.items.find(({ device_id }) => device_id === "observer")).not.toHaveProperty(
			"rejoined_at_ms",
		);
		expect(body.items.find(({ device_id }) => device_id === "removed")).toMatchObject({
			rejoined_at_ms: scope.now,
		});
		const peer = await viewer.get();
		expect(peer.status).toBe(200);
		expect(await peer.json()).toMatchObject({
			items: [{ device_id: "removed", rejoined_at_ms: scope.now }],
		});
	},
);

it.each(["SQLite", "D1"] as const)(
	"reads durable rejoin events only for the caller's exact ownership binding (%s)",
	async (kind) => {
		const f = await fixture(kind);
		const viewer = await observer(f);
		expect((await f.send()).status).toBe(200);
		f.clock.mockReturnValue(scope.now + 8 * 86_400_000);
		const events = "/v1/auth/rejoin-events?group_id=group-a";
		const empty = { items: [], next_cursor: null };
		const unbound = await viewer.get(events);
		expect(unbound.status).toBe(200);
		expect(await unbound.json()).toEqual(empty);
		f.db
			.prepare(`INSERT INTO coordinator_device_ownership_bindings
			(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
			VALUES ('observer',?,'identity-a',?,'viewer-binding','owner_enrollment','fixture','then')`)
			.run(await ed25519KeyId(viewer.key.publicKey), scope.coordinatorId);
		const read = await viewer.get(events);
		expect(read.status).toBe(200);
		expect(read.headers.get("cache-control")).toBe("no-store");
		expect(await read.json()).toEqual({
			items: [
				{
					event_id: scope.attemptId,
					device_id: "removed",
					group_ids: ["group-a"],
					finalized_at_ms: scope.now,
				},
			],
			next_cursor: scope.attemptId,
		});
		const next = await viewer.get(`${events}&after=${scope.attemptId}`);
		expect(next.status).toBe(200);
		expect(await next.json()).toEqual({ ...empty, next_cursor: scope.attemptId });
		const denied = await f.app.request(`${scope.origin}${events}`);
		expect(denied.status).toBe(401);
	},
);

function rows(db: Awaited<ReturnType<typeof fixture>>["db"]) {
	return [
		"coordinator_device_rejoin_attempts",
		"coordinator_device_rejoin_audit_log",
		"coordinator_device_removals",
		"coordinator_device_ownership_bindings",
		"coordinator_identity_group_grants",
		"enrolled_devices",
		"request_nonces",
	].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

describe.each(["SQLite", "D1"] as const)("device rejoin finalize HTTP (%s)", (kind) => {
	it("finalizes without enrolled admission, then returns the same receipt without writes", async () => {
		const f = await fixture(kind);
		const success = await f.send();
		expect(success.status).toBe(200);
		expect(success.headers.get("Cache-Control")).toBe("no-store");
		const result = await success.json();
		expect(result).toEqual({
			state: "finalized",
			receipt: {
				attempt_id: scope.attemptId,
				device_id: "removed",
				identity_id: "identity-a",
				binding_id: "binding",
				group_ids: ["group-a"],
				lifted_removal_seqs: [1, 2],
				finalized_at_ms: scope.now,
			},
		});
		const before = rows(f.db);
		f.clock.mockReturnValue(scope.now + 600_000);
		const retry = await f.send();
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual({ ...result, state: "prior_commit" });
		const wrongDevice = await f.send({ ...f.body, device_id: "other-device" });
		expect(wrongDevice.status).toBe(403);
		expect(await wrongDevice.json()).toEqual({ error: "device_rejoin_unavailable" });
		expect(rows(f.db)).toEqual(before);
		expect(f.requestVerifier).not.toHaveBeenCalled();
	});

	it("masks invalid proof and missing attempts, and reports a block only after proof", async () => {
		const f = await fixture(kind);
		f.db
			.prepare(`INSERT INTO coordinator_device_revocations
		 (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,
		  evidence_fingerprint,created_at)
		 SELECT 'device_id',device_id,'block',group_id,device_id,public_key,fingerprint,'now'
		 FROM coordinator_device_removals WHERE removal_seq=1`)
			.run();
		const before = rows(f.db);
		for (const response of [
			await f.send({ ...f.body, signature: "invalid" }),
			await f.send(f.body, `${scope.origin}/v1/auth/rejoin-attempts/missing/finalize`),
		]) {
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "device_rejoin_unavailable" });
		}
		const denied = await f.send();
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({ error: "device_rejoin_refused", reason: "blocked" });
		expect(rows(f.db)).toEqual(before);
	});

	it("rejects invalid transport before store reads, and checks schema readiness", async () => {
		const f = await fixture(kind);
		f.rate.mockReturnValueOnce({ allowed: false, retryAfterS: 3 });
		expect((await f.send("not JSON")).status).toBe(429);
		expect((await f.send("X".repeat(4097))).status).toBe(413);
		expect((await f.send({ ...f.body, extra: true })).status).toBe(400);
		expect((await f.send(f.body, `${scope.origin}${path}?x=1`)).status).toBe(400);
		expect((await f.send(f.body, `https://other.example.test${path}`)).status).toBe(403);
		expect(f.storeFactory).not.toHaveBeenCalled();
		f.readRejoin.mockResolvedValueOnce(null);
		expect((await f.send()).status).toBe(404);
		f.readRejoin.mockRejectedValueOnce(new Error("fixture storage unavailable"));
		const unknown = await f.send();
		expect(unknown.status).toBe(503);
		expect(await unknown.json()).toEqual({ error: "device_rejoin_unknown" });
	});

	it("charges anonymous finalize requests only to the caller’s rate budget", async () => {
		const f = await fixture(kind);
		for (let n = 0; n < 10; n++) expect((await f.send("not JSON")).status).toBe(400);
		expect((await f.send()).status).toBe(429);
		expect(f.storeFactory).not.toHaveBeenCalled();

		f.clientKey.mockReturnValueOnce(null);
		const unidentified = await f.send();
		expect(unidentified.status).toBe(403);
		expect(await unidentified.json()).toEqual({ error: "device_rejoin_unavailable" });
		expect(f.storeFactory).not.toHaveBeenCalled();

		f.clientKey.mockReturnValueOnce("fixture-b");
		expect((await f.send()).status).toBe(200);
	});
});
