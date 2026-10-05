import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CreateCoordinatorAppOptions, createCoordinatorApp } from "./coordinator-api.js";
import { materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { cfg, NOW, TABLES } from "./coordinator-auth-link-test-fixtures.js";
import { type Fixture, review, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { buildCanonicalRequest, SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const ROOT = "/v1/auth/link-attempts";
const config = { ...cfg, redirectUri: "https://coordinator.example.test/auth/callback" };
const runtimeProof = Buffer.alloc(32, 17).toString("base64url");
const completion = Buffer.alloc(32, 29).toString("base64url");
const hash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
function identity(deviceId = "device-a") {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(4 + kind.length + 4 + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return {
		deviceId,
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		privateKey: keys.privateKey,
	};
}
type Identity = ReturnType<typeof identity>;
function headers(
	key: Identity,
	method: string,
	path: string,
	body = "",
	timestamp = String(NOW / 1000),
) {
	const nonce = randomBytes(16).toString("hex");
	const signature = sign(
		null,
		buildCanonicalRequest(method, path, timestamp, nonce, Buffer.from(body)),
		key.privateKey,
	);
	return {
		"content-type": "application/json",
		"X-Opencode-Device": key.deviceId,
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": nonce,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
	};
}
function createBody(overrides: Record<string, unknown> = {}) {
	return {
		group_id: "group-a",
		attempt_id: "attempt-a",
		runtime_verifier_hash: hash(runtimeProof),
		browser_start_hash: "c".repeat(64),
		loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
		...overrides,
	};
}
function finalBody(key: Identity, overrides: Record<string, unknown> = {}) {
	return {
		purpose: "coordinator-account-link-v1",
		coordinator_id: config.coordinatorId,
		attempt_id: "attempt-a",
		group_id: "group-a",
		identity_id: "identity-a",
		device_id: key.deviceId,
		fingerprint: key.fingerprint,
		runtime_verifier: runtimeProof,
		completion,
		...overrides,
	};
}
function snapshot(f: Fixture, except: readonly string[] = []) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(({ name }) => name !== "request_nonces" && !except.includes(name))
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function rows(f: Fixture, table: string) {
	return f.db.prepare(`SELECT * FROM "${table}"`).all();
}
function expectPrivate(text: string) {
	for (const value of [
		runtimeProof,
		completion,
		hash(runtimeProof),
		hash(completion),
		"c".repeat(64),
		"subject-private",
		"pkce_verifier",
		"public_key",
		"browser_start",
		"set-cookie",
	])
		expect(text).not.toContain(value);
}
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = it.extend<{
		f: Fixture;
		key: Identity;
		app: ReturnType<typeof createCoordinatorApp>;
	}>({
		f: async ({ task: _task }, use) => {
			const f = setupStore(backend, { authClock: () => NOW });
			// HTTP closes adapters; keep this isolated in-memory database readable for assertions.
			vi.spyOn(f.store, "close").mockResolvedValue(undefined);
			try {
				await use(f);
			} finally {
				if (f.db.open) f.db.close();
			}
		},
		key: async ({ f }, use) => {
			const key = identity();
			await f.store.createGroup("group-a");
			await f.store.enrollDevice("group-a", key);
			await use(key);
		},
		app: async ({ f, key: _key }, use) => {
			await use(makeApp(f));
		},
	});
	function makeApp(f: Fixture, extra: Partial<CreateCoordinatorAppOptions> = {}) {
		return createCoordinatorApp({
			storeFactory: () => f.store,
			runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
			requestVerifier: async (input) =>
				verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
			authLink: { config, storeFactory: () => f.store },
			...extra,
		});
	}
	async function authorize(f: Fixture, key: Identity) {
		expect((await f.store.createAuthControllerAttestation(review(key))).kind).toBe("created");
	}
	function request(
		app: ReturnType<typeof createCoordinatorApp>,
		key: Identity,
		path = ROOT,
		value: unknown = createBody(),
		method = "POST",
	) {
		const body = method === "GET" ? "" : JSON.stringify(value);
		return app.request(`https://coordinator.example.test${path}`, {
			method,
			headers: headers(key, method, path, body),
			...(method === "GET" ? {} : { body }),
		});
	}
	async function seed(
		f: Fixture,
		key: Identity,
		app: ReturnType<typeof createCoordinatorApp>,
		stage = "confirmed",
	) {
		await authorize(f, key);
		expect((await request(app, key)).status).toBe(201);
		if (stage === "pending") return;
		const input = {
			...materials(),
			purpose: "link" as const,
			attemptId: "attempt-a",
			browserStartHash: "c".repeat(64),
		};
		expect((await f.store.startAuthBrowserTransaction(input, config)).kind).toBe("started");
		if (stage === "browser_claimed") return;
		const consumed = await f.store.consumeAuthBrowserTransaction(input, config);
		expect(consumed.kind).toBe("consumed");
		if (consumed.kind !== "consumed") throw new Error("fixture consume failed");
		const browser = {
			attemptId: "attempt-a",
			browserTransactionHash: consumed.browserTransactionHash,
		};
		expect(
			(
				await f.store.recordAuthLinkOidcVerified(
					{ ...browser, account: { issuer: config.issuer, subject: "subject-private" } },
					config,
				)
			).kind,
		).toBe("applied");
		if (stage === "oidc_verified") return;
		expect(
			(
				await f.store.confirmAuthLinkAttempt(
					{ ...browser, completionSecretHash: hash(completion) },
					config,
				)
			).kind,
		).toBe("applied");
	}

	describe(`${backend} signed link creation`, () => {
		test.for(["absent", "disabled"])(
			"%s option exposes no routes or store",
			async (mode, { f, key }) => {
				// Arrange
				const storeFactory = vi.fn(() => f.store);
				const requestVerifier = vi.fn(async () => false);
				const app = makeApp(f, {
					storeFactory,
					requestVerifier,
					authLink:
						mode === "absent" ? undefined : { config: { ...config, enabled: false }, storeFactory },
				});
				// Act
				const responses = await Promise.all([
					request(app, key),
					request(app, key, `${ROOT}/attempt-a?group_id=group-a`, undefined, "GET"),
					request(app, key, `${ROOT}/attempt-a/finalize`, finalBody(key)),
					request(app, key, `${ROOT}/attempt-a/cancel`, { group_id: "group-a" }),
				]);
				// Assert
				expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
				expect(storeFactory).not.toHaveBeenCalled();
				expect(requestVerifier).not.toHaveBeenCalled();
			},
		);
		test("key possession alone cannot nominate controller authority", async ({ f, key, app }) => {
			// Arrange
			const before = snapshot(f);
			// Act
			const response = await request(app, key);
			// Assert
			expect(response.status).toBe(403);
			expectPrivate(await response.text());
			expect(snapshot(f)).toEqual(before);
			expect(f.store.close).toHaveBeenCalledOnce();
		});
		test.for([
			"http://127.0.0.1:80/codemem/auth/complete",
			"http://[::1]:80/codemem/auth/complete",
		])(
			"creates and retries with literal redirect %s unchanged",
			async (redirect, { f, key, app }) => {
				// Arrange
				await authorize(f, key);
				const before = snapshot(f, TABLES);
				const input = createBody({ loopback_redirect: redirect });
				// Act
				const created = await request(app, key, ROOT, input);
				const retry = await request(app, key, ROOT, input);
				const payload = await created.json();
				// Assert
				expect(created.status).toBe(201);
				expect(created.headers.get("set-cookie")).toBeNull();
				expect(retry.status).toBe(200);
				expect(payload).toEqual({
					status: { attemptId: "attempt-a", state: "pending", expiresAtMs: NOW + 600000 },
					identity_id: "identity-a",
					coordinator_id: config.coordinatorId,
				});
				expect(await retry.json()).toEqual(payload);
				expectPrivate(JSON.stringify(payload));
				expect(rows(f, TABLES[0])[0]).toMatchObject({
					loopback_redirect: redirect,
					public_key: key.publicKey,
					fingerprint: key.fingerprint,
				});
				expect(snapshot(f, TABLES)).toEqual(before);
			},
		);
		test.for([
			"omitted",
			"null",
			"bad",
			"signer",
			"public_key",
			"device_id",
			"identity_id",
			"hostname",
			"userinfo",
			"query",
			"path",
		])("strict create rejects %s before store mutation", async (variant, { f, key, app }) => {
			// Arrange
			await authorize(f, key);
			const input: Record<string, unknown> = createBody();
			if (variant === "omitted") delete input.browser_start_hash;
			else if (variant === "null") input.browser_start_hash = null;
			else if (variant === "bad") input.browser_start_hash = "g".repeat(64);
			else if (["signer", "public_key", "device_id", "identity_id"].includes(variant))
				input[variant] = "spoofed";
			else
				input.loopback_redirect = {
					hostname: "http://localhost:80/codemem/auth/complete",
					userinfo: "http://user@127.0.0.1:80/codemem/auth/complete",
					query: "http://127.0.0.1:80/codemem/auth/complete?x=1",
					path: "http://127.0.0.1:80/other",
				}[variant];
			const create = vi.spyOn(f.store, "createAuthLinkAttempt");
			const before = snapshot(f);
			// Act
			const response = await request(app, key, ROOT, input);
			// Assert
			expect(response.status).toBe(400);
			expect(create).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual(before);
		});
	});
	describe(`${backend} signed link status and signatures`, () => {
		test("signed status binds its exact query and hides another enrolled device like a missing attempt", async ({
			f,
			key,
			app,
		}) => {
			// Arrange
			await seed(f, key, app, "pending");
			const other = identity("other-device");
			await f.store.enrollDevice("group-a", other);
			const path = `${ROOT}/attempt-a?group_id=group-a`;
			const before = snapshot(f);
			// Act
			const own = await request(app, key, path, undefined, "GET");
			const foreign = await request(app, other, path, undefined, "GET");
			const missing = await request(
				app,
				other,
				`${ROOT}/missing?group_id=group-a`,
				undefined,
				"GET",
			);
			// Assert
			expect(own.status).toBe(200);
			expectPrivate(await own.text());
			expect(foreign.status).toBe(404);
			expect(missing.status).toBe(404);
			expect(await foreign.text()).toBe(await missing.text());
			expect(snapshot(f)).toEqual(before);
		});
		test.for([
			"",
			"?group_id=group-a&group_id=group-a",
			"?group_id=group-a&extra=x",
			"?other=group-a",
		])("status rejects non-single group query %s", async (query, { f, key, app }) => {
			// Arrange
			const read = vi.spyOn(f.store, "getAuthLinkAttemptStatus");
			// Act
			const response = await request(app, key, `${ROOT}/attempt-a${query}`, undefined, "GET");
			// Assert
			expect(response.status).toBe(400);
			expect(read).not.toHaveBeenCalled();
		});
		test("status nonce replay cannot read protected status again", async ({ f, key, app }) => {
			// Arrange
			await seed(f, key, app, "pending");
			const path = `${ROOT}/attempt-a?group_id=group-a`;
			const init = { method: "GET", headers: headers(key, "GET", path) };
			const read = vi.spyOn(f.store, "getAuthLinkAttemptStatus");
			// Act
			const first = await app.request(path, init);
			const before = snapshot(f);
			const replay = await app.request(path, init);
			// Assert
			expect(first.status).toBe(200);
			expect(replay.status).toBe(401);
			expect(read).toHaveBeenCalledOnce();
			expect(snapshot(f)).toEqual(before);
		});
	});
	describe(`${backend} signed link authorization`, () => {
		test.for(["other-group", "removed", "disabled"])(
			"status denies %s enrollment without reading account metadata",
			async (variant, { f, key, app }) => {
				// Arrange
				await seed(f, key, app, "pending");
				if (variant === "removed") await f.store.removeDevice("group-a", key.deviceId);
				if (variant === "disabled") await f.store.setDeviceEnabled("group-a", key.deviceId, false);
				const group = variant === "other-group" ? "other-group" : "group-a";
				const before = snapshot(f);
				const read = vi.spyOn(f.store, "getAuthLinkAttemptStatus");
				// Act
				const response = await request(
					app,
					key,
					`${ROOT}/attempt-a?group_id=${group}`,
					undefined,
					"GET",
				);
				// Assert
				expect(response.status).toBe(variant === "disabled" ? 403 : 401);
				expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
				expect(read).not.toHaveBeenCalled();
				expect(snapshot(f)).toEqual(before);
			},
		);
		test.for(["body", "path", "method", "timestamp", "stale", "signature", "stored-key"])(
			"signature denial for %s never reaches link store",
			async (variant, { f, key, app }) => {
				// Arrange
				await authorize(f, key);
				const body = JSON.stringify(createBody());
				const signed = headers(
					key,
					variant === "method" ? "GET" : "POST",
					variant === "path" ? `${ROOT}?changed=1` : ROOT,
					body,
					variant === "stale" ? String(NOW / 1000 - 10000) : undefined,
				);
				if (variant === "signature")
					signed["X-Opencode-Signature"] =
						`${SIGNATURE_VERSION}:${Buffer.alloc(64).toString("base64")}`;
				if (variant === "timestamp") signed["X-Opencode-Timestamp"] = String(NOW / 1000 + 1);
				if (variant === "stored-key") await f.store.enrollDevice("group-a", identity());
				const before = snapshot(f);
				const create = vi.spyOn(f.store, "createAuthLinkAttempt");
				// Act
				const response = await app.request(ROOT, {
					method: "POST",
					headers: signed,
					body: variant === "body" ? `${body} ` : body,
				});
				// Assert
				expect(response.status).toBe(401);
				expectPrivate(await response.text());
				expect(create).not.toHaveBeenCalled();
				expect(snapshot(f)).toEqual(before);
			},
		);
	});
	describe(`${backend} signed link finalization`, () => {
		test.for(["pending", "browser_claimed", "oidc_verified"])(
			"signed device cannot finalize %s browser state",
			async (stage, { f, key, app }) => {
				// Arrange
				await seed(f, key, app, stage);
				const before = snapshot(f);
				// Act
				const response = await request(app, key, `${ROOT}/attempt-a/finalize`, finalBody(key));
				// Assert
				expect(response.status).toBe(403);
				expect(snapshot(f)).toEqual(before);
			},
		);
		test("confirmed signed finalization hashes decoded bytes, retries once, and never grants access", async ({
			f,
			key,
			app,
		}) => {
			// Arrange
			await seed(f, key, app);
			const protectedBefore = snapshot(f, TABLES);
			const path = `${ROOT}/attempt-a/finalize`;
			const body = JSON.stringify(finalBody(key));
			const init = { method: "POST", body, headers: headers(key, "POST", path, body) };
			// Act
			const applied = await app.request(path, init);
			const replay = await app.request(path, init);
			const retry = await request(app, key, path, finalBody(key));
			// Assert
			expect(applied.status).toBe(200);
			expect(applied.headers.get("set-cookie")).toBeNull();
			expect(replay.status).toBe(401);
			expect(retry.status).toBe(200);
			expect(await applied.json()).toEqual({
				status: { attemptId: "attempt-a", state: "finalized", expiresAtMs: NOW + 600000 },
			});
			expectPrivate(await retry.text());
			expect(rows(f, TABLES[1])).toHaveLength(1);
			expect(rows(f, TABLES[2])).toHaveLength(1);
			expect(snapshot(f, TABLES)).toEqual(protectedBefore);
		});
		test.for([
			"padding",
			"unused-bits",
			"short",
			"long",
			"alphabet",
			"runtime_verifier_hash",
			"completion_secret_hash",
			"purpose",
			"attempt_id",
			"coordinator_id",
		])(
			"finalize rejects invalid %s before invoking persistence",
			async (variant, { f, key, app }) => {
				// Arrange
				await seed(f, key, app);
				const input: Record<string, unknown> = finalBody(key);
				if (variant === "padding") input.runtime_verifier = `${runtimeProof}=`;
				else if (variant === "unused-bits") input.completion = `${completion.slice(0, -1)}1`;
				else if (variant === "short") input.runtime_verifier = runtimeProof.slice(1);
				else if (variant === "long") input.completion = `${completion}A`;
				else if (variant === "alphabet") input.runtime_verifier = "/".repeat(43);
				else input[variant] = "forged";
				const finalize = vi.spyOn(f.store, "finalizeAuthLinkAttempt");
				const before = snapshot(f);
				// Act
				const response = await request(app, key, `${ROOT}/attempt-a/finalize`, input);
				// Assert
				expect(response.status).toBe(400);
				expect(finalize).not.toHaveBeenCalled();
				expect(snapshot(f)).toEqual(before);
			},
		);
		test.for([
			"runtime_verifier",
			"completion",
			"device_id",
			"fingerprint",
			"identity_id",
			"revoked",
		])(
			"confirmed finalization rejects wrong %s without consuming proof",
			async (variant, { f, key, app }) => {
				// Arrange
				await seed(f, key, app);
				let wrong = "other";
				if (variant === "fingerprint") wrong = "e".repeat(64);
				if (variant === "runtime_verifier" || variant === "completion")
					wrong = Buffer.alloc(32, 99).toString("base64url");
				const input = finalBody(key, variant === "revoked" ? {} : { [variant]: wrong });
				if (variant === "revoked")
					await f.store.revokeAuthControllerAttestation(
						config.coordinatorId,
						review().attestationId,
					);
				const before = snapshot(f);
				// Act
				const response = await request(app, key, `${ROOT}/attempt-a/finalize`, input);
				// Assert
				expect(response.status).toBe(403);
				expectPrivate(await response.text());
				expect(snapshot(f)).toEqual(before);
			},
		);
	});
	describe(`${backend} signed link cancellation`, () => {
		test("cancel erases only this attempt's pending browser credentials", async ({
			f,
			key,
			app,
		}) => {
			// Arrange
			await seed(f, key, app, "browser_claimed");
			expect((await f.store.startAuthBrowserTransaction(materials(2), config)).kind).toBe(
				"started",
			);
			expect(
				(
					await request(
						app,
						key,
						ROOT,
						createBody({
							attempt_id: "other-attempt",
							runtime_verifier_hash: "d".repeat(64),
							browser_start_hash: "e".repeat(64),
						}),
					)
				).status,
			).toBe(201);
			expect(
				(
					await f.store.startAuthBrowserTransaction(
						{
							...materials(3),
							purpose: "link",
							attemptId: "other-attempt",
							browserStartHash: "e".repeat(64),
						},
						config,
					)
				).kind,
			).toBe("started");
			const before = snapshot(f, [TABLES[0], "coordinator_auth_browser_transactions"]);
			const otherRows = f.db
				.prepare(
					"SELECT * FROM coordinator_auth_browser_transactions WHERE attempt_id IS NULL OR attempt_id <> 'attempt-a'",
				)
				.all();
			const retire = vi.spyOn(f.store, "retireAuthBrowserTransactions");
			// Act
			const response = await request(app, key, `${ROOT}/attempt-a/cancel`, { group_id: "group-a" });
			// Assert
			expect(response.status).toBe(200);
			expectPrivate(await response.text());
			expect(retire).toHaveBeenCalledWith(config, { attemptId: "attempt-a" });
			expect(
				f.db
					.prepare(
						"SELECT state, nonce, pkce_verifier FROM coordinator_auth_browser_transactions WHERE attempt_id = 'attempt-a'",
					)
					.get(),
			).toEqual({ state: "expired", nonce: null, pkce_verifier: null });
			expect(
				f.db
					.prepare(
						"SELECT * FROM coordinator_auth_browser_transactions WHERE attempt_id IS NULL OR attempt_id <> 'attempt-a'",
					)
					.all(),
			).toEqual(otherRows);
			expect(snapshot(f, [TABLES[0], "coordinator_auth_browser_transactions"])).toEqual(before);
		});
		test.for(["other-device", "changed-config", "finalized", "extra-field"])(
			"cancel denies %s without cleanup",
			async (variant, { f, key, app }) => {
				// Arrange
				await seed(f, key, app, variant === "finalized" ? "confirmed" : "browser_claimed");
				if (variant === "finalized")
					await request(app, key, `${ROOT}/attempt-a/finalize`, finalBody(key));
				const other = identity("other-device");
				await f.store.enrollDevice("group-a", other);
				const targetApp =
					variant === "changed-config"
						? makeApp(f, {
								authLink: {
									config: { ...config, revision: "f".repeat(64) },
									storeFactory: () => f.store,
								},
							})
						: app;
				const before = snapshot(f);
				const retire = vi.spyOn(f.store, "retireAuthBrowserTransactions");
				// Act
				const response = await request(
					targetApp,
					variant === "other-device" ? other : key,
					`${ROOT}/attempt-a/cancel`,
					variant === "extra-field"
						? { group_id: "group-a", device_id: key.deviceId }
						: { group_id: "group-a" },
				);
				// Assert
				expect(response.status).toBe(variant === "extra-field" ? 400 : 403);
				expect(retire).not.toHaveBeenCalled();
				expect(snapshot(f)).toEqual(before);
			},
		);
	});
	describe(`${backend} signed link faults and limits`, () => {
		test("rotating attempt IDs share the anonymous status quota", async ({ f }) => {
			// Arrange
			const app = makeApp(f, { requestRateLimit: { unauthenticatedReadLimit: 1 } });
			const before = snapshot(f);
			// Act: missing signatures cannot evade the action bucket by changing the path.
			const first = await app.request(`${ROOT}/rotating-a?group_id=group-a`);
			const second = await app.request(`${ROOT}/rotating-b?group_id=group-a`);
			// Assert
			expect(first.status).toBe(401);
			expect(second.status).toBe(429);
			expectPrivate(await first.text());
			expectPrivate(await second.text());
			expect(snapshot(f)).toEqual(before);
		});
		test.for(["persist-throw", "retire-throw", "retire-rejected", "retire-more"])(
			"cancel never claims success on %s",
			async (variant, { f, key, app }) => {
				// Arrange
				await seed(f, key, app, "browser_claimed");
				if (variant === "persist-throw")
					vi.spyOn(f.store, "failAuthLinkAttempt").mockRejectedValue(new Error(runtimeProof));
				else if (variant === "retire-throw")
					vi.spyOn(f.store, "retireAuthBrowserTransactions").mockRejectedValue(
						new Error(completion),
					);
				else
					vi.spyOn(f.store, "retireAuthBrowserTransactions").mockResolvedValue(
						variant === "retire-more"
							? { kind: "retired", processedCount: 32, more: true }
							: { kind: "rejected", error: "invalid_input" },
					);
				// Act
				const response = await request(app, key, `${ROOT}/attempt-a/cancel`, {
					group_id: "group-a",
				});
				// Assert
				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
				expect(rows(f, TABLES[0])[0]).toMatchObject({
					state: variant === "persist-throw" ? "browser_claimed" : "failed",
				});
				expect(rows(f, TABLES[1])).toEqual([]);
				expect(rows(f, TABLES[2])).toEqual([]);
			},
		);
		test("rate limits signed devices independently rather than trusting body owners", async ({
			f,
			key,
		}) => {
			// Arrange
			const app = makeApp(f, { requestRateLimit: { mutationLimit: 1, readLimit: 1 } });
			await authorize(f, key);
			const other = identity("other-device");
			await f.store.enrollDevice("group-a", other);
			await f.store.createAuthControllerAttestation(
				review({ ...other, attestationId: "review-other", reviewReceiptId: "receipt-other" }),
			);
			// Act
			const first = await request(app, key);
			const blocked = await request(app, key);
			const independent = await request(
				app,
				other,
				ROOT,
				createBody({
					attempt_id: "other-attempt",
					runtime_verifier_hash: "d".repeat(64),
					browser_start_hash: "e".repeat(64),
				}),
			);
			// Assert
			expect(first.status).toBe(201);
			expect(blocked.status).toBe(429);
			expect(independent.status).toBe(201);
		});
	});
}
