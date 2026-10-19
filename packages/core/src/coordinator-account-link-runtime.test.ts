import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as receiverRuntime from "./coordinator-account-link-receiver.js";
import {
	CoordinatorAccountLinkError,
	linkCoordinatorAccount,
} from "./coordinator-account-link-runtime.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { cfg, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { review, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema, seedMixedScopeFixture } from "./test-utils.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));

const origin = "https://coordinator.example.test";
const config = { ...cfg, redirectUri: `${origin}/auth/callback` };
const hash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
function localGet(destination: string) {
	if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(destination))
		throw new Error("nonlocal test request");
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = httpRequest(destination, { method: "GET" }, (response) => {
			let body = "";
			response.on("data", (chunk) => {
				body += chunk.toString();
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		req.setTimeout(2000, () => req.destroy(new Error("local request timed out")));
		req.on("error", reject);
		req.end();
	});
}
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

const test = it.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
	f: async ({ task: _task }, use) => {
		const f = await fixture();
		try {
			await use(f);
		} finally {
			f.local.close();
			f.remote.db.close();
			rmSync(f.dir, { recursive: true, force: true });
		}
	},
});
async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "codemem-link-test-"));
	const dbPath = join(dir, "local.sqlite");
	const keysDir = join(dir, "keys");
	mkdirSync(keysDir);
	const local = new Database(dbPath);
	initTestSchema(local);
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(4 + kind.length + 4 + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const fingerprint = fingerprintPublicKey(publicKey);
	writeFileSync(
		join(keysDir, "device.key"),
		keys.privateKey.export({ type: "pkcs8", format: "pem" }),
		{ mode: 0o600 },
	);
	writeFileSync(join(keysDir, "device.key.pub"), publicKey);
	local
		.prepare(
			"INSERT INTO sync_device (device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("device-a", publicKey, fingerprint, new Date(NOW).toISOString());
	seedMixedScopeFixture(local, "device-a");
	local
		.prepare(
			"INSERT INTO actors (actor_id, display_name, is_local, created_at, updated_at) VALUES ('local-identity', 'Local display label', 1, ?, ?)",
		)
		.run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
	const remoteClock = { offsetMs: 0 };
	const remote = setupStore("SQLite", { authClock: () => NOW + remoteClock.offsetMs });
	vi.spyOn(remote.store, "close").mockResolvedValue(undefined);
	await remote.store.createGroup("group-a");
	await remote.store.enrollDevice("group-a", { deviceId: "device-a", publicKey, fingerprint });
	expect(
		(await remote.store.createAuthControllerAttestation(review({ publicKey, fingerprint }))).kind,
	).toBe("created");
	const app = createCoordinatorApp({
		storeFactory: () => remote.store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: async (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		authLink: { config, storeFactory: () => remote.store },
	});
	const calls: Request[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		expect(init?.redirect).toBe("manual");
		const req = new Request(input, init);
		expect(new URL(req.url).origin).toBe(origin);
		if (req.method === "POST" && req.url.endsWith("/v1/auth/link-attempts")) {
			const create = await req.clone().json();
			expect((await localGet(create.loopback_redirect)).status).toBe(400);
		}
		calls.push(req.clone());
		return app.fetch(req);
	});
	const options = {
		dbPath,
		keysDir,
		coordinatorUrl: origin,
		groupId: "group-a",
		fetch,
		expectedIdentityId: "identity-a",
		expectedAuthority: "controller_attestation" as "controller_attestation" | "device_claim",
	};
	return { dir, local, remote, remoteClock, calls, options, fingerprint, publicKey };
}
function localSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
	const tables = f.local
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return {
		rows: tables.map(({ name }) => [name, f.local.prepare(`SELECT * FROM "${name}"`).all()]),
		keys: readdirSync(f.options.keysDir)
			.sort()
			.map((name) => [name, readFileSync(join(f.options.keysDir, name), "utf8")]),
	};
}
async function browser(
	f: Awaited<ReturnType<typeof fixture>>,
	privateUrl: string,
	transaction = 1,
) {
	const url = new URL(privateUrl);
	const row = f.remote.db
		.prepare("SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id = ?")
		.get(url.searchParams.get("attempt_id")) as {
		attempt_id: string;
		browser_start_hash: string;
		runtime_verifier_hash: string;
		loopback_redirect: string;
	};
	expect(url.searchParams.get("attempt_id")).toBe(row.attempt_id);
	const start = url.searchParams.get("start_code") ?? "";
	expect(hash(start)).toBe(row.browser_start_hash);
	const input = {
		...materials(transaction),
		purpose: "link" as const,
		attemptId: row.attempt_id,
		browserStartHash: row.browser_start_hash,
	};
	expect((await f.remote.store.startAuthBrowserTransaction(input, config)).kind).toBe("started");
	const consumed = await f.remote.store.consumeAuthBrowserTransaction(input, config);
	if (consumed.kind !== "consumed") throw new Error("fixture consume failed");
	const claim = {
		attemptId: row.attempt_id,
		browserTransactionHash: consumed.browserTransactionHash,
	};
	expect(
		(
			await f.remote.store.recordAuthLinkOidcVerified(
				{ ...claim, account: { issuer: cfg.issuer, subject: "test-account" } },
				config,
			)
		).kind,
	).toBe("applied");
	const completion = randomBytes(32).toString("base64url");
	expect(completion).not.toBe(start);
	expect(
		(
			await f.remote.store.confirmAuthLinkAttempt(
				{ ...claim, completionSecretHash: hash(completion) },
				config,
			)
		).kind,
	).toBe("applied");
	const response = await localGet(
		`${row.loopback_redirect}?attempt_id=${row.attempt_id}&completion=${completion}`,
	);
	expect(response.status).toBe(200);
	expect(response.body).not.toMatch(/<a\b|http-equiv=["']refresh/i);
	expect(response.body).toContain("Finishing account link");
	expect(response.body).toContain("return to Codemem and check status");
	for (const secret of [start, completion]) expect(response.body).not.toContain(secret);
	return { completion, row, start };
}

test.for(["controller_attestation", "device_claim"] as const)(
	"real signatures and %s authority finalize without local mutations",
	async (authority, { f }) => {
		// Arrange
		f.options.expectedAuthority = authority;
		if (authority === "device_claim")
			f.remote.db.prepare("DELETE FROM coordinator_auth_controller_attestations").run();
		const before = localSnapshot(f);
		const protectedTables = [
			"enrolled_devices",
			"coordinator_auth_controller_attestations",
			"coordinator_bootstrap_grants",
			"coordinator_scope_memberships",
			"coordinator_scopes",
		];
		const protectedBefore = protectedTables.map((name) =>
			f.remote.db.prepare(`SELECT * FROM ${name}`).all(),
		);
		let proofs: Awaited<ReturnType<typeof browser>> | undefined;
		let browserDone: Promise<unknown> = Promise.resolve();
		// Act
		const result = await linkCoordinatorAccount({
			...f.options,
			onBrowserStart: (url) => {
				browserDone = browser(f, url).then((result) => {
					proofs = result;
				});
				void browserDone.catch(() => {});
			},
		});
		await browserDone;
		// Assert
		expect(result).toEqual({
			coordinatorId: cfg.coordinatorId,
			identityId: "identity-a",
			attemptId: proofs?.row.attempt_id,
			state: "finalized",
		});
		const finalize = f.calls.find((req) => req.url.endsWith("/finalize"));
		const create = f.calls.find(
			(req) => req.method === "POST" && req.url.endsWith("/v1/auth/link-attempts"),
		);
		expect(await create?.json()).toMatchObject({ identity_id: "identity-a", authority });
		expect(finalize).toBeDefined();
		const body = await finalize?.json();
		expect(body).toMatchObject({
			purpose: "coordinator-account-link-v1",
			identity_id: "identity-a",
			coordinator_id: cfg.coordinatorId,
			device_id: "device-a",
			fingerprint: f.fingerprint,
			completion: proofs?.completion,
		});
		expect(hash(body.runtime_verifier)).toBe(proofs?.row.runtime_verifier_hash);
		expect(body.runtime_verifier).not.toBe(proofs?.completion);
		expect(body.runtime_verifier).not.toBe(proofs?.start);
		expect(finalize?.headers.get("x-opencode-signature")).toMatch(/^v2:/);
		expect(f.calls.some((req) => req.method === "GET")).toBe(true);
		expect(
			f.remote.db.prepare("SELECT identity_id FROM coordinator_auth_account_links").all(),
		).toEqual([{ identity_id: "identity-a" }]);
		expect(
			protectedTables.map((name) => f.remote.db.prepare(`SELECT * FROM ${name}`).all()),
		).toEqual(protectedBefore);
		expect(localSnapshot(f)).toEqual(before);
		for (const secret of [body.runtime_verifier, proofs?.completion, proofs?.start])
			expect(JSON.stringify(result)).not.toContain(secret);
	},
);

test.for([-5000, 5000])(
	"signed account linking tolerates coordinator clock offset %i ms",
	async (offsetMs, { f }) => {
		// Arrange: only the authoritative store clock differs; runtime/signature clocks remain fixed.
		f.remoteClock.offsetMs = offsetMs;
		const before = localSnapshot(f);
		let browserError: unknown;
		let browserDone: Promise<unknown> = Promise.resolve();
		// Act
		const result = await linkCoordinatorAccount({
			...f.options,
			onBrowserStart: (url) => {
				browserDone = browser(f, url).catch((error: unknown) => {
					browserError = error;
				});
			},
		}).catch((error: unknown) => error);
		await browserDone;
		// Assert
		expect(browserError).toBeUndefined();
		if (result instanceof Error) {
			expect(f.calls.some((request) => request.url.endsWith("/cancel"))).toBe(true);
			expect(f.remote.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual(
				{ state: "failed" },
			);
		}
		expect(result).toMatchObject({
			coordinatorId: cfg.coordinatorId,
			identityId: "identity-a",
			state: "finalized",
		});
		expect(
			f.remote.db.prepare("SELECT state, expires_at_ms FROM coordinator_auth_link_attempts").get(),
		).toEqual({ state: "finalized", expires_at_ms: NOW + offsetMs + 600000 });
		expect(
			f.remote.db.prepare("SELECT identity_id FROM coordinator_auth_account_links").all(),
		).toEqual([{ identity_id: "identity-a" }]);
		expect(localSnapshot(f)).toEqual(before);
	},
);

test.for(["attempt", "coordinator", "identity", "authority", "missing authority"])(
	"invalid create %s pin never opens browser or finalizes",
	async (variant, { f }) => {
		// Arrange
		const onBrowserStart = vi.fn();
		const before = localSnapshot(f);
		f.options.fetch.mockImplementationOnce(async (_input, init) => {
			const create = JSON.parse(String(init?.body));
			let authority: string | undefined = "controller_attestation";
			if (variant === "authority") authority = "device_claim";
			if (variant === "missing authority") authority = undefined;
			return Response.json({
				status: {
					attemptId: variant === "attempt" ? "other" : create.attempt_id,
					state: "pending",
					expiresAtMs: NOW + 600000,
				},
				coordinator_id: variant === "coordinator" ? "" : cfg.coordinatorId,
				identity_id: variant === "identity" ? "" : "identity-a",
				authority,
			});
		});
		// Act
		const error = await linkCoordinatorAccount({ ...f.options, onBrowserStart }).catch(
			(cause: unknown) => cause,
		);
		// Assert
		expect(error).toBeInstanceOf(Error);
		expect(onBrowserStart).not.toHaveBeenCalled();
		expect(f.options.fetch).toHaveBeenCalledTimes(2);
		expect(f.calls.some((req) => req.url.endsWith("/finalize"))).toBe(false);
		expect(localSnapshot(f)).toEqual(before);
	},
);

test.for([
	"http://remote.example.test",
	"http://localhost:4567",
	"https://user@coordinator.example.test",
	`${origin}/path`,
	`${origin}?x=1`,
	`${origin}#fragment`,
])("rejects unsafe origin %s before IO", async (coordinatorUrl, { f }) => {
	// Arrange
	const onBrowserStart = vi.fn();
	const before = localSnapshot(f);
	// Act
	const error = await linkCoordinatorAccount({
		...f.options,
		coordinatorUrl,
		onBrowserStart,
	}).catch((cause: unknown) => cause);
	// Assert
	expect(error).toBeInstanceOf(Error);
	expect(f.options.fetch).not.toHaveBeenCalled();
	expect(onBrowserStart).not.toHaveBeenCalled();
	expect(localSnapshot(f)).toEqual(before);
});

test("missing enrolled device fails without provisioning or browser handoff", async ({ f }) => {
	// Arrange
	f.local.prepare("DELETE FROM sync_device").run();
	const before = localSnapshot(f);
	const onBrowserStart = vi.fn();
	// Act
	const error = await linkCoordinatorAccount({ ...f.options, onBrowserStart }).catch(
		(cause: unknown) => cause,
	);
	// Assert
	expect(error).toBeInstanceOf(Error);
	expect(f.options.fetch).not.toHaveBeenCalled();
	expect(onBrowserStart).not.toHaveBeenCalled();
	expect(localSnapshot(f)).toEqual(before);
});

test("unusable private key fails without creating or replacing keys", async ({ f }) => {
	// Arrange
	writeFileSync(join(f.options.keysDir, "device.key"), "not a private key");
	const before = localSnapshot(f);
	const onBrowserStart = vi.fn();
	// Act
	const error = await linkCoordinatorAccount({ ...f.options, onBrowserStart }).catch(
		(cause: unknown) => cause,
	);
	// Assert
	expect(error).toBeInstanceOf(Error);
	expect(f.options.fetch).not.toHaveBeenCalled();
	expect(onBrowserStart).not.toHaveBeenCalled();
	expect(localSnapshot(f)).toEqual(before);
});

test.for([false, true])(
	"interrupt cancels its own signed attempt; cancel failure=%s stays truthful",
	async (cancelFails, { f }) => {
		// Arrange
		const controller = new AbortController();
		const before = localSnapshot(f);
		const forwarding = f.options.fetch.getMockImplementation();
		if (!forwarding) throw new Error("fixture fetch missing");
		let destination = "";
		let cancelled: Request | undefined;
		f.options.fetch.mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			if (req.url.endsWith("/cancel")) {
				cancelled = req;
				if (cancelFails) throw new Error("private-transport-secret");
			}
			return forwarding(input, init);
		});
		// Act
		const error = await linkCoordinatorAccount({
			...f.options,
			signal: controller.signal,
			onBrowserStart: () => {
				destination = (
					f.remote.db
						.prepare("SELECT loopback_redirect FROM coordinator_auth_link_attempts")
						.get() as { loopback_redirect: string }
				).loopback_redirect;
				controller.abort(new Error("private-abort-secret"));
			},
		}).catch((cause: unknown) => cause);
		// Assert
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			message: cancelFails
				? "Could not confirm cancellation; request will expire. Linking may already have finished if the final reply was lost."
				: "Account linking stopped or expired. Try again.",
		});
		expect(String(error)).not.toMatch(/private-(transport|abort)-secret/);
		expect(cancelled?.headers.get("x-opencode-signature")).toMatch(/^v2:/);
		expect(await cancelled?.clone().json()).toEqual({ group_id: "group-a" });
		expect(f.remote.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual({
			state: cancelFails ? "pending" : "failed",
		});
		if (cancelFails) expect(String(error)).toMatch(/uncertain|could not|unable|not confirmed/i);
		await expect(localGet(destination)).rejects.toThrow();
		expect(localSnapshot(f)).toEqual(before);
	},
);

