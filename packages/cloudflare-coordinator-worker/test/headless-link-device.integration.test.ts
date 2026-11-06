import { env } from "cloudflare:workers";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	HEADLESS_CODE_LIMITS_TABLE,
	HEADLESS_LINK_PROVENANCE_TABLE,
	HEADLESS_LINK_SCHEMA_STATEMENTS,
} from "../../core/src/coordinator-auth-headless-schema.js";
import { hashHeadlessUserCode } from "../../core/src/coordinator-auth-link-headless.js";
import type { CoordinatorAuthBrowserConfig } from "../../core/src/coordinator-auth-browser-transaction-contract.js";
import { issueBrowserCookie } from "../../core/src/coordinator-browser-credential.js";
import { importBrowserCsrfKey, issueBrowserCsrfToken } from "../../core/src/coordinator-browser-csrf.js";
import { createDeviceRebindCeremony } from "../../core/src/coordinator-device-rebind-ceremony.js";
import {
	type DeviceRebindAttempt,
	deviceRebindFinalMessage,
} from "../../core/src/coordinator-device-rebind-proof.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { createD1AuthLinkBackend, D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { createCloudflareCoordinatorWorker } from "../src/index.js";

// Fixture-only values; the code, proofs and keys exist only in this test.
const ORIGIN = "https://app.example.test";
const NOW = 1791028800000;
const CODE = "BCDFGHJK";
const SUBJECT = "native-headless-subject";
const ROOT = "/v1/auth/headless-link-attempts";
const IP = "192.0.2.45";
const PROOF = Buffer.alloc(32, 23).toString("base64url");
const proofHash = createHash("sha256").update(Buffer.from(PROOF, "base64url")).digest("hex");
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

function deviceKey() {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return {
		deviceId: crypto.randomUUID(),
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		privateKey: keys.privateKey,
		sign: (message: string) =>
			sign(null, Buffer.from(message), keys.privateKey).toString("base64url"),
	};
}
type Key = ReturnType<typeof deviceKey>;

/** A worker with browser auth, an attested device A, and an unattested device B in one group. */
async function setupNative() {
	const config = {
		enabled: true,
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.google.com",
		revision: "a".repeat(64),
		redirectUri: PROVIDER.redirectUri,
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	};
	const oidc = oidcFixture({ issuer: config.issuer });
	Object.assign(oidc.claims, { sub: SUBJECT, email: "ada@example.test", email_verified: true });
	const worker = createCloudflareCoordinatorWorker({
		now: () => new Date(NOW).toISOString(),
		browserAuth: {
			config,
			csrfKey: await importBrowserCsrfKey(crypto.getRandomValues(new Uint8Array(32))),
			oidcOptions: { fetch: oidc.fetch },
		},
	});
	const store = new D1CoordinatorStore(env.COORDINATOR_DB);
	const groupId = crypto.randomUUID();
	const identityId = crypto.randomUUID();
	const keyA = deviceKey();
	const keyB = deviceKey();
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, { ...keyA, displayName: "Build box" });
	await store.enrollDevice(groupId, keyB);
	const attested = await store.createAuthControllerAttestation({
		coordinatorId: config.coordinatorId,
		groupId,
		deviceId: keyA.deviceId,
		identityId,
		attestationId: crypto.randomUUID(),
		reviewReceiptId: crypto.randomUUID(),
		publicKey: keyA.publicKey,
		fingerprint: keyA.fingerprint,
		evidenceDigest: "b".repeat(64),
	});
	expect(attested).toMatchObject({ kind: "created" });
	const request = (path: string | URL, init?: RequestInit) =>
		worker.fetch(new Request(new URL(path, ORIGIN), init), env);
	const signed = (key: Key, method: string, path: string, value?: unknown) => {
		const body = value === undefined ? "" : JSON.stringify(value);
		const timestamp = String(NOW / 1000);
		const nonce = randomBytes(16).toString("hex");
		const signature = sign(
			null,
			buildCanonicalRequest(method, path, timestamp, nonce, Buffer.from(body)),
			key.privateKey,
		);
		return request(path, {
			method,
			headers: {
				"content-type": "application/json",
				"X-Opencode-Device": key.deviceId,
				"X-Opencode-Timestamp": timestamp,
				"X-Opencode-Nonce": nonce,
				"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
			},
			...(method === "GET" ? {} : { body }),
		});
	};
	return { config, oidc, groupId, identityId, keyA, keyB, request, signed, attemptId: crypto.randomUUID() };
}
type NativeFixture = Awaited<ReturnType<typeof setupNative>>;

