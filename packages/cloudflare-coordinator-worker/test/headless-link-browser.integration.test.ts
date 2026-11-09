import { env } from "cloudflare:workers";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatShortKeyFingerprint } from "../../core/src/coordinator-auth-key-fingerprint.js";
import { hashHeadlessUserCode } from "../../core/src/coordinator-auth-link-headless.js";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { createCloudflareCoordinatorWorker } from "../src/index.js";

const ORIGIN = "https://app.example.test";
const NOW = 1791028800000;
const CODE = "BCDFGHJK";
const ATTEMPT = "headless-worker-a";
const IP = "192.0.2.44";
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

function sshPublicKey() {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	return `ssh-ed25519 ${wire.toString("base64")}`;
}

/** An enrolled, controller-attested device with a pending headless attempt (device routes come later). */
async function setup() {
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
	const worker = createCloudflareCoordinatorWorker({
		now: () => new Date(NOW).toISOString(),
		browserAuth: {
			config,
			csrfKey: await importBrowserCsrfKey(crypto.getRandomValues(new Uint8Array(32))),
			oidcOptions: { fetch: oidc.fetch },
		},
	});
	const store = new D1CoordinatorStore(env.COORDINATOR_DB);
	const publicKey = sshPublicKey();
	const review = {
		coordinatorId: config.coordinatorId,
		groupId: crypto.randomUUID(),
		deviceId: crypto.randomUUID(),
		identityId: crypto.randomUUID(),
		attestationId: crypto.randomUUID(),
		reviewReceiptId: crypto.randomUUID(),
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		evidenceDigest: "b".repeat(64),
	};
	await store.createGroup(review.groupId);
	await store.enrollDevice(review.groupId, { ...review, displayName: "Build box" });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	const { groupId, deviceId, fingerprint } = review;
	expect(
		await store.createHeadlessAuthLinkAttempt(
			{
				authority: { kind: "controller_attestation" },
				attemptId: ATTEMPT,
				signer: { groupId, deviceId, publicKey, fingerprint },
				runtimeVerifierHash: "7".repeat(64),
				userCodeHash: await hashHeadlessUserCode(CODE),
			},
			config,
		),
	).toMatchObject({ kind: "created" });
	const request = (path: string | URL, init?: RequestInit) =>
		worker.fetch(new Request(new URL(path, ORIGIN), init), env);
	return { config, oidc, review, request };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

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
function post(f: Fixture, path: string, body: Record<string, string>, binder: string) {
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
async function attemptState(f: Fixture) {
	return env.COORDINATOR_DB.prepare(
		"SELECT state FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?",
	)
		.bind(f.config.coordinatorId, ATTEMPT)
		.first<{ state: string }>();
}

it("links a headless attempt from code entry through Google to device approval", async () => {
	// Arrange
	const f = await setup();
	const page = await f.request("/auth/link/device", { headers: { "CF-Connecting-IP": IP } });
	const started = await post(
		f,
		"/auth/link/device",
		{ ...fields(await page.text()), user_code: "bcdf-ghjk" },
		cookie(page),
	);
	const startedHtml = await started.text();
	const href = startedHtml.match(/href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/)?.[1];
	if (!href) throw new Error("provider_link_missing");
	const binder = cookie(started);
	const callback = await f.request(f.oidc.authorize(new URL(href.replaceAll("&amp;", "&"))), {
		headers: { cookie: binder },
	});
	const consent = await callback.text();
	const approve = fields(consent, "/auth/link/device/confirm");
	// Act
	const desktop = await post(f, "/auth/link/confirm", approve, binder);
	const desktopHtml = await desktop.text();
	const approved = await post(f, "/auth/link/device/confirm", approve, binder);
	const approvedHtml = await approved.text();
	const completion = await f.request(`/auth/link/complete?attempt_id=${ATTEMPT}`, {
		headers: { cookie: binder },
	});
	const completionHtml = await completion.text();
	const complete = await post(f, "/auth/link/complete", approve, binder);
	// Assert
	expect(started.status).toBe(200);
	expect(callback.status).toBe(200);
	expect(consent).toContain("Build box");
	expect(consent).toContain(f.review.groupId);
	expect(consent).toContain(formatShortKeyFingerprint(f.review.fingerprint));
	expect(consent).toContain("codemem coordinator account link --headless");
	expect(consent).not.toContain('action="/auth/link/confirm"');
	expect(approve.attempt_id).toBe(ATTEMPT);
	expect(desktop.status).toBe(409);
	expect(desktopHtml).toContain("Approve on the device page");
	expect(approved.status).toBe(200);
	expect(approvedHtml).toContain("Return to your device's terminal to finish.");
	expect(approved.headers.getSetCookie()).toEqual([]);
	expect(await attemptState(f)).toEqual({ state: "confirmed" });
	expect(completionHtml).toContain("Return to your device's terminal to finish.");
	expect(completionHtml).not.toContain("<form");
	expect(complete.status).toBe(403);
	expect(complete.headers.getSetCookie()).toEqual([]);
});