test("two lost finalize replies retry fresh signatures then report uncertainty without rollback", async ({
	f,
}) => {
	// Arrange
	const forwarding = f.options.fetch.getMockImplementation();
	if (!forwarding) throw new Error("fixture fetch missing");
	let proofs: Awaited<ReturnType<typeof browser>> | undefined;
	let browserDone: Promise<unknown> = Promise.resolve();
	f.options.fetch.mockImplementation(async (input, init) => {
		const response = await forwarding(input, init);
		if (new Request(input, init).url.endsWith("/finalize"))
			throw new Error("private-lost-response");
		return response;
	});
	// Act
	const result = await linkCoordinatorAccount({
		...f.options,
		onBrowserStart: (url) => {
			browserDone = browser(f, url).then((result) => {
				proofs = result;
			});
			void browserDone.catch(() => {});
		},
	}).catch((cause: unknown) => cause);
	await browserDone;
	// Assert
	expect(f.remote.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual({
		state: "finalized",
	});
	expect(result).toBeInstanceOf(Error);
	expect(result).toMatchObject({ code: "cancellation_unconfirmed" });
	const retries = f.calls.filter((req) => req.url.endsWith("/finalize"));
	expect(retries).toHaveLength(2);
	expect(retries[0]?.headers.get("x-opencode-nonce")).not.toBe(
		retries[1]?.headers.get("x-opencode-nonce"),
	);
	expect(String(result)).not.toMatch(/rollback|cancelled|private-lost-response/);
	for (const secret of [proofs?.start, proofs?.completion])
		expect(JSON.stringify(result)).not.toContain(secret);
});

test("an enrolled but unreviewed device gets review guidance before browser handoff", async ({
	f,
}) => {
	// Arrange
	f.remote.db.prepare("DELETE FROM coordinator_auth_controller_attestations").run();
	const onBrowserStart = vi.fn();
	const before = localSnapshot(f);
	// Act
	const error = await linkCoordinatorAccount({ ...f.options, onBrowserStart }).catch(
		(cause: unknown) => cause,
	);
	// Assert
	expect(error).toMatchObject({ code: "review_required" });
	expect(onBrowserStart).not.toHaveBeenCalled();
	expect(f.calls.filter((req) => req.url.endsWith("/cancel"))).toHaveLength(1);
	expect(f.remote.db.prepare("SELECT * FROM coordinator_auth_link_attempts").all()).toEqual([]);
	expect(f.remote.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
	expect(localSnapshot(f)).toEqual(before);
});

test("keeps actionable schema-upgrade guidance when cleanup is also refused", async ({ f }) => {
	const onBrowserStart = vi.fn();
	const before = localSnapshot(f);
	const fetch: typeof globalThis.fetch = async () =>
		new Response("private upstream cause", {
			status: 503,
			headers: { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" },
		});
	const error = await linkCoordinatorAccount({ ...f.options, fetch, onBrowserStart }).catch(
		(cause: unknown) => cause,
	);
	expect(error).toMatchObject({
		code: "schema_upgrade_required",
		message: expect.stringContaining("coordinator operator"),
	});
	expect(onBrowserStart).not.toHaveBeenCalled();
	expect(localSnapshot(f)).toEqual(before);
});

test.for([false, true])(
	"a revoked Identity link is rejected before browser handoff; cancellation fails=%s",
	async (cancelFails, { f }) => {
		// Arrange: complete one real signed link, then retain its revoked unique tombstone.
		let browserDone: Promise<unknown> = Promise.resolve();
		let transaction = 0;
		const onBrowserStart = (url: string) => {
			browserDone = browser(f, url, ++transaction);
			void browserDone.catch(() => {});
		};
		await linkCoordinatorAccount({ ...f.options, onBrowserStart });
		await browserDone;
		f.remote.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(NOW);
		const links = f.remote.db.prepare("SELECT * FROM coordinator_auth_account_links").all();
		const audit = f.remote.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all();
		const attempts = f.remote.db.prepare("SELECT * FROM coordinator_auth_link_attempts").all();
		const before = localSnapshot(f);
		f.calls.length = 0;
		const rejectedBrowserStart = vi.fn();
		const forwarding = f.options.fetch.getMockImplementation();
		if (!forwarding) throw new Error("fixture fetch missing");
		f.options.fetch.mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			if (cancelFails && req.url.endsWith("/cancel")) {
				f.calls.push(req);
				return new Response("private-transport-proof", { status: 503 });
			}
			return forwarding(input, init);
		});
		// Act
		const error = await linkCoordinatorAccount({
			...f.options,
			onBrowserStart: rejectedBrowserStart,
		}).catch((cause: unknown) => cause);
		await browserDone;
		// Assert
		expect(error).toMatchObject({ code: "review_required" });
		expect(rejectedBrowserStart).not.toHaveBeenCalled();
		expect(String(error)).not.toContain("private-transport-proof");
		expect(f.calls.filter((req) => req.url.endsWith("/finalize"))).toHaveLength(0);
		expect(f.calls.filter((req) => req.method === "GET")).toHaveLength(0);
		expect(f.calls.filter((req) => req.url.endsWith("/cancel"))).toHaveLength(1);
		expect(f.remote.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual(
			links,
		);
		expect(f.remote.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all()).toEqual(
			audit,
		);
		expect(f.remote.db.prepare("SELECT * FROM coordinator_auth_link_attempts").all()).toEqual(
			attempts,
		);
		expect(localSnapshot(f)).toEqual(before);
	},
);

test.for([
	{ status: 409, body: JSON.stringify({ error: "auth_link_conflict" }) },
	{ status: 403, body: JSON.stringify({ error: "auth_link_unavailable" }) },
	{ status: 409, body: JSON.stringify({ error: "auth_link_review_required" }) },
	{
		status: 403,
		body: JSON.stringify({ error: "auth_link_review_required", proof: "private-proof" }),
	},
	{ status: 403, body: "not JSON private-proof" },
])("create rejection $status $body remains generic", async ({ status, body }, { f }) => {
	// Arrange: a valid cancellation reply isolates the original rejection classification.
	const onBrowserStart = vi.fn();
	f.options.fetch.mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		if (req.url.endsWith("/cancel")) {
			const attemptId = req.url.split("/").at(-2);
			return Response.json({ status: { attemptId, state: "failed", expiresAtMs: NOW + 600000 } });
		}
		return new Response(body, { status });
	});
	// Act
	const error = await linkCoordinatorAccount({ ...f.options, onBrowserStart }).catch(
		(cause: unknown) => cause,
	);
	// Assert
	expect(error).toMatchObject({
		code: "request_failed",
		message: "Account linking could not finish. Try again.",
	});
	expect(onBrowserStart).not.toHaveBeenCalled();
	expect(String(error)).not.toContain("private-proof");
});

