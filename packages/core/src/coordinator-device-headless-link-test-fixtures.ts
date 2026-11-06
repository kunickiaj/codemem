import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { hashHeadlessUserCode } from "./coordinator-auth-link-headless.js";
import { type Backend, review, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { buildCanonicalRequest, SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

// Fixture-only values: the code, proofs and keys exist only in these tests.
export const NOW = 1_791_028_800_000;
export const ORIGIN = "https://app.example.test";
export const ROOT = "/v1/auth/headless-link-attempts";
export const ATTEMPT = "headless-a";
export const USER_CODE = "BCDFGHJK";
export const SUBJECT = "subject-headless";
export const RUNTIME_PROOF = Buffer.alloc(32, 17).toString("base64url");
export const proofHash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");

export function deviceKey(deviceId: string) {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
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
export type DeviceKey = ReturnType<typeof deviceKey>;

export function signedHeaders(key: DeviceKey, method: string, path: string, body = "") {
	const timestamp = String(NOW / 1000);
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

const CONFIG = {
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	revision: "a".repeat(64),
	redirectUri: PROVIDER.redirectUri,
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};

/** An attested device A with a display name and an unattested device B, both in group-a. */
async function enrollDevices(store: ReturnType<typeof setupStore>["store"]) {
	const keyA = deviceKey("device-a");
	const keyB = deviceKey("device-b");
	await store.createGroup("group-a");
	await store.enrollDevice("group-a", { ...keyA, displayName: "Build box" });
	await store.enrollDevice("group-a", keyB);
	const attested = await store.createAuthControllerAttestation(
		review({ deviceId: keyA.deviceId, publicKey: keyA.publicKey, fingerprint: keyA.fingerprint }),
	);
	expect(attested.kind).toBe("created");
	return { keyA, keyB };
}

/** The browser half against a fixture Google that signs SUBJECT in with a verified email. */
async function composeBrowserAuth(store: ReturnType<typeof setupStore>["store"]) {
	const oidc = oidcFixture({ issuer: CONFIG.issuer });
	Object.assign(oidc.claims, {
		sub: SUBJECT,
		email: "ada@example.test",
		email_verified: true,
		name: "Ada Example",
	});
	const result = await createCoordinatorBrowserAuth(
		captureCoordinatorBrowserAuthOptions({
			config: CONFIG,
			csrfKey: await importBrowserCsrfKey(randomBytes(32)),
			oidcOptions: { fetch: oidc.fetch },
		}),
		store,
		createInMemoryRequestRateLimiter({ now: () => NOW }),
	);
	if (!result.ok) throw new Error("fixture_composition_failed");
	return { oidc, auth: result.auth };
}

/** Devices A and B, and a coordinator app with the browser half ready. */
export async function setupHeadlessDevice(
	backend: Backend = "SQLite",
	options: { readLimit?: number; clientAddress?: boolean } = {},
) {
	const f = setupStore(backend, { authClock: () => NOW });
	// HTTP closes the store after each request; keep this in-memory database open for assertions.
	vi.spyOn(f.store, "close").mockResolvedValue(undefined);
	const { keyA, keyB } = await enrollDevices(f.store);
	const { oidc, auth } = await composeBrowserAuth(f.store);
	const app = createCoordinatorApp({
		storeFactory: () => f.store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: async (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		...(options.readLimit ? { requestRateLimit: { readLimit: options.readLimit } } : {}),
		browserAuth: {
			kind: "ready",
			auth,
			storeFactory: () => f.store,
			clientKey: () => "client-a",
			...(options.clientAddress === false ? {} : { clientAddress: () => "203.0.113.7" }),
		},
	});
	const signed = (key: DeviceKey, method: string, path: string, value?: unknown) => {
		const body = value === undefined ? "" : JSON.stringify(value);
		return app.request(`${ORIGIN}${path}`, {
			method,
			headers: signedHeaders(key, method, path, body),
			...(method === "GET" ? {} : { body }),
		});
	};
	return { ...f, cfg: CONFIG, oidc, app, keyA, keyB, signed };
}
export type HeadlessDeviceFixture = Awaited<ReturnType<typeof setupHeadlessDevice>>;

export async function createBody(overrides: Record<string, unknown> = {}) {
	return {
		group_id: "group-a",
		identity_id: "identity-a",
		authority: "controller_attestation",
		attempt_id: ATTEMPT,
		runtime_verifier_hash: proofHash(RUNTIME_PROOF),
		user_code_hash: await hashHeadlessUserCode(USER_CODE),
		...overrides,
	};
}

export function finalizeBody(
	f: HeadlessDeviceFixture,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		purpose: "coordinator-account-link-v1",
		coordinator_id: f.cfg.coordinatorId,
		attempt_id: ATTEMPT,
		group_id: "group-a",
		identity_id: "identity-a",
		device_id: f.keyA.deviceId,
		fingerprint: f.keyA.fingerprint,
		// Headless confirmation stores the runtime verifier as the completion proof.
		runtime_verifier: RUNTIME_PROOF,
		completion: RUNTIME_PROOF,
		approved_issuer: f.cfg.issuer,
		approved_subject: SUBJECT,
		...overrides,
	};
}

function formFields(html: string, action?: string) {
	let markup = html;
	if (action)
		markup =
			html.match(new RegExp(`<form[^>]+action="${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1] ?? "";
	return Object.fromEntries(
		[...markup.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
	);
}
function cookieOf(response: Response) {
	return (
		response.headers
			.getSetCookie()
			.find((value) => !value.includes("Max-Age=0"))
			?.split(";")[0] ?? ""
	);
}
function postForm(
	f: HeadlessDeviceFixture,
	path: string,
	body: Record<string, string>,
	cookie: string,
) {
	return f.app.request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
}

/** The person enters the code, signs in with Google, and approves on the consent page. */
export async function approveInBrowser(f: HeadlessDeviceFixture, code = USER_CODE) {
	const page = await f.app.request(`${ORIGIN}/auth/link/device`);
	const started = await postForm(
		f,
		"/auth/link/device",
		{ ...formFields(await page.text()), user_code: code },
		cookieOf(page),
	);
	const html = await started.text();
	const href = html.match(/href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/)?.[1];
	if (!href) return { approved: null, startedHtml: html };
	const binder = cookieOf(started);
	const url = f.oidc.authorize(new URL(href.replaceAll("&amp;", "&")));
	const consent = await f.app.fetch(new Request(url, { headers: { cookie: binder } }));
	const approve = formFields(await consent.text(), "/auth/link/device/confirm");
	const approved = await postForm(f, "/auth/link/device/confirm", approve, binder);
	return { approved, startedHtml: html };
}

export function linkRows(f: HeadlessDeviceFixture) {
	return f.db
		.prepare(
			`SELECT l.link_id, l.subject, l.identity_id, p.attempt_id AS provenance_attempt
			 FROM coordinator_auth_account_links l LEFT JOIN coordinator_headless_link_provenance p
			 ON p.coordinator_id = l.coordinator_id AND p.link_id = l.link_id`,
		)
		.all() as {
		link_id: string;
		subject: string;
		identity_id: string;
		provenance_attempt: string | null;
	}[];
}
