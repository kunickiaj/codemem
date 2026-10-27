import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createDeviceRebindCeremony } from "./coordinator-device-rebind-ceremony.js";
import {
	type DeviceRebindPending,
	resumeDeviceRebind,
	runDeviceRebind,
} from "./coordinator-device-rebind-client.js";
import {
	browserForm,
	config,
	nativeBackend,
	ORIGIN,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));

const NOW = 1_791_028_800_000;
const CURRENT = "local:device-a";
const TARGET = "identity-target";
const REVIEW = "e".repeat(64);
const authConfig = config as unknown as CoordinatorAuthBrowserConfig;
const cleanups: Array<() => void> = [];
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

/** The browser's return to the device's loopback, as a top-level navigation. */
function navigate(destination: string) {
	if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(destination)) throw new Error("nonlocal request");
	return new Promise<number>((resolve, reject) => {
		const req = httpRequest(destination, { method: "GET" }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end();
	});
}

/** A local device with its key and database, and a coordinator where its Google account is linked to TARGET. */
async function clientFixture() {
	const dir = mkdtempSync(join(tmpdir(), "codemem-rebind-client-"));
	const dbPath = join(dir, "local.sqlite");
	const keysDir = join(dir, "keys");
	mkdirSync(keysDir);
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const fingerprint = fingerprintPublicKey(publicKey);
	writeFileSync(
		join(keysDir, "device.key"),
		keys.privateKey.export({ type: "pkcs8", format: "pem" }),
		{
			mode: 0o600,
		},
	);
	writeFileSync(join(keysDir, "device.key.pub"), publicKey);
	const local = new Database(dbPath);
	initTestSchema(local);
	local
		.prepare(
			"INSERT INTO sync_device (device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("device-a", publicKey, fingerprint, new Date(NOW).toISOString());
	local.close();
	const remote = setupStore("SQLite", { authClock: () => NOW });
	cleanups.push(() => {
		remote.db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	vi.spyOn(remote.store, "close").mockResolvedValue(undefined);
	for (const group of ["group-a", "group-b"]) {
		remote.db.prepare("INSERT INTO groups (group_id, created_at) VALUES (?, 'created')").run(group);
		remote.db
			.prepare(
				`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
				 VALUES (?, 'device-a', ?, ?, ?, 1, 'created')`,
			)
			.run(group, publicKey, fingerprint, group === "group-a" ? null : CURRENT);
	}
	remote.db
		.prepare(
			`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
			 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
			 VALUES (?, 'link-target', ?, 'subject-target', ?, 'link-attempt', ?, 1, 'device_claim', 'claim-target')`,
		)
		.run(config.coordinatorId, config.issuer, TARGET, config.revision);
	const app = createCoordinatorApp({
		storeFactory: () => remote.store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: async (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: {
			kind: "ready",
			auth: { storeConfig: authConfig, register: () => {} },
			storeFactory: () => remote.store,
			clientKey: () => "client",
		},
	});
	const material = {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		pkceVerifier: randomBytes(32).toString("base64url"),
	};
	const browser = createDeviceRebindCeremony({
		backend: nativeBackend(remote.db),
		config: authConfig,
		publicOrigin: ORIGIN,
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(17)),
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		client: {
			createAuthorizationRequest: async () => ({
				authorizationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test-client",
				material,
			}),
			verifyCallback: async () => ({
				ok: true,
				account: { issuer: config.issuer, subject: "subject-target" },
				profile: {},
			}),
		},
		now: () => NOW,
	});
	const paths: string[] = [];
	const transport = { finalize: (send: () => Promise<Response>) => send() };
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		const req = new Request(input, init);
		const path = new URL(req.url).pathname;
		paths.push(`${req.method} ${path}`);
		if (path.endsWith("/finalize")) return transport.finalize(() => app.fetch(req));
		return app.fetch(req);
	});
	return { remote, browser, material, fetch, paths, transport, dbPath, keysDir };
}
type Fixture = Awaited<ReturnType<typeof clientFixture>>;

/** The person signs in with Google and confirms; the browser returns to the loopback. */
async function confirmInBrowser(f: Fixture, url: string) {
	const start = new URL(url);
	const attemptId = start.searchParams.get("attempt_id") ?? "";
	const claimed = await f.browser.claimBrowser(
		(await browserForm(attemptId, start.searchParams.get("start_code") ?? "")).request(),
		"client",
	);
	if (claimed?.kind !== "browser_claimed") throw new Error(`claim: ${JSON.stringify(claimed)}`);
	const cookie = claimed.setCookies[0]?.split(";")[0] ?? "";
	const verified = await f.browser.verifyCallback(
		new Request(`${config.redirectUri}?state=${f.material.state}&code=c`, { headers: { cookie } }),
	);
	if (verified?.kind !== "verified") throw new Error(`callback: ${JSON.stringify(verified)}`);
	const confirmed = await f.browser.confirm(
		new Request(`${ORIGIN}/auth/rebind/confirm`, {
			method: "POST",
			headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ csrf: verified.csrf, attempt_id: attemptId }),
		}),
		"client",
		verified.confirmation.confirmationHash,
	);
	if (confirmed?.kind !== "confirmed") throw new Error(`confirm: ${JSON.stringify(confirmed)}`);
	const loopback = new URLSearchParams({
		attempt_id: attemptId,
		completion: confirmed.completionSecret,
		confirmation: verified.confirmation.confirmationHash,
	});
	expect(await navigate(`${confirmed.loopbackRedirect}?${loopback}`)).toBe(200);
}