test("oversized rejection streams stop reading and cancel instead of mapping a label", async ({
	f,
}) => {
	// Arrange
	const cancelled = vi.fn();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					`${JSON.stringify({ error: "auth_link_review_required" })}${" ".repeat(16384)}`,
				),
			);
		},
		cancel: cancelled,
	});
	f.options.fetch.mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		if (req.url.endsWith("/cancel"))
			return Response.json({
				status: {
					attemptId: req.url.split("/").at(-2),
					state: "failed",
					expiresAtMs: NOW + 600000,
				},
			});
		return new Response(body, { status: 403 });
	});
	// Act
	const error = await linkCoordinatorAccount({ ...f.options, onBrowserStart: vi.fn() }).catch(
		(cause: unknown) => cause,
	);
	// Assert
	expect(error).toMatchObject({ code: "request_failed" });
	expect(cancelled).toHaveBeenCalledOnce();
});

test("a controller revoked after browser confirmation gets review guidance, not a retry or cancel warning", async ({
	f,
}) => {
	// Arrange
	const forwarding = f.options.fetch.getMockImplementation();
	if (!forwarding) throw new Error("fixture fetch missing");
	f.options.fetch.mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		if (req.url.endsWith("/cancel")) {
			f.calls.push(req);
			return new Response("private-cancel-proof", { status: 503 });
		}
		if (req.url.endsWith("/finalize"))
			await f.remote.store.revokeAuthControllerAttestation(
				cfg.coordinatorId,
				review().attestationId,
			);
		return forwarding(input, init);
	});
	let browserDone: Promise<unknown> = Promise.resolve();
	// Act
	const error = await linkCoordinatorAccount({
		...f.options,
		onBrowserStart: (url) => {
			browserDone = browser(f, url);
			void browserDone.catch(() => {});
		},
	}).catch((cause: unknown) => cause);
	await browserDone;
	// Assert
	expect(error).toMatchObject({ code: "review_required" });
	expect(f.calls.filter((req) => req.url.endsWith("/finalize"))).toHaveLength(1);
	expect(f.calls.filter((req) => req.url.endsWith("/cancel"))).toHaveLength(1);
	expect(String(error)).not.toContain("private-cancel-proof");
	expect(f.remote.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
});

