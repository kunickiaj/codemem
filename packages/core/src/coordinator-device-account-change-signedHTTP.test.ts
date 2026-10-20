import { afterEach, expect, it, vi } from "vitest";
import {
	capabilitiesPath,
	cleanupAccountChangeHttpFixtures,
	completion,
	config,
	createBody,
	fixture,
	h,
	headers,
	keypair,
	NOW,
	ORIGIN,
	ROOT,
	runtimeVerifier,
	statusPins,
} from "./coordinator-account-change-http-test-fixtures.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR } from "./coordinator-auth-link-contract.js";

afterEach(cleanupAccountChangeHttpFixtures);

function privateResponse(response: Response) {
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

for (const intent of ["refresh", "disconnect"] as const) {
	it(`signed ${intent} create/status/finalize and retained exact-proof retry`, async () => {
		const f = await fixture();
		await f.prepare(intent);
		const status = await f.send("GET", f.statusPath());
		privateResponse(status);
		expect(await status.json()).toEqual({
			status: {
				attemptId: "change-a",
				intent,
				state: "confirmed",
				expiresAtMs: NOW + 600000,
				identityId: "identity-a",
			},
		});
		const finalized = await f.send("POST", `${ROOT}/change-a/finalize`, f.finalBody());
		expect(finalized.status).toBe(200);
		privateResponse(finalized);
		const result = await finalized.json();
		expect(result.status.state).toBe("completed");
		const before = f.snapshot();
		f.clock.now += 600001;
		const retry = await f.send("POST", `${ROOT}/change-a/finalize`, f.finalBody());
		expect(await retry.json()).toEqual(result);
		expect(f.snapshot()).toEqual(before);
		expect(
			(
				await f.send(
					"POST",
					`${ROOT}/change-a/finalize`,
					f.finalBody({ completion: Buffer.alloc(32, 30).toString("base64url") }),
				)
			).status,
		).toBe(403);
		expect(f.snapshot()).toEqual(before);
	});
	it(`signed ${intent} expiry after confirmed status rejects finalization without effects`, async () => {
		const f = await fixture();
		await f.prepare(intent);
		expect((await (await f.send("GET", f.statusPath())).json()).status.state).toBe("confirmed");
		f.clock.now += 600001;
		const before = f.snapshot();
		const rejected = await f.send("POST", `${ROOT}/change-a/finalize`, f.finalBody());
		expect(rejected.status).toBe(403);
		expect(await rejected.json()).toEqual({ error: "account_change_unavailable" });
		expect((await f.send("POST", `${ROOT}/change-a/cancel`, statusPins())).status).toBe(403);
		expect(f.snapshot()).toEqual(before);
	});
}
it.each(["device_claim", "controller_attestation"] as const)(
	"signed %s relink reports shared management quota as 429",
	async (authority) => {
		const f = await fixture(authority);
		expect(
			(
				await f.send(
					"POST",
					ROOT,
					createBody({
						attempt_id: "blocking-change",
						intent: "refresh",
						runtime_verifier_hash: h(80),
						browser_start_hash: h(81),
					}),
				)
			).status,
		).toBe(200);
		await f.prepare("disconnect");
		expect((await f.send("POST", `${ROOT}/change-a/finalize`, f.finalBody())).status).toBe(200);
		const app = createCoordinatorApp({
			...f.options,
			authLink: { config: f.config, storeFactory: () => f.store },
		});
		const path = "/v1/auth/link-attempts";
		const create = (attemptId: string) => {
			const body = JSON.stringify({
				group_id: "group-a",
				identity_id: "identity-a",
				authority,
				attempt_id: attemptId,
				runtime_verifier_hash: h(70),
				browser_start_hash: h(71),
				loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
			});
			return app.request(`${ORIGIN}${path}`, {
				method: "POST",
				headers: headers(f.key, "POST", path, body),
				body,
			});
		};
		expect((await create("first-relink")).status).toBe(201);
		const before = f.snapshot();
		const limited = await create("second-relink");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ error: "auth_link_limited" });
		expect(f.snapshot()).toEqual(before);
	},
);