function options(f: Fixture, extra: Partial<Parameters<typeof runDeviceRebind>[0]> = {}) {
	const recorded: DeviceRebindPending[] = [];
	return {
		recorded,
		input: {
			dbPath: f.dbPath,
			keysDir: f.keysDir,
			coordinatorUrl: ORIGIN,
			groupId: "group-a",
			currentIdentityId: CURRENT,
			reviewDigest: REVIEW,
			fetch: f.fetch,
			openBrowser: (url: string) => confirmInBrowser(f, url),
			recordPending: (pending: DeviceRebindPending) => {
				// Finalize must not have been sent yet.
				expect(f.paths.some((path) => path.endsWith("/finalize"))).toBe(false);
				recorded.push(pending);
			},
			...extra,
		},
	};
}

const bindings = (f: Fixture) =>
	f.remote.db
		.prepare("SELECT identity_id FROM coordinator_device_ownership_bindings")
		.pluck()
		.all();

describe("device rebind client", () => {
	it("records the attempt, then finalizes and returns the coordinator's receipt", async () => {
		// Arrange
		const f = await clientFixture();
		const run = options(f);
		// Act
		const outcome = await runDeviceRebind(run.input);
		// Assert
		expect(outcome).toMatchObject({
			kind: "finalized",
			receipt: { deviceId: "device-a", previousIdentityId: CURRENT, targetIdentityId: TARGET },
		});
		expect(run.recorded).toEqual([
			expect.objectContaining({
				previousIdentityId: CURRENT,
				targetIdentityId: TARGET,
				reviewDigest: REVIEW,
			}),
		]);
		expect(bindings(f)).toEqual([TARGET]);
	});

	it("returns the coordinator's refusal without opening the browser", async () => {
		// Arrange: the device's current Identity already has its own Google account.
		const f = await clientFixture();
		f.remote.db
			.prepare(
				`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
				 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
				 VALUES (?, 'link-current', ?, 'subject-current', ?, 'link-current-attempt', ?, 1, 'device_claim', 'claim-current')`,
			)
			.run(config.coordinatorId, config.issuer, CURRENT, config.revision);
		const openBrowser = vi.fn();
		// Act
		const outcome = await runDeviceRebind(options(f, { openBrowser }).input);
		// Assert
		expect(outcome).toEqual({
			kind: "refused",
			reason: "current_identity_linked",
			beforeBrowser: true,
		});
		expect(openBrowser).not.toHaveBeenCalled();
	});

	it("never finalizes when the attempt could not be recorded", async () => {
		// Arrange
		const f = await clientFixture();
		const recordPending = () => {
			throw new Error("disk full");
		};
		// Act
		const outcome = await runDeviceRebind(options(f, { recordPending }).input);
		// Assert
		expect(outcome).toEqual({ kind: "failed", error: "request_failed" });
		expect(f.paths.some((path) => path.endsWith("/finalize"))).toBe(false);
		expect(bindings(f)).toEqual([]);
	});

	it("reads status when the finalize reply is lost after the commit", async () => {
		// Arrange
		const f = await clientFixture();
		f.transport.finalize = async (send) => {
			await send();
			return new Response(JSON.stringify({ error: "device_rebind_unknown" }), { status: 503 });
		};
		// Act
		const outcome = await runDeviceRebind(options(f).input);
		// Assert
		expect(outcome).toMatchObject({ kind: "finalized", receipt: { targetIdentityId: TARGET } });
		expect(f.paths.filter((path) => path.endsWith("/finalize"))).toHaveLength(1);
	});

	it("reports unknown when finalize never arrives, until resume can tell", async () => {
		// Arrange
		const f = await clientFixture();
		f.transport.finalize = async () => {
			throw new TypeError("network down");
		};
		const run = options(f);
		// Act
		const outcome = await runDeviceRebind(run.input);
		const pending = run.recorded[0] as DeviceRebindPending;
		const resume = (now: number) => resumeDeviceRebind({ ...run.input, pending, now: () => now });
		const soon = await resume(NOW);
		const later = await resume(pending.expiresAtMs + 15 * 60_000 + 1);
		// Assert: nothing committed, and only an expired attempt counts as not committed.
		expect(outcome).toEqual({ kind: "unknown", pending });
		expect(soon).toEqual({ kind: "unknown" });
		expect(later).toEqual({ kind: "not_committed" });
		expect(bindings(f)).toEqual([]);
	});

	it("stops without finalizing when the person never returns from the browser", async () => {
		// Arrange
		const f = await clientFixture();
		const controller = new AbortController();
		// Act
		const outcome = await runDeviceRebind(
			options(f, { openBrowser: () => controller.abort(), signal: controller.signal }).input,
		);
		// Assert
		expect(outcome).toEqual({ kind: "failed", error: "browser_stopped" });
		expect(f.paths.some((path) => path.endsWith("/finalize"))).toBe(false);
	});
});

