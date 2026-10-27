import { createHash, randomBytes, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { headers, keypair } from "./coordinator-account-change-http-test-fixtures.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { type Backend, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createDeviceRebindCeremony } from "./coordinator-device-rebind-ceremony.js";
import {
	type DeviceRebindAttempt,
	deviceRebindFinalMessage,
} from "./coordinator-device-rebind-proof.js";
import { insertOwnDeviceClaim } from "./coordinator-device-rebind-test-fixtures.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	browserForm,
	config,
	nativeBackend,
	ORIGIN,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { createD1AuthLinkBackend } from "./d1-coordinator-store.js";
import { verifySignature } from "./sync-auth.js";

const NOW = 1_791_028_800_000;
const CURRENT = "local:device-work";
const TARGET = "identity-target";
const ROOT = "/v1/auth/rebind-attempts";
const authConfig = config as unknown as CoordinatorAuthBrowserConfig;
const closers: Array<() => unknown> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	vi.restoreAllMocks();
});

/** A device in two groups; its person's Google account is linked to TARGET. */
function seed(db: ReturnType<typeof setupStore>["db"], device: ReturnType<typeof keypair>) {
	for (const group of ["group-a", "group-b"]) {
		db.prepare("INSERT OR IGNORE INTO groups (group_id, created_at) VALUES (?, 'created')").run(
			group,
		);
		db.prepare(
			`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
			 VALUES (?, ?, ?, ?, ?, 1, 'created')`,
		).run(
			group,
			device.deviceId,
			device.publicKey,
			device.fingerprint,
			group === "group-a" ? null : CURRENT,
		);
	}
	db.prepare(
		`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
		 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
		 VALUES (?, 'link-target', ?, 'subject-target', ?, 'link-attempt', ?, 1, 'device_claim', 'claim-target')`,
	).run(config.coordinatorId, config.issuer, TARGET, config.revision);
}

async function rebindHttpFixture(kind: Backend) {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const base = setupStore(kind, { authClock: () => NOW });
	closers.push(() => (base.db.open ? base.db.close() : undefined));
	vi.spyOn(base.store, "close").mockResolvedValue(undefined);
	const device = keypair("device-work");
	seed(base.db, device);
	const app = createCoordinatorApp({
		storeFactory: () => base.store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: {
			kind: "ready",
			auth: { storeConfig: authConfig, register: () => {} },
			storeFactory: () => base.store,
			clientKey: () => "client",
		},
	});
	const send = (method: string, path: string, data?: unknown, key = device) => {
		const body = data === undefined ? "" : JSON.stringify(data);
		return app.request(`${ORIGIN}${path}`, {
			method,
			headers: headers(key, method, path, body),
			...(body ? { body } : {}),
		});
	};
	const material = {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		pkceVerifier: randomBytes(32).toString("base64url"),
	};
	// The browser half runs in-process against the same database; its routes ship separately.
	const browser = createDeviceRebindCeremony({
		backend:
			kind === "SQLite" ? nativeBackend(base.db) : createD1AuthLinkBackend(sqliteD1(base.db)),
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
	return { ...base, device, send, browser, material };
}
type Fixture = Awaited<ReturnType<typeof rebindHttpFixture>>;

const startCode = randomBytes(32).toString("base64url");
const startBody = (extra: Record<string, unknown> = {}) => ({
	group_id: "group-a",
	identity_id: CURRENT,
	attempt_id: "rebind-a",
	browser_start_hash: createHash("sha256")
		.update(Buffer.from(startCode, "base64url"))
		.digest("hex"),
	loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
	review_digest: "e".repeat(64),
	...extra,
});
const statusPath = `${ROOT}/rebind-a?group_id=group-a`;

/** Browser claim, Google callback, and confirmation; returns what the loopback delivers. */
async function confirmInBrowser(f: Fixture, beforeConfirm?: () => Promise<void>) {
	const claimed = await f.browser.claimBrowser(
		(await browserForm("rebind-a", startCode)).request(),
		"client",
	);
	if (claimed?.kind !== "browser_claimed") throw new Error(`claim: ${JSON.stringify(claimed)}`);
	const cookie = claimed.setCookies[0]?.split(";")[0] ?? "";
	const verified = await f.browser.verifyCallback(
		new Request(`${config.redirectUri}?state=${f.material.state}&code=provider-code`, {
			headers: { cookie },
		}),
	);
	if (verified?.kind !== "verified") throw new Error(`callback: ${JSON.stringify(verified)}`);
	await beforeConfirm?.();
	const confirmed = await f.browser.confirm(
		new Request(`${ORIGIN}/auth/rebind/confirm`, {
			method: "POST",
			headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ csrf: verified.csrf, attempt_id: "rebind-a" }),
		}),
		"client",
		verified.confirmation.confirmationHash,
	);
	if (confirmed?.kind !== "confirmed") throw new Error(`confirm: ${JSON.stringify(confirmed)}`);
	return {
		completion: confirmed.completionSecret,
		confirmation: verified.confirmation.confirmationHash,
	};
}