it.each(["device_claim", "controller_attestation"] as const)(
	"signed %s first link respects shared coordinator capacity",
	async (authority) => {
		const f = await fixture();
		expect(
			(await f.send("POST", ROOT, createBody({ attempt_id: "capacity-source", intent: "refresh" })))
				.status,
		).toBe(200);
		// Capacity-only fixture rows retain a real target; they grant no authority to the new device.
		const columns = (
			f.db.prepare("PRAGMA table_info(coordinator_account_change_attempts)").all() as {
				name: string;
			}[]
		).map((c) => c.name);
		const projection = columns
			.map((c) => {
				if (c === "attempt_id") return "'capacity-' || n";
				if (c === "runtime_verifier_hash") return "printf('%064x',10000+n)";
				if (c === "browser_start_hash") return "printf('%064x',20000+n)";
				return c;
			})
			.join(",");
		const collision = f.db
			.prepare("SELECT sql FROM sqlite_master WHERE name='account_change_collision'")
			.get() as { sql: string };
		// Avoid quadratic collision scans only while loading unique fixture rows.
		f.db.exec("DROP TRIGGER account_change_collision");
		f.db.exec(`WITH RECURSIVE capacity(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM capacity WHERE n<${AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR - 1})
 INSERT INTO coordinator_account_change_attempts SELECT ${projection} FROM coordinator_account_change_attempts,capacity WHERE attempt_id='capacity-source'`);
		f.db.exec(collision.sql);
		const fresh = keypair("fresh-device");
		await f.store.enrollDevice("group-a", fresh);
		if (authority === "controller_attestation")
			expect(
				await f.store.createAuthControllerAttestation({
					deviceId: fresh.deviceId,
					publicKey: fresh.publicKey,
					fingerprint: fresh.fingerprint,
					coordinatorId: f.config.coordinatorId,
					groupId: "group-a",
					identityId: "fresh-identity",
					attestationId: "fresh-review",
					reviewReceiptId: "fresh-receipt",
					evidenceDigest: h(90),
				}),
			).toMatchObject({ kind: "created" });
		const app = createCoordinatorApp({
			...f.options,
			authLink: { config: f.config, storeFactory: () => f.store },
		});
		const path = "/v1/auth/link-attempts";
		const body = JSON.stringify({
			group_id: "group-a",
			identity_id: "fresh-identity",
			authority,
			attempt_id: "first-link",
			runtime_verifier_hash: h(91),
			browser_start_hash: h(92),
			loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
		});
		const response = await app.request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: headers(fresh, "POST", path, body),
			body,
		});
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({ error: "auth_link_limited" });
		expect(
			f.db
				.prepare("SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id='first-link'")
				.all(),
		).toEqual([]);
	},
);

