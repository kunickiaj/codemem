import { afterEach, describe, expect, it, vi } from "vitest";
import * as proof from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { confirmationScope as scope } from "./coordinator-device-rejoin-confirmation-test-harness.js";
import { signedFinalize } from "./coordinator-device-rejoin-finalize-test-harness.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const path = `/v1/auth/rejoin-attempts/${scope.attemptId}/finalize`;
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
	const requestVerifier = vi.fn(() => {
		throw new Error("Enrolled admission must not run");
	});
	const limiter = createInMemoryRequestRateLimiter({ now: Date.now });
	const rate = vi.fn(limiter.check.bind(limiter));
	const clientKey = vi.fn<() => string | null>(() => "fixture-a");
	const app = createCoordinatorApp({
		storeFactory,
		requestVerifier,
		runtime: { adminSecret: () => null, now: () => new Date(Date.now()).toISOString() },
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
	return { db, clock, readRejoin, requestVerifier, rate, clientKey, storeFactory, body, send };
}

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