test("a generic rejection still reports uncertainty when cancellation fails", async ({ f }) => {
	// Arrange
	f.options.fetch.mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		if (req.url.endsWith("/cancel"))
			return Response.json({ error: "auth_link_review_required" }, { status: 403 });
		return Response.json({ error: "auth_link_unavailable" }, { status: 403 });
	});
	const onBrowserStart = vi.fn();
	// Act
	const error = await linkCoordinatorAccount({ ...f.options, onBrowserStart }).catch(
		(cause: unknown) => cause,
	);
	// Assert
	expect(error).toMatchObject({ code: "cancellation_unconfirmed" });
	expect(onBrowserStart).not.toHaveBeenCalled();
	expect(String(error)).toMatch(/may already have finished/i);
});

test("a review label on status polling does not become owner-review guidance", async ({ f }) => {
	// Arrange
	const forwarding = f.options.fetch.getMockImplementation();
	if (!forwarding) throw new Error("fixture fetch missing");
	f.options.fetch.mockImplementation(async (input, init) => {
		if (init?.method === "GET")
			return Response.json({ error: "auth_link_review_required" }, { status: 403 });
		return forwarding(input, init);
	});
	const onBrowserStart = vi.fn();
	// Act
	const error = await linkCoordinatorAccount({ ...f.options, onBrowserStart }).catch(
		(cause: unknown) => cause,
	);
	// Assert
	expect(error).toMatchObject({ code: "request_failed" });
	expect(onBrowserStart).toHaveBeenCalledOnce();
	expect(f.calls.some((req) => req.url.endsWith("/finalize"))).toBe(false);
	expect(f.calls.filter((req) => req.url.endsWith("/cancel"))).toHaveLength(1);
	expect(f.remote.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual({
		state: "failed",
	});
});

test.for(
	[
		"expectedIdentityId",
		"expectedCoordinatorId",
		"expectedAuthority",
		"assertCurrentContext",
	].flatMap((field) =>
		[
			null,
			false,
			42,
			{},
			"",
			...(field === "expectedIdentityId" || field === "expectedAuthority" ? [undefined] : []),
		].map((value) => ({ field, value })),
	),
)(
	"rejects malformed $field=$value before local IO or listener bind",
	async ({ field, value }, { f }) => {
		// Arrange: throwing accessors detect even attempted DB/key access, not only writes.
		const dbPath = vi.fn(() => {
			throw new Error("private-db-access");
		});
		const keysDir = vi.fn(() => {
			throw new Error("private-key-access");
		});
		const listen = vi.spyOn(Server.prototype, "listen");
		const onBrowserStart = vi.fn();
		const options = { ...f.options, [field]: value, onBrowserStart };
		Object.defineProperties(options, {
			dbPath: { get: dbPath },
			keysDir: { get: keysDir },
		});
		// Act: malformed values deliberately cross the typed caller boundary.
		const error = await linkCoordinatorAccount(
			options as Parameters<typeof linkCoordinatorAccount>[0],
		).catch((cause: unknown) => cause);
		// Assert
		expect(error).toBeInstanceOf(CoordinatorAccountLinkError);
		expect(error).toMatchObject({ code: "invalid_options" });
		expect(dbPath).not.toHaveBeenCalled();
		expect(keysDir).not.toHaveBeenCalled();
		expect(listen).not.toHaveBeenCalled();
		expect(f.options.fetch).not.toHaveBeenCalled();
		expect(onBrowserStart).not.toHaveBeenCalled();
	},
);

test.for(["sync", "async", "retry"])(
	"matching context pins and a %s hook finalize normally",
	async (mode, { f }) => {
		// Arrange
		const before = localSnapshot(f);
		const assertCurrentContext = vi.fn(() => (mode === "async" ? Promise.resolve(true) : true));
		const forwarding = f.options.fetch.getMockImplementation();
		if (!forwarding) throw new Error("fixture fetch missing");
		let interrupted = false;
		f.options.fetch.mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			if (mode === "retry" && !interrupted && req.url.endsWith("/finalize")) {
				interrupted = true;
				f.calls.push(req);
				throw new Error("private-lost-finalize-proof");
			}
			return forwarding(input, init);
		});
		let browserDone: Promise<unknown> = Promise.resolve();
		// Act
		const result = await linkCoordinatorAccount({
			...f.options,
			expectedIdentityId: "identity-a",
			expectedCoordinatorId: cfg.coordinatorId,
			assertCurrentContext,
			onBrowserStart: (url) => {
				browserDone = browser(f, url);
				void browserDone.catch(() => {});
			},
		});
		await browserDone;
		// Assert
		expect(result).toMatchObject({
			identityId: "identity-a",
			coordinatorId: cfg.coordinatorId,
			state: "finalized",
		});
		expect(assertCurrentContext).toHaveBeenCalledTimes(mode === "retry" ? 5 : 4);
		const finalizes = f.calls.filter((req) => req.url.endsWith("/finalize"));
		expect(finalizes).toHaveLength(mode === "retry" ? 2 : 1);
		if (mode === "retry") {
			expect(finalizes[0]?.headers.get("x-opencode-nonce")).not.toBe(
				finalizes[1]?.headers.get("x-opencode-nonce"),
			);
		}
		expect(localSnapshot(f)).toEqual(before);
	},
);