it("create pins coordinator/identity; cancel/status redact browser and account secrets", async () => {
	const f = await fixture();
	const created = await f.send("POST", ROOT, createBody());
	expect(await created.json()).toEqual({
		coordinator_id: config.coordinatorId,
		identity_id: "identity-a",
		status: {
			attemptId: "change-a",
			intent: "refresh",
			state: "pending",
			expiresAtMs: NOW + 600000,
			identityId: "identity-a",
		},
	});
	const cancelled = await f.send("POST", `${ROOT}/change-a/cancel`, statusPins());
	expect(cancelled.status).toBe(200);
	privateResponse(cancelled);
	const text = await cancelled.text();
	for (const secret of [
		runtimeVerifier,
		completion,
		"loopback",
		"account-A",
		"nonce",
		"stateHash",
		"profile",
		"publicKey",
	])
		expect(text).not.toContain(secret);
	expect(JSON.parse(text).status.state).toBe("cancelled");
	expect((await f.send("GET", f.statusPath())).status).toBe(200);
});
it("missing signatures, wrong keys, modified raw body/path/method and nonce replay cannot mutate", async () => {
	const f = await fixture();
	const body = JSON.stringify(createBody()),
		valid = headers(f.key, "POST", ROOT, body);
	const before = f.snapshot();
	const cases = [
		{ method: "POST", path: ROOT, body, headers: {} },
		{ method: "POST", path: ROOT, body, headers: headers(keypair(), "POST", ROOT, body) },
		{ method: "POST", path: ROOT, body: `${body} `, headers: valid },
		{
			method: "POST",
			path: ROOT,
			body,
			headers: headers(f.key, "POST", `${ROOT}/elsewhere`, body),
		},
		{ method: "POST", path: ROOT, body, headers: headers(f.key, "GET", ROOT, body) },
	];
	for (const request of cases) {
		const response = await f.app.request(`${ORIGIN}${request.path}`, request);
		expect(response.status).toBeGreaterThanOrEqual(400);
		privateResponse(response);
		expect(f.snapshot()).toEqual(before);
	}
	expect(
		(await f.app.request(`${ORIGIN}${ROOT}`, { method: "POST", headers: valid, body })).status,
	).toBe(200);
	const after = f.snapshot();
	expect(
		(await f.app.request(`${ORIGIN}${ROOT}`, { method: "POST", headers: valid, body })).status,
	).toBe(401);
	expect(f.snapshot()).toEqual(after);
});
it("signed wrong group/identity, modified query, other signer and cancel pins cannot mutate", async () => {
	const f = await fixture();
	expect((await f.send("POST", ROOT, createBody())).status).toBe(200);
	const other = keypair("device-b");
	await f.store.enrollDevice("group-a", other);
	const before = f.snapshot();
	for (const extra of [
		{ identity_id: "identity-b" },
		{ group_id: "group-b" },
		{ runtime_verifier_hash: h(91) },
	]) {
		expect((await f.send("GET", f.statusPath(extra))).status).toBeGreaterThanOrEqual(400);
		expect(
			(await f.send("POST", `${ROOT}/change-a/cancel`, { ...statusPins(), ...extra })).status,
		).toBeGreaterThanOrEqual(400);
	}
	expect((await f.send("GET", f.statusPath(), undefined, other)).status).toBe(403);
	const path = f.statusPath();
	const tampered = await f.app.request(`${ORIGIN}${path.replace("identity-a", "identity-b")}`, {
		headers: headers(f.key, "GET", path),
	});
	expect(tampered.status).toBe(401);
	expect(f.snapshot()).toEqual(before);
});
it("strict fields, bounded JSON, purpose and canonical proofs reject before account changes", async () => {
	const f = await fixture(),
		before = f.snapshot();
	for (const data of [
		createBody({ subject: "account-A" }),
		createBody({ intent: "delete" }),
		createBody({ identity_id: "identity-b" }),
		createBody({ loopback_redirect: "https://elsewhere.test" }),
	]) {
		expect((await f.send("POST", ROOT, data)).status).toBeGreaterThanOrEqual(400);
	}
	for (const body of ["{", "[]", " ".repeat(4097)]) {
		const response = await f.app.request(`${ORIGIN}${ROOT}`, {
			method: "POST",
			body,
			headers: headers(f.key, "POST", ROOT, body),
		});
		expect(response.status).toBe(body.length > 4096 ? 413 : 400);
		privateResponse(response);
	}
	expect(f.snapshot()).toEqual(before);
	await f.prepare("refresh");
	const confirmed = f.snapshot();
	for (const extra of [
		{ purpose: "coordinator-account-link-v1" },
		{ coordinator_id: "other" },
		{ attempt_id: "other" },
		{ device_id: "other" },
		{ fingerprint: h(99) },
		{ runtime_verifier: `${runtimeVerifier}=` },
		{ completion: "bad" },
		{ subject: "account-A" },
	]) {
		expect(
			(await f.send("POST", `${ROOT}/change-a/finalize`, f.finalBody(extra))).status,
		).toBeGreaterThanOrEqual(400);
	}
	expect(f.snapshot()).toEqual(confirmed);
});
it("capability absent/disabled stays unmounted; unsupported schema blocks admitted change routes", async () => {
	const f = await fixture();
	const absent = createCoordinatorApp({ ...f.options, accountChanges: undefined });
	expect((await absent.request(`${ORIGIN}${ROOT}`)).status).toBe(404);
	if (!f.options.accountChanges) throw new Error("missing capability fixture");
	const disabled = createCoordinatorApp({
		...f.options,
		accountChanges: {
			...f.options.accountChanges,
			config: { ...config, enabled: false },
		},
	});
	expect((await disabled.request(`${ORIGIN}${ROOT}`)).status).toBe(404);
	f.db.exec("DROP TRIGGER account_change_birth");
	const before = f.snapshot();
	for (const [method, path, data] of [
		["POST", ROOT, createBody()],
		["GET", `${ROOT}?group_id=group-a&identity_id=identity-a`, undefined],
		["GET", f.statusPath(), undefined],
		["POST", `${ROOT}/change-a/finalize`, f.finalBody()],
		["POST", `${ROOT}/change-a/cancel`, statusPins()],
	] as const) {
		const response = await f.send(method, path, data);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "authentication_unavailable" });
		privateResponse(response);
	}
	expect(f.snapshot()).toEqual(before);
});
it("checks readiness once on the admitted store, never for malformed, invalid, replayed or limited requests", async () => {
	const f = await fixture();
	if (!f.options.accountChanges) throw new Error("missing capability fixture");
	const assertReady = vi.fn(f.options.accountChanges.assertReady);
	const storeFactory = vi.fn(f.options.accountChanges.storeFactory);
	const app = createCoordinatorApp({
		...f.options,
		requestRateLimit: { mutationLimit: 1, unauthenticatedMutationLimit: 10 },
		accountChanges: { ...f.options.accountChanges, assertReady, storeFactory },
	});
	const body = JSON.stringify(createBody());
	const valid = headers(f.key, "POST", ROOT, body);
	const request = (raw: string, signed = valid) =>
		app.request(`${ORIGIN}${ROOT}`, {
			method: "POST",
			body: raw,
			headers: signed,
		});
	expect((await request("{")).status).toBe(400);
	expect(storeFactory).not.toHaveBeenCalled();
	expect((await request(body, headers(keypair(), "POST", ROOT, body))).status).toBe(401);
	expect(assertReady).not.toHaveBeenCalled();
	storeFactory.mockClear();
	vi.mocked(f.store.close).mockClear();
	expect((await request(body)).status).toBe(200);
	expect(assertReady).toHaveBeenCalledExactlyOnceWith(f.store);
	expect(storeFactory).toHaveBeenCalledTimes(1);
	expect(f.store.close).toHaveBeenCalledTimes(1);
	assertReady.mockClear();
	const before = f.snapshot();
	expect((await request(body)).status).toBe(401);
	expect((await request(body, headers(f.key, "POST", ROOT, body))).status).toBe(429);
	expect(assertReady).not.toHaveBeenCalled();
	expect(f.snapshot()).toEqual(before);
});
it("rejects foreign origin, secret/duplicate GET fields and signed unexpected POST query", async () => {
	const f = await fixture();
	expect((await f.send("POST", ROOT, createBody())).status).toBe(200);
	const before = f.snapshot();
	const body = JSON.stringify(createBody());
	const foreign = await f.app.request(`https://foreign.example.test${ROOT}`, {
		method: "POST",
		body,
		headers: headers(f.key, "POST", ROOT, body),
	});
	expect(foreign.status).toBe(403);
	privateResponse(foreign);
	for (const path of [
		`${f.statusPath()}&runtime_verifier=${runtimeVerifier}`,
		`${f.statusPath()}&group_id=group-a`,
		`${ROOT}/change-a?group_id=group-a&group_id=group-a&identity_id=identity-a`,
	])
		expect((await f.send("GET", path)).status).toBe(400);
	expect((await f.send("POST", `${ROOT}?extra=1`, createBody())).status).toBe(400);
	expect(f.snapshot()).toEqual(before);
});
it("uses existing enrollment admission and authenticated mutation limits", async () => {
	const f = await fixture();
	const app = createCoordinatorApp({ ...f.options, requestRateLimit: { mutationLimit: 1 } });
	const body = JSON.stringify(createBody());
	const request = () =>
		app.request(`${ORIGIN}${ROOT}`, {
			method: "POST",
			body,
			headers: headers(f.key, "POST", ROOT, body),
		});
	expect((await request()).status).toBe(200);
	const before = f.snapshot();
	const limited = await request();
	expect(limited.status).toBe(429);
	privateResponse(limited);
	expect(f.snapshot()).toEqual(before);
	f.db.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?").run(f.key.deviceId);
	const disabled = f.snapshot();
	expect((await f.send("POST", `${ROOT}/change-a/cancel`, statusPins())).status).toBe(403);
	expect(f.snapshot()).toEqual(disabled);
});
for (const authority of ["device_claim", "controller_attestation"] as const) {
	it(`returns read-only server capabilities for ${authority} with exact signed query`, async () => {
		const f = await fixture(authority),
			before = f.snapshot();
		expect((await f.app.request(`${ORIGIN}${capabilitiesPath}`)).status).toBe(401);
		expect((await f.send("GET", capabilitiesPath.replace("group-a", "group-b"))).status).toBe(401);
		const response = await f.send("GET", capabilitiesPath);
		privateResponse(response);
		expect(await response.json()).toEqual({
			coordinator_id: config.coordinatorId,
			identity_id: "identity-a",
			unlink_target: expect.any(String),
			actions: { refresh: true, disconnect: true },
		});
		expect(f.snapshot()).toEqual(before);
		for (const suffix of [`&runtime_verifier_hash=${h(8)}`, "&identity_id=identity-a"])
			expect((await f.send("GET", capabilitiesPath + suffix)).status).toBe(400);
		const changed = capabilitiesPath.replace("identity-a", "identity-b");
		expect(
			(
				await f.app.request(`${ORIGIN}${changed}`, {
					headers: headers(f.key, "GET", capabilitiesPath),
				})
			).status,
		).toBe(401);
	});
}
it("capabilities deny shared readers, identity mismatches and revoked accounts without leaking account data", async () => {
	const f = await fixture();
	const other = keypair("device-b");
	await f.store.enrollDevice("group-a", other);
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='device-b'")
		.run();
	const before = f.snapshot();
	for (const [path, key] of [
		[capabilitiesPath, other],
		[capabilitiesPath.replace("identity-a", "identity-b"), f.key],
	] as const) {
		const response = await f.send("GET", path, undefined, key);
		expect(await response.json()).toEqual({
			coordinator_id: config.coordinatorId,
			identity_id: new URL(path, ORIGIN).searchParams.get("identity_id"),
			actions: { refresh: false, disconnect: false },
		});
	}
	expect(f.snapshot()).toEqual(before);
	f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=?").run(NOW);
	const revoked = f.snapshot();
	expect((await (await f.send("GET", capabilitiesPath)).json()).actions).toEqual({
		refresh: false,
		disconnect: false,
	});
	expect(f.snapshot()).toEqual(revoked);
});
it("capabilities deny unlinked accounts and mismatched coordinator config", async () => {
	const f = await fixture();
	if (!f.options.accountChanges) throw new Error("missing capability fixture");
	const app = createCoordinatorApp({
		...f.options,
		accountChanges: {
			...f.options.accountChanges,
			config: { ...config, coordinatorId: "other-coordinator" },
		},
	});
	const before = f.snapshot();
	const response = await app.request(`${ORIGIN}${capabilitiesPath}`, {
		headers: headers(f.key, "GET", capabilitiesPath),
	});
	expect((await response.json()).actions).toEqual({ refresh: false, disconnect: false });
	expect(f.snapshot()).toEqual(before);
	await f.prepare("disconnect");
	expect((await f.send("POST", `${ROOT}/change-a/finalize`, f.finalBody())).status).toBe(200);
	const disconnected = f.snapshot();
	expect((await (await f.send("GET", capabilitiesPath)).json()).actions).toEqual({
		refresh: false,
		disconnect: false,
	});
	expect(f.snapshot()).toEqual(disconnected);
});
it("capabilities fail unavailable rather than falling back when extension tables are absent", async () => {
	const f = await fixture();
	f.db.exec("DROP TABLE coordinator_account_change_attempts");
	const before = f.snapshot();
	const response = await f.send("GET", capabilitiesPath);
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: "authentication_unavailable" });
	privateResponse(response);
	expect(f.snapshot()).toEqual(before);
});
