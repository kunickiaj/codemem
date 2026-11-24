import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildSyncRejoinCommand } from "../../cli/src/commands/sync-rejoin.js";
import * as linkProof from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createDeviceRejoinRequests } from "./coordinator-device-rejoin-client-requests.js";
import { confirmationScope } from "./coordinator-device-rejoin-confirmation-test-harness.js";
import { seedGenesis } from "./coordinator-device-rejoin-link-evidence-test-harness.js";
import { createDeviceRejoinStatusHandler } from "./coordinator-device-rejoin-status-http.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { connect } from "./db.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

// The CLI imports the package entry point. Use source here rather than a package build.
vi.mock("@codemem/core", () => import("./index.js"));

const now = confirmationScope.now;
const origin = new URL(PROVIDER.redirectUri).origin;
const config = {
	enabled: true,
	coordinatorId: confirmationScope.coordinatorId,
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	revision: confirmationScope.authConfigRevision,
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};
const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const originalExitCode = process.exitCode;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function localDevice() {
	const dir = mkdtempSync(join(tmpdir(), "codemem-rejoin-route-cli-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const pair = generateKeyPairSync("ed25519");
	const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
	const publicKey = `ssh-ed25519 ${Buffer.concat([
		Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
		raw,
	]).toString("base64")}`;
	const fingerprint = fingerprintPublicKey(publicKey);
	writeFileSync(join(dir, "device.key"), pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
		mode: 0o600,
	});
	const dbPath = join(dir, "device.sqlite");
	const profile = join(dir, "config.json");
	writeFileSync(profile, JSON.stringify({ sync_coordinator_url: origin }));
	const db = connect(dbPath);
	db.prepare(
		`INSERT INTO sync_device (device_id, public_key, fingerprint, created_at) VALUES ('removed', ?, ?, 'then')`,
	).run(publicKey, fingerprint);
	db.close();
	return { dbPath, profile, keysDir: dir, publicKey, fingerprint };
}

async function coordinator(local: ReturnType<typeof localDevice>) {
	const { db, store } = setupStore("SQLite", { authClock: () => now });
	const close = store.close.bind(store);
	cleanup.push(close);
	vi.spyOn(store, "close").mockResolvedValue(undefined);
	await seedGenesis({
		proof: {
			...linkProof,
			controllerLinkEvidenceSql: (pins) =>
				linkProof
					.controllerLinkEvidenceSql(pins)
					.replaceAll(confirmationScope.issuer, config.issuer),
		},
		first: async <T>({ sql, values }: AuthLinkStatement) =>
			(db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: async (sql, ...values) => db.prepare(sql).run(...values),
	});
	const keyId = await ed25519KeyId(local.publicKey);
	db.prepare("INSERT INTO groups(group_id,created_at) VALUES ('group-a','then')").run();
	db.prepare(`INSERT INTO coordinator_device_ownership_bindings
 (device_id,key_id,coordinator_id,identity_id,binding_id,provenance,source_ref,bound_at)
 VALUES ('removed',?,?,'identity-a','binding-a','owner_enrollment','fixture','then')`).run(
		keyId,
		config.coordinatorId,
	);
	db.prepare(`INSERT INTO coordinator_device_removals
 (removal_id,group_id,device_id,public_key,fingerprint,key_id,identity_id,removed_at)
 VALUES ('removal-a','group-a','removed',?,?,?,'identity-a','then')`).run(
		local.publicKey,
		local.fingerprint,
		keyId,
	);
	const oidc = oidcFixture({ issuer: config.issuer });
	oidc.claims.sub = "private-subject";
	const created = await createCoordinatorBrowserAuth(
		captureCoordinatorBrowserAuthOptions({
			config,
			csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
			oidcOptions: { fetch: oidc.fetch },
		}),
		store,
		createInMemoryRequestRateLimiter({ now: () => now }),
	);
	if (!created.ok) throw new Error(created.error);
	const storeFactory = () => store;
	const clientKey = () => "synthetic-client";
	const app = createCoordinatorApp({
		storeFactory,
		runtime: { adminSecret: () => null, now: () => new Date(now).toISOString() },
		requestVerifier: () => {
			throw new Error("Rejoin must not call enrolled admission");
		},
		browserAuth: {
			kind: "ready",
			auth: created.auth,
			storeFactory,
			clientKey,
			clientAddress: clientKey,
		},
	});
	// Only the fresh, authenticated live branch is attached in this fixture.
	const liveStatus = createDeviceRejoinStatusHandler({
		config: created.auth.storeConfig,
		storeFactory,
		clientKey,
		rateLimitedResponse: () => null,
		readRequestBytes: async (c, limit) => {
			const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
			return bytes.length <= limit ? bytes : null;
		},
	});
	app.post("/v1/auth/rejoin-attempts/:attemptId/status", async (c) => {
		const response = await liveStatus(c);
		if (!(response instanceof Response)) throw new Error("Expired status is outside this fixture");
		return response;
	});
	return { db, app, oidc };
}

type Coordinator = Awaited<ReturnType<typeof coordinator>>;
const cookie = (r: Response) => r.headers.getSetCookie()[0]?.split(";")[0] ?? "";
function field(html: string, name: string) {
	return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
}

function postBrowser(f: Coordinator, path: string, binder: string, fields: Record<string, string>) {
	return f.app.request(`${origin}${path}`, {
		method: "POST",
		headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});
}

async function completeInBrowser(f: Coordinator, link: string) {
	const start = await f.app.request(link);
	expect(start.status).toBe(200);
	const startPage = await start.text();
	const attemptId = field(startPage, "attempt_id");
	const begin = await postBrowser(f, "/auth/rejoin/start", cookie(start), {
		attempt_id: attemptId,
		csrf: field(startPage, "csrf"),
		start_code: field(startPage, "start_code"),
	});
	expect(begin.status).toBe(200);
	const google = /content="0;url=([^"]+)"/.exec(await begin.text())?.[1]?.replaceAll("&amp;", "&");
	if (!google) throw new Error("Missing synthetic Google redirect");
	const review = await f.app.request(f.oidc.authorize(google).href, {
		headers: { cookie: cookie(begin) },
	});
	expect(review.status).toBe(200);
	const page = await review.text();
	expect(page).toContain("group-a");
	const complete = await postBrowser(f, "/auth/rejoin/confirm", cookie(begin), {
		attempt_id: attemptId,
		csrf: field(page, "csrf"),
		confirmation_hash: field(page, "confirmation_hash"),
	});
	expect(complete.status).toBe(200);
	const href = /href="(http:\/\/127\.0\.0\.1:[^"]+)"/
		.exec(await complete.text())?.[1]
		?.replaceAll("&amp;", "&");
	if (!href) throw new Error("Missing literal loopback");
	await new Promise<void>((resolve, reject) => {
		get(href, (response) => {
			response.resume();
			response.on("end", () =>
				response.statusCode === 200 ? resolve() : reject(new Error("Loopback refused")),
			);
		}).on("error", reject);
	});
}