test.for(
	["identity_id", "coordinator_id"].flatMap((field) =>
		[false, true].map((cancelFails) => ({ field, cancelFails })),
	),
)(
	"a different valid $field never releases a URL; cancel failure=$cancelFails",
	async ({ field, cancelFails }, { f }) => {
		// Arrange: create a real remote attempt, then substitute a well-formed but unexpected pin.
		const before = localSnapshot(f);
		const forwarding = f.options.fetch.getMockImplementation();
		if (!forwarding) throw new Error("fixture fetch missing");
		const onBrowserStart = vi.fn();
		let destination = "";
		f.options.fetch.mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			if (cancelFails && req.url.endsWith("/cancel")) {
				f.calls.push(req);
				throw new Error("private-cancel-proof");
			}
			const response = await forwarding(input, init);
			if (req.method === "POST" && req.url.endsWith("/v1/auth/link-attempts")) {
				destination = (await req.json()).loopback_redirect;
				return Response.json({ ...(await response.json()), [field]: "unexpected-pin" });
			}
			return response;
		});
		// Act
		const error = await linkCoordinatorAccount({
			...f.options,
			expectedIdentityId: "identity-a",
			expectedCoordinatorId: cfg.coordinatorId,
			onBrowserStart,
		}).catch((cause: unknown) => cause);
		// Assert
		expect(error).toBeInstanceOf(CoordinatorAccountLinkError);
		expect(error).toMatchObject({
			code: cancelFails ? "cancellation_unconfirmed" : "identity_mismatch",
		});
		expect(onBrowserStart).not.toHaveBeenCalled();
		expect(f.calls.filter((req) => req.url.endsWith("/finalize"))).toHaveLength(0);
		expect(f.calls.filter((req) => req.url.endsWith("/cancel"))).toHaveLength(1);
		expect(f.remote.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual({
			state: cancelFails ? "pending" : "failed",
		});
		expect(f.remote.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
		expect(String(error)).not.toMatch(/unexpected-pin|identity-a|private-cancel-proof|https?:\/\//);
		await expect(localGet(destination)).rejects.toThrow();
		expect(localSnapshot(f)).toEqual(before);
	},
);

const contextStages = [
	{ stage: "initial", checkpoint: 1, creates: 0, finalizes: 0, browsers: 0 },
	{ stage: "after listener bind", checkpoint: 2, creates: 0, finalizes: 0, browsers: 0 },
	{ stage: "before URL release", checkpoint: 3, creates: 1, finalizes: 0, browsers: 0 },
	{ stage: "before finalize", checkpoint: 4, creates: 1, finalizes: 0, browsers: 1 },
	{ stage: "before finalize retry", checkpoint: 5, creates: 1, finalizes: 1, browsers: 1 },
];
test.for(
	contextStages
		.flatMap((stage) =>
			["false", "throw", "reject"].map((mode) => ({
				...stage,
				mode,
				cancelFails: false,
				lostReply: false,
			})),
		)
		.concat(
			contextStages
				.slice(2)
				.map((stage) => ({ ...stage, mode: "false", cancelFails: true, lostReply: false })),
			contextStages
				.filter(({ checkpoint }) => checkpoint === 5)
				.map((stage) => ({ ...stage, mode: "reject", cancelFails: false, lostReply: true })),
		),
)(
	"context $mode $stage prevents the next mutation; cancel failure=$cancelFails lost reply=$lostReply",
	async ({ checkpoint, creates, finalizes, browsers, mode, cancelFails, lostReply }, { f }) => {
		// Arrange: every checkpoint uses a fresh fixture and independently rejects its next action.
		const before = localSnapshot(f);
		const forwarding = f.options.fetch.getMockImplementation();
		if (!forwarding) throw new Error("fixture fetch missing");
		const createReceiver = receiverRuntime.createCoordinatorAccountLinkReceiver;
		let receiver: Awaited<ReturnType<typeof createReceiver>> | undefined;
		vi.spyOn(receiverRuntime, "createCoordinatorAccountLinkReceiver").mockImplementation(
			async (options) => {
				receiver = await createReceiver(options);
				return receiver;
			},
		);
		const dbPath = vi.fn(() => f.options.dbPath);
		const keysDir = vi.fn(() => f.options.keysDir);
		const assertCurrentContext = vi.fn(() => {
			if (assertCurrentContext.mock.calls.length !== checkpoint) return true;
			if (mode === "throw") throw new Error("private-context-proof");
			if (mode === "reject") return Promise.reject(new Error("private-context-proof"));
			return false;
		});
		f.options.fetch.mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			if (cancelFails && req.url.endsWith("/cancel")) {
				f.calls.push(req);
				return Response.json({ error: "private-cancel-proof" }, { status: 503 });
			}
			if (checkpoint === 5 && req.url.endsWith("/finalize")) {
				if (lostReply) await forwarding(input, init);
				else f.calls.push(req);
				throw new Error("private-lost-finalize-proof");
			}
			return forwarding(input, init);
		});
		let proofs: Awaited<ReturnType<typeof browser>> | undefined;
		let browserDone: Promise<unknown> = Promise.resolve();
		const onBrowserStart = vi.fn((url: string) => {
			browserDone = browser(f, url).then((value) => {
				proofs = value;
			});
			void browserDone.catch(() => {});
		});
		const options = { ...f.options, assertCurrentContext, onBrowserStart };
		Object.defineProperties(options, { dbPath: { get: dbPath }, keysDir: { get: keysDir } });
		// Act
		const error = await linkCoordinatorAccount(options).catch((cause: unknown) => cause);
		await browserDone;
		// Assert: cancellation is cleanup, and remains necessary even after context rejection.
		expect(error).toBeInstanceOf(CoordinatorAccountLinkError);
		let code = "context_changed";
		if (cancelFails || lostReply) code = "cancellation_unconfirmed";
		expect(error).toMatchObject({ code });
		expect(assertCurrentContext).toHaveBeenCalledTimes(checkpoint);
		expect(onBrowserStart).toHaveBeenCalledTimes(browsers);
		expect(
			f.calls.filter((req) => req.method === "POST" && req.url.endsWith("/v1/auth/link-attempts")),
		).toHaveLength(creates);
		expect(f.calls.filter((req) => req.url.endsWith("/finalize"))).toHaveLength(finalizes);
		expect(f.calls.filter((req) => req.url.endsWith("/cancel"))).toHaveLength(creates);
		if (checkpoint === 1) {
			expect(dbPath).not.toHaveBeenCalled();
			expect(keysDir).not.toHaveBeenCalled();
			expect(receiver).toBeUndefined();
		}
		if (checkpoint <= 2) expect(f.options.fetch).not.toHaveBeenCalled();
		if (checkpoint === 2) expect(receiver?.destination).toMatch(/^http:\/\/127\.0\.0\.1:/);
		if (receiver) await expect(localGet(receiver.destination)).rejects.toThrow();
		let state = "failed";
		if (cancelFails) state = browsers ? "confirmed" : "pending";
		if (lostReply) state = "finalized";
		const expectedRows = creates ? [{ state }] : [];
		expect(f.remote.db.prepare("SELECT state FROM coordinator_auth_link_attempts").all()).toEqual(
			expectedRows,
		);
		expect(
			f.remote.db.prepare("SELECT identity_id FROM coordinator_auth_account_links").all(),
		).toEqual(lostReply ? [{ identity_id: "identity-a" }] : []);
		expect(String(error)).not.toMatch(/private-|identity-a|https?:\/\//);
		for (const secret of [proofs?.completion, proofs?.start].filter(
			(value) => value !== undefined,
		)) {
			expect(String(error)).not.toContain(secret);
		}
		expect(localSnapshot(f)).toEqual(before);
	},
);