const refusedReply = (reason: string, status: number) =>
	new Response(JSON.stringify({ error: "device_rebind_refused", reason }), { status });

describe("device rebind client edge cases", () => {
	it("repeats finalize once after a retry refusal, then reads status", async () => {
		// Arrange: the coordinator asks to retry twice without committing.
		const f = await clientFixture();
		f.transport.finalize = async () => refusedReply("retry", 409);
		// Act
		const outcome = await runDeviceRebind(options(f).input);
		// Assert
		expect(outcome).toMatchObject({ kind: "unknown" });
		expect(f.paths.filter((path) => path.endsWith("/finalize"))).toHaveLength(2);
	});

	it("returns a finalize refusal that needs the person to act", async () => {
		// Arrange
		const f = await clientFixture();
		f.transport.finalize = async () => refusedReply("daily_limit", 403);
		// Act
		const outcome = await runDeviceRebind(options(f).input);
		// Assert
		expect(outcome).toEqual({ kind: "refused", reason: "daily_limit" });
		expect(f.paths.filter((path) => path.endsWith("/finalize"))).toHaveLength(1);
	});

	it("resumes only the exact switch this device recorded", async () => {
		// Arrange
		const f = await clientFixture();
		const run = options(f);
		await runDeviceRebind(run.input);
		const pending = run.recorded[0] as DeviceRebindPending;
		const resume = (patch: Partial<DeviceRebindPending>) =>
			resumeDeviceRebind({ ...run.input, pending: { ...pending, ...patch } });
		// Act / Assert
		expect(await resume({})).toMatchObject({ kind: "finalized" });
		expect(await resume({ targetIdentityId: "identity-other" })).toEqual({ kind: "unknown" });
		expect(await resume({ groupId: "group-b" })).toEqual({ kind: "unknown" });
		expect(await resume({ coordinatorOrigin: "https://other.example.test" })).toEqual({
			kind: "unknown",
		});
	});

	it("rejects a malformed review digest before any request", async () => {
		// Arrange
		const f = await clientFixture();
		// Act
		const outcome = await runDeviceRebind(options(f, { reviewDigest: "E".repeat(64) }).input);
		// Assert
		expect(outcome).toEqual({ kind: "failed", error: "device_unavailable" });
		expect(f.fetch).not.toHaveBeenCalled();
	});
});

describe("device rebind client when the browser refuses", () => {
	it("returns the browser's refusal at once, without recording or finalizing", async () => {
		// Arrange: Google sign-in found no link for the account; the page returns to the device.
		const f = await clientFixture();
		const openBrowser = async (url: string) => {
			const attemptId = new URL(url).searchParams.get("attempt_id") ?? "";
			const loopback = f.remote.db
				.prepare(
					"SELECT loopback_redirect FROM coordinator_device_rebind_attempts WHERE attempt_id = ?",
				)
				.pluck()
				.get(attemptId) as string;
			expect(await navigate(`${loopback}?attempt_id=${attemptId}&refused=account_not_linked`)).toBe(
				200,
			);
		};
		const run = options(f, { openBrowser });
		// Act
		const outcome = await runDeviceRebind(run.input);
		// Assert
		expect(outcome).toEqual({ kind: "refused", reason: "account_not_linked" });
		expect(run.recorded).toEqual([]);
		expect(f.paths.some((path) => path.endsWith("/finalize"))).toBe(false);
	});

	it("ignores a refusal that names a reason it doesn't know", async () => {
		// Arrange
		const f = await clientFixture();
		const controller = new AbortController();
		const openBrowser = async (url: string) => {
			const attemptId = new URL(url).searchParams.get("attempt_id") ?? "";
			const loopback = f.remote.db
				.prepare(
					"SELECT loopback_redirect FROM coordinator_device_rebind_attempts WHERE attempt_id = ?",
				)
				.pluck()
				.get(attemptId) as string;
			expect(await navigate(`${loopback}?attempt_id=${attemptId}&refused=made_up`)).toBe(400);
			controller.abort();
		};
		// Act
		const outcome = await runDeviceRebind(
			options(f, { openBrowser, signal: controller.signal }).input,
		);
		// Assert
		expect(outcome).toEqual({ kind: "failed", error: "browser_stopped" });
	});
});