/**
 * Signs only what a device has: its key, its own start inputs, the start
 * response's pins, the status target, and the loopback's completion and
 * confirmation. Never the stored attempt row.
 */
async function finalizeBody(
	f: Fixture,
	started: Record<string, unknown>,
	loopback: { completion: string; confirmation: string },
) {
	const status = await (await f.send("GET", statusPath)).json();
	const signed = {
		coordinator_id: started.coordinator_id,
		origin: started.origin,
		issuer: started.issuer,
		auth_config_revision: started.auth_config_revision,
		attempt_id: "rebind-a",
		device_id: f.device.deviceId,
		public_key: f.device.publicKey,
		key_id: await ed25519KeyId(f.device.publicKey),
		fingerprint: f.device.fingerprint,
		current_identity_id: CURRENT,
		target_identity_id: status.target_identity_id,
		review_digest: startBody().review_digest,
		confirmation_hash: loopback.confirmation,
	} as DeviceRebindAttempt;
	const message = Buffer.from(deviceRebindFinalMessage(signed, loopback.completion));
	return {
		group_id: "group-a",
		completion: loopback.completion,
		signature: sign(null, message, f.device.privateKey).toString("base64url"),
	};
}

/** The device's current Identity has its own Google link, and this device holds its own claim. */
async function linkCurrentWithOwnClaim(f: Fixture) {
	f.db
		.prepare(
			`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
			 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
			 VALUES (?, 'link-current', ?, 'subject-current', ?, 'link-current-attempt', ?, 1, 'device_claim', 'claim-current')`,
		)
		.run(config.coordinatorId, config.issuer, CURRENT, config.revision);
	await insertOwnDeviceClaim(f.db, {
		coordinatorId: config.coordinatorId,
		issuer: config.issuer,
		revision: config.revision,
		identityId: CURRENT,
		deviceId: "device-work",
	});
}