test.for([false, true])(
	"aborting a pending pre-browser hook closes its receiver; late true=$lateTrue",
	async (lateTrue, { f }) => {
		// Arrange: track the composed runtime signal, not just the caller's signal.
		const controller = new AbortController();
		const before = localSnapshot(f);
		const createReceiver = receiverRuntime.createCoordinatorAccountLinkReceiver;
		let receiver: Awaited<ReturnType<typeof createReceiver>> | undefined;
		let runtimeSignal: AbortSignal | undefined;
		vi.spyOn(receiverRuntime, "createCoordinatorAccountLinkReceiver").mockImplementation(
			async (options) => {
				runtimeSignal = options.signal;
				receiver = await createReceiver(options);
				return receiver;
			},
		);
		const added = vi.spyOn(AbortSignal.prototype, "addEventListener");
		const removed = vi.spyOn(AbortSignal.prototype, "removeEventListener");
		const pending = Promise.withResolvers<boolean>();
		const entered = Promise.withResolvers<void>();
		const onBrowserStart = vi.fn();
		const assertCurrentContext = vi.fn(() => {
			if (assertCurrentContext.mock.calls.length !== 3) return true;
			entered.resolve();
			return pending.promise;
		});
		// Act
		const result = linkCoordinatorAccount({
			...f.options,
			signal: controller.signal,
			assertCurrentContext,
			onBrowserStart,
		}).catch((cause: unknown) => cause);
		await entered.promise;
		controller.abort(new Error("private-abort-proof"));
		if (lateTrue) pending.resolve(true);
		const error = await result;
		// Assert: cleanup cannot depend on the untrusted callback ever settling.
		expect(error).toBeInstanceOf(CoordinatorAccountLinkError);
		expect(error).toMatchObject({ code: "link_stopped" });
		expect(onBrowserStart).not.toHaveBeenCalled();
		expect(f.calls.filter((req) => req.url.endsWith("/cancel"))).toHaveLength(1);
		expect(f.calls.filter((req) => req.url.endsWith("/finalize"))).toHaveLength(0);
		expect(f.remote.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual({
			state: "failed",
		});
		expect(receiver).toBeDefined();
		if (!receiver) throw new Error("fixture receiver missing");
		await expect(localGet(receiver.destination)).rejects.toThrow();
		expect(runtimeSignal).not.toBe(controller.signal);
		expect(runtimeSignal?.aborted).toBe(true);
		const handlers = added.mock.calls.flatMap(([event, handler], index) => {
			if (event === "abort" && added.mock.contexts[index] === runtimeSignal) return [handler];
			return [];
		});
		expect(handlers.length).toBeGreaterThan(0);
		for (const handler of handlers) {
			expect(
				removed.mock.calls.some(
					([event, candidate], index) =>
						event === "abort" &&
						candidate === handler &&
						removed.mock.contexts[index] === runtimeSignal,
				),
			).toBe(true);
		}
		expect(String(error)).not.toMatch(/private-|https?:\/\//);
		expect(localSnapshot(f)).toEqual(before);
	},
);

test.for(["caller abort", "default deadline"])(
	"a pending initial hook stops on %s without local IO, listener bind, or network",
	async (stop, { f }) => {
		// Arrange: fake only timers; no socket or browser is started in this test.
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const assertCurrentContext = vi.fn(() => {
			entered.resolve();
			return new Promise<boolean>(() => {});
		});
		const access = vi.fn(() => {
			throw new Error("private-local-access");
		});
		const listen = vi.spyOn(Server.prototype, "listen");
		const onBrowserStart = vi.fn();
		const options = {
			...f.options,
			assertCurrentContext,
			onBrowserStart,
			signal: stop === "caller abort" ? controller.signal : undefined,
		};
		Object.defineProperties(options, { dbPath: { get: access }, keysDir: { get: access } });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			// Act
			const result = linkCoordinatorAccount(options).catch((cause: unknown) => cause);
			await entered.promise;
			if (stop === "caller abort") controller.abort();
			else await vi.advanceTimersByTimeAsync(600000);
			const error = await result;
			// Assert
			expect(error).toBeInstanceOf(CoordinatorAccountLinkError);
			expect(error).toMatchObject({ code: "link_stopped" });
			expect(assertCurrentContext).toHaveBeenCalledOnce();
			expect(access).not.toHaveBeenCalled();
			expect(listen).not.toHaveBeenCalled();
			expect(f.options.fetch).not.toHaveBeenCalled();
			expect(onBrowserStart).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	},
);

test.for(["promise false", "truthy non-boolean"])(
	"the context hook rejects %s rather than accepting truthiness",
	async (mode, { f }) => {
		// Arrange: exercise untyped callback results at the runtime boundary.
		const onBrowserStart = vi.fn();
		const hook = () => (mode === "promise false" ? Promise.resolve(false) : 1);
		const assertCurrentContext = hook as () => boolean | Promise<boolean>;
		// Act
		const error = await linkCoordinatorAccount({
			...f.options,
			assertCurrentContext,
			onBrowserStart,
		}).catch((cause: unknown) => cause);
		// Assert
		expect(error).toMatchObject({ code: "context_changed" });
		expect(onBrowserStart).not.toHaveBeenCalled();
		expect(f.options.fetch).not.toHaveBeenCalled();
	},
);

test("the context callback runs detached from the private options object", async ({ f }) => {
	// Arrange
	const detached: boolean[] = [];
	const onBrowserStart = vi.fn();
	function assertCurrentContext(this: unknown) {
		detached.push(this === undefined);
		return false;
	}
	// Act
	const error = await linkCoordinatorAccount({
		...f.options,
		assertCurrentContext,
		onBrowserStart,
	}).catch((cause: unknown) => cause);
	// Assert
	expect(error).toMatchObject({ code: "context_changed" });
	expect(detached).toEqual([true]);
	expect(onBrowserStart).not.toHaveBeenCalled();
	expect(f.options.fetch).not.toHaveBeenCalled();
});