it("recovers a lost start from the mounted route with the original expiry and a new signature", async () => {
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const local = localDevice();
	const f = await coordinator(local);
	let original: unknown;
	const transport = vi.fn<typeof fetch>(async (url, init) => {
		const response = await f.app.request(url, init);
		expect(response.status).toBe(200);
		if (transport.mock.calls.length === 1) {
			original = await response.json();
			throw new Error("Synthetic loss after start committed");
		}
		return response;
	});
	const client = await createDeviceRejoinRequests({
		...local,
		coordinatorUrl: origin,
		fetch: transport,
	});
	if (!client) throw new Error("Missing local signer");
	const start = {
		attemptId: "lost-reply",
		browserStartHash: "a".repeat(64),
		loopbackRedirect: "http://127.0.0.1:1234/codemem/auth/complete",
	};
	expect(await client.start(start)).toEqual({ kind: "unknown" });
	expect(transport).toHaveBeenCalledOnce();
	const before = f.db.prepare("SELECT * FROM coordinator_device_rejoin_attempts").all();
	clock.mockReturnValue(now + 1000);
	expect(await client.start(start)).toMatchObject({
		kind: "started",
		pins: { attemptId: "lost-reply", expiresAtMs: now + 600_000 },
	});
	expect(original).toMatchObject({ attempt_id: start.attemptId, expires_at_ms: now + 600_000 });
	const [first, second] = transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
	expect(second.timestamp_ms).toBe(first.timestamp_ms + 1000);
	expect(second.signature).not.toBe(first.signature);
	expect(f.db.prepare("SELECT * FROM coordinator_device_rejoin_attempts").all()).toEqual(before);
});

it("runs sync rejoin through mounted routes and recovers a lost finalize reply via live status", async () => {
	vi.spyOn(Date, "now").mockReturnValue(now);
	process.exitCode = undefined;
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	const local = localDevice();
	vi.stubEnv("CODEMEM_KEYS_DIR", local.keysDir);
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", undefined);
	const f = await coordinator(local);
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			expect(new URL(url).origin).toBe(origin);
			const action = new URL(url).pathname.split("/").at(-1) ?? "";
			calls.push(action);
			const response = await f.app.request(url, init);
			if (action === "finalize") {
				expect(response.status).toBe(200);
				throw new Error("Synthetic loss after finalize committed");
			}
			return response;
		}),
	);
	let browser: Promise<void> | undefined;
	const output: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		const text = String(chunk);
		output.push(text);
		const link = /https:\/\/app\.example\.test\/auth\/rejoin\/start\?[A-Za-z0-9_=&-]+/.exec(
			text,
		)?.[0];
		if (link && !browser) {
			browser = completeInBrowser(f, link);
			void browser.catch(() => process.emit("SIGINT"));
		}
		return true;
	});
	await buildSyncRejoinCommand().parseAsync(
		["--config", local.profile, "--db-path", local.dbPath],
		{ from: "user" },
	);
	await browser;
	expect(calls).toEqual(["rejoin-attempts", "status", "finalize", "status"]);
	expect(output.join("")).toContain("This device rejoined");
	expect(f.db.prepare("SELECT device_id,group_id FROM enrolled_devices").all()).toEqual([
		{ device_id: "removed", group_id: "group-a" },
	]);
	expect(
		f.db.prepare("SELECT count(*) AS count FROM coordinator_device_rejoin_audit_log").get(),
	).toEqual({ count: 1 });
});