describe.each(["SQLite", "D1"] as const)("signed device rebind routes (%s)", (kind) => {
	it("starts, reports status, and finalizes a rebind", async () => {
		// Arrange
		const f = await rebindHttpFixture(kind);
		// Act
		const started = await f.send("POST", ROOT, startBody());
		const startedJson = await started.json();
		const pending = await (await f.send("GET", statusPath)).json();
		let verified: unknown;
		const loopback = await confirmInBrowser(f, async () => {
			verified = await (await f.send("GET", statusPath)).json();
		});
		const confirmed = await (await f.send("GET", statusPath)).json();
		const body = await finalizeBody(f, startedJson, loopback);
		const finalized = await f.send("POST", `${ROOT}/rebind-a/finalize`, body);
		const replayed = await f.send("POST", `${ROOT}/rebind-a/finalize`, body);
		const done = await (await f.send("GET", statusPath)).json();
		// Assert
		expect(started.status).toBe(200);
		expect(startedJson).toEqual({
			attempt_id: "rebind-a",
			expires_at_ms: NOW + 600_000,
			coordinator_id: config.coordinatorId,
			origin: ORIGIN,
			issuer: config.issuer,
			auth_config_revision: config.revision,
		});
		expect(pending).toEqual({
			state: "pending",
			expires_at_ms: NOW + 600_000,
			target_identity_id: null,
			receipt: null,
		});
		// The target stays hidden until the person confirms in the browser.
		expect(verified).toMatchObject({ state: "oidc_verified", target_identity_id: null });
		expect(confirmed).toMatchObject({ state: "confirmed", target_identity_id: TARGET });
		expect(finalized.status).toBe(200);
		const receipt = {
			attempt_id: "rebind-a",
			device_id: "device-work",
			previous_identity_id: CURRENT,
			target_identity_id: TARGET,
			enrollment_count: 2,
		};
		expect(await finalized.json()).toMatchObject({ state: "finalized", receipt });
		expect(await replayed.json()).toMatchObject({ state: "prior_commit", receipt });
		expect(done).toMatchObject({ state: "finalized", receipt });
	});

	it("names the refusal so the device can tell the person what to do", async () => {
		// Arrange: the device's current Identity already has its own Google account.
		const f = await rebindHttpFixture(kind);
		await linkCurrentWithOwnClaim(f);
		// Act
		const response = await f.send("POST", ROOT, startBody());
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "device_rebind_refused",
			reason: "current_identity_linked",
		});
	});

	it("shows an attempt only to the device that started it", async () => {
		// Arrange
		const f = await rebindHttpFixture(kind);
		const other = keypair("device-other");
		await f.store.enrollDevice("group-a", other);
		await f.send("POST", ROOT, startBody());
		// Act
		const response = await f.send("GET", statusPath, undefined, other);
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ reason: "unavailable" });
	});

	it.each([
		["an extra field", { extra: "x" }],
		["a start code instead of its hash", { browser_start_hash: startCode }],
		["a malformed review digest", { review_digest: "E".repeat(64) }],
	])("rejects a start with %s before reading rebind storage", async (_case, patch) => {
		// Arrange
		const f = await rebindHttpFixture(kind);
		// Act
		const response = await f.send("POST", ROOT, startBody(patch));
		// Assert
		expect(response.status).toBe(400);
		expect(
			f.db.prepare("SELECT count(*) FROM coordinator_device_rebind_attempts").pluck().get(),
		).toBe(0);
	});

	it("rejects a request signed by a key the device never enrolled", async () => {
		// Arrange
		const f = await rebindHttpFixture(kind);
		// Act
		const response = await f.send("POST", ROOT, startBody(), keypair("device-work"));
		// Assert
		expect(response.status).toBe(401);
	});

	it.each([
		["the rebind tables are missing", "DROP TABLE coordinator_device_rebind_audit_log"],
		[
			"the attempts table predates the review digest at start",
			`DROP TABLE coordinator_device_rebind_attempts;
			 CREATE TABLE coordinator_device_rebind_attempts (attempt_id TEXT PRIMARY KEY)`,
		],
	])("reports not found when %s", async (_case, sql) => {
		// Arrange
		const f = await rebindHttpFixture(kind);
		f.db.exec(sql);
		// Act
		const response = await f.send("POST", ROOT, startBody());
		// Assert
		expect(response.status).toBe(404);
	});

	it("reports an unknown outcome when storage fails mid-step", async () => {
		// Arrange
		const f = await rebindHttpFixture(kind);
		const started = await (await f.send("POST", ROOT, startBody())).json();
		const body = await finalizeBody(f, started, await confirmInBrowser(f));
		f.db.exec("DROP TABLE coordinator_device_ownership_bindings");
		// Act
		const response = await f.send("POST", `${ROOT}/rebind-a/finalize`, body);
		// Assert
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "device_rebind_unknown" });
	});
});