async function createBody(f: NativeFixture) {
	return {
		group_id: f.groupId,
		identity_id: f.identityId,
		authority: "controller_attestation",
		attempt_id: f.attemptId,
		runtime_verifier_hash: proofHash,
		user_code_hash: await hashHeadlessUserCode(CODE),
	};
}
function finalizeBody(f: NativeFixture) {
	return {
		purpose: "coordinator-account-link-v1",
		coordinator_id: f.config.coordinatorId,
		attempt_id: f.attemptId,
		group_id: f.groupId,
		identity_id: f.identityId,
		device_id: f.keyA.deviceId,
		fingerprint: f.keyA.fingerprint,
		runtime_verifier: PROOF,
		completion: PROOF,
		approved_issuer: f.config.issuer,
		approved_subject: SUBJECT,
	};
}

function fields(html: string, action?: string) {
	const markup = action
		? (html.match(new RegExp(`<form[^>]+action="${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1] ?? "")
		: html;
	return Object.fromEntries(
		[...markup.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
	);
}
function cookie(response: Response) {
	return (
		response.headers
			.getSetCookie()
			.find((value) => !value.includes("Max-Age=0"))
			?.split(";")[0] ?? ""
	);
}
function post(f: NativeFixture, path: string, body: Record<string, string>, binder: string) {
	return f.request(path, {
		method: "POST",
		body: new URLSearchParams(body),
		headers: {
			origin: ORIGIN,
			cookie: binder,
			"content-type": "application/x-www-form-urlencoded",
			"CF-Connecting-IP": IP,
		},
	});
}

/** Code entry, Google sign-in and approval in the browser; null when the code is refused. */
async function approveInBrowser(f: NativeFixture) {
	const page = await f.request("/auth/link/device", { headers: { "CF-Connecting-IP": IP } });
	const started = await post(f, "/auth/link/device", { ...fields(await page.text()), user_code: CODE }, cookie(page));
	const html = await started.text();
	const href = html.match(/href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/)?.[1];
	if (!href) return null;
	const binder = cookie(started);
	const callback = await f.request(f.oidc.authorize(new URL(href.replaceAll("&amp;", "&"))), {
		headers: { cookie: binder },
	});
	const approve = fields(await callback.text(), "/auth/link/device/confirm");
	return post(f, "/auth/link/device/confirm", approve, binder);
}

async function linkWithProvenance(f: NativeFixture) {
	return env.COORDINATOR_DB.prepare(
		`SELECT l.link_id, l.subject, p.attempt_id AS provenance_attempt FROM coordinator_auth_account_links l
		 LEFT JOIN ${HEADLESS_LINK_PROVENANCE_TABLE} p ON p.coordinator_id = l.coordinator_id AND p.link_id = l.link_id
		 WHERE l.coordinator_id = ?`,
	)
		.bind(f.config.coordinatorId)
		.all<{ link_id: string; subject: string; provenance_attempt: string | null }>();
}

it("links a headless device from create through code entry, Google, approval and finalize", async () => {
	// Arrange
	const f = await setupNative();
	const status = `${ROOT}/${f.attemptId}?group_id=${f.groupId}`;
	const finalize = `${ROOT}/${f.attemptId}/finalize`;
	// Act
	const created = await f.signed(f.keyA, "POST", ROOT, await createBody(f));
	const createdJson = await created.json();
	const approved = await approveInBrowser(f);
	const reused = await approveInBrowser(f);
	const polled = await (await f.signed(f.keyA, "GET", status)).json();
	const otherStatus = await f.signed(f.keyB, "GET", status);
	const desktop = await f.signed(f.keyA, "POST", `/v1/auth/link-attempts/${f.attemptId}/finalize`, {
		...finalizeBody(f),
		approved_issuer: undefined,
		approved_subject: undefined,
	});
	const otherFinalize = await f.signed(f.keyB, "POST", finalize, {
		...finalizeBody(f),
		device_id: f.keyB.deviceId,
		fingerprint: f.keyB.fingerprint,
	});
	const linksBefore = await linkWithProvenance(f);
	const finalized = await f.signed(f.keyA, "POST", finalize, finalizeBody(f));
	// Assert
	expect(created.status).toBe(201);
	expect(createdJson).toMatchObject({
		verification_uri: `${ORIGIN}/auth/link/device`,
		poll_interval_s: 5,
		status: { state: "pending" },
	});
	expect(approved?.status).toBe(200);
	expect(reused).toBeNull();
	expect(polled).toMatchObject({
		status: { state: "confirmed" },
		approval: { issuer: f.config.issuer, subject: SUBJECT, email: "ada@example.test", email_verified: true },
	});
	expect(otherStatus.status).toBe(404);
	expect(desktop.status).toBe(403);
	expect(otherFinalize.status).toBe(403);
	expect(linksBefore.results).toEqual([]);
	expect(finalized.status).toBe(200);
	expect((await linkWithProvenance(f)).results).toEqual([
		expect.objectContaining({ subject: SUBJECT, provenance_attempt: f.attemptId }),
	]);
});

it("reports the headless routes as not found before migration 0043", async () => {
	// Arrange
	const f = await setupNative();
	const db = env.COORDINATOR_DB;
	await db.batch([
		db.prepare(`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}`),
		db.prepare(`DROP TABLE ${HEADLESS_LINK_PROVENANCE_TABLE}`),
	]);
	try {
		// Act
		const created = await f.signed(f.keyA, "POST", ROOT, await createBody(f));
		const page = await f.request("/auth/link/device", { headers: { "CF-Connecting-IP": IP } });
		// Assert
		expect(created.status).toBe(404);
		expect(page.status).toBe(404);
	} finally {
		await db.batch(HEADLESS_LINK_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
	}
});

type RebindConfig = NativeFixture["config"];

/** A fresh device in its own group, and a rebind ceremony where Google returns `subject`. */
async function rebindSetup(config: RebindConfig, subject: string) {
	const key = deviceKey();
	const db = env.COORDINATOR_DB;
	const groupId = crypto.randomUUID();
	const signer = { groupId, deviceId: key.deviceId, publicKey: key.publicKey, fingerprint: key.fingerprint };
	await db.batch([
		db.prepare("INSERT INTO groups (group_id, created_at) VALUES (?, 'created')").bind(groupId),
		db
			.prepare(`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, enabled, created_at)
			 VALUES (?, ?, ?, ?, 1, 'created')`)
			.bind(groupId, key.deviceId, key.publicKey, key.fingerprint),
	]);
	const material = {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		pkceVerifier: randomBytes(32).toString("base64url"),
	};
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const ceremony = createDeviceRebindCeremony({
		backend: createD1AuthLinkBackend(db),
		config: config as unknown as CoordinatorAuthBrowserConfig,
		publicOrigin: ORIGIN,
		csrfKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		client: {
			createAuthorizationRequest: async () => ({
				authorizationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test-client",
				material,
			}),
			verifyCallback: async () => ({ ok: true, account: { issuer: config.issuer, subject }, profile: {} }),
		},
		now: () => NOW,
	});
	return { key, signer, ceremony, material, csrfKey, config, attemptId: crypto.randomUUID() };
}
type Rebind = Awaited<ReturnType<typeof rebindSetup>>;

function form(cookieValue: string, values: Record<string, string>) {
	return new Request(`${ORIGIN}/auth/rebind`, {
		method: "POST",
		headers: { origin: ORIGIN, cookie: cookieValue, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(values),
	});
}

/** Device start, browser claim and the Google callback. */
async function rebindCallback(r: Rebind) {
	const code = randomBytes(32).toString("base64url");
	await r.ceremony.start(
		{
			attemptId: r.attemptId,
			signer: r.signer,
			currentIdentityId: `local:${r.signer.deviceId}`,
			loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
			browserStartHash: createHash("sha256").update(Buffer.from(code, "base64url")).digest("hex"),
			reviewDigest: "e".repeat(64),
		},
		"client",
	);
	const start = await issueBrowserCookie("start");
	const scope = { publicOrigin: ORIGIN, store: r.config };
	const claimed = await r.ceremony.claimBrowser(
		form(start.setCookie.split(";")[0] ?? "", {
			csrf: await issueBrowserCsrfToken(r.csrfKey, start.secret, "start", scope),
			attempt_id: r.attemptId,
			start_code: code,
		}),
		"client",
	);
	if (claimed?.kind !== "browser_claimed") throw new Error(JSON.stringify(claimed));
	const transaction = claimed.setCookies[0]?.split(";")[0] ?? "";
	const callback = await r.ceremony.verifyCallback(
		new Request(`${r.config.redirectUri}?state=${r.material.state}&code=c`, { headers: { cookie: transaction } }),
	);
	return { callback, transaction };
}

it("refuses to rebind a device into an account whose active link is headless", async () => {
	// Arrange: link the account headlessly through the real routes.
	const f = await setupNative();
	await f.signed(f.keyA, "POST", ROOT, await createBody(f));
	expect((await approveInBrowser(f))?.status).toBe(200);
	expect((await f.signed(f.keyA, "POST", `${ROOT}/${f.attemptId}/finalize`, finalizeBody(f))).status).toBe(200);
	const r = await rebindSetup(f.config, SUBJECT);
	// Act
	const { callback } = await rebindCallback(r);
	// Assert
	expect(callback).toMatchObject({ kind: "refused", reason: "target_headless_linked" });
});

it("refuses the native rebind commit when the target link became headless after confirmation", async () => {
	// Arrange: a desktop-style link with no provenance, confirmed for rebind.
	const f = await setupNative();
	const db = env.COORDINATOR_DB;
	const linkId = crypto.randomUUID();
	await db
		.prepare(`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
		 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
		 VALUES (?, ?, ?, 'race-subject', 'race-target', ?, ?, 1, 'device_claim', ?)`)
		.bind(f.config.coordinatorId, linkId, f.config.issuer, crypto.randomUUID(), f.config.revision, crypto.randomUUID())
		.run();
	const r = await rebindSetup(f.config, "race-subject");
	const { callback, transaction } = await rebindCallback(r);
	if (callback?.kind !== "verified") throw new Error(JSON.stringify(callback));
	const confirmed = await r.ceremony.confirm(
		form(transaction, { csrf: callback.csrf, attempt_id: r.attemptId }),
		"client",
		callback.confirmation.confirmationHash,
	);
	if (confirmed?.kind !== "confirmed") throw new Error(JSON.stringify(confirmed));
	await db
		.prepare(`INSERT INTO ${HEADLESS_LINK_PROVENANCE_TABLE} (coordinator_id, link_id, identity_id, issuer, subject,
		 attempt_id, created_at_ms) VALUES (?, ?, 'race-target', ?, 'race-subject', ?, 1)`)
		.bind(f.config.coordinatorId, linkId, f.config.issuer, crypto.randomUUID())
		.run();
	const row = (await db
		.prepare("SELECT * FROM coordinator_device_rebind_attempts WHERE attempt_id = ?")
		.bind(r.attemptId)
		.first()) as unknown as DeviceRebindAttempt;
	// Act
	const finalized = await r.ceremony.finalize({
		attemptId: r.attemptId,
		signer: r.signer,
		completionSecret: confirmed.completionSecret,
		signature: r.key.sign(deviceRebindFinalMessage(row, confirmed.completionSecret)),
	});
	// Assert
	expect(finalized).toEqual({ kind: "refused", reason: "target_headless_linked" });
	const bindings = await db
		.prepare("SELECT count(*) AS n FROM coordinator_device_ownership_bindings WHERE device_id = ?")
		.bind(r.signer.deviceId)
		.first<{ n: number }>();
	expect(bindings).toEqual({ n: 0 });
});
