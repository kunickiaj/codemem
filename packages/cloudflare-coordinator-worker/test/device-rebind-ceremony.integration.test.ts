import { env } from "cloudflare:workers";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { expect, it } from "vitest";
import type { CoordinatorAuthBrowserConfig } from "../../core/src/coordinator-auth-browser-transaction-contract.js";
import { issueBrowserCookie } from "../../core/src/coordinator-browser-credential.js";
import { importBrowserCsrfKey, issueBrowserCsrfToken } from "../../core/src/coordinator-browser-csrf.js";
import { createDeviceRebindCeremony } from "../../core/src/coordinator-device-rebind-ceremony.js";
import {
	type DeviceRebindAttempt,
	deviceRebindFinalMessage,
} from "../../core/src/coordinator-device-rebind-proof.js";
import { readDeviceRebindBackend } from "../../core/src/coordinator-device-rebind-schema.js";
import { createD1AuthLinkBackend } from "../../core/src/d1-coordinator-store.js";

const NOW = 1_791_028_800_000;
const ORIGIN = "https://app.example.test";
const config = {
	enabled: true,
	coordinatorId: "native-rebind-coordinator",
	issuer: "https://accounts.google.com",
	redirectUri: `${ORIGIN}/auth/callback`,
	revision: "a".repeat(64),
	clientId: "test-client",
	clientSecret: "test-secret",
};
const db = env.COORDINATOR_DB;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function deviceKey() {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return {
		publicKey,
		sign: (message: string) => sign(null, Buffer.from(message), keys.privateKey).toString("base64url"),
	};
}

it("native D1 runs the rebind ceremony from device start to the atomic commit", async () => {
	// Arrange: a device enrolled in two groups; the account is linked to the target Identity.
	const key = deviceKey();
	const signer = {
		groupId: "native-rebind-a",
		deviceId: "native-device",
		publicKey: key.publicKey,
		fingerprint: sha(key.publicKey),
	};
	await db.batch([
		...["native-rebind-a", "native-rebind-b"].flatMap((group) => [
			db.prepare("INSERT INTO groups (group_id, created_at) VALUES (?, 'created')").bind(group),
			db
				.prepare(`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, enabled, created_at)
				 VALUES (?, ?, ?, ?, 1, 'created')`)
				.bind(group, signer.deviceId, signer.publicKey, signer.fingerprint),
		]),
		db
			.prepare(`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
			 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
			 VALUES (?, 'native-link', ?, 'native-subject', 'native-target', 'native-link-attempt', ?, 1,
			 'device_claim', 'native-claim')`)
			.bind(config.coordinatorId, config.issuer, config.revision),
	]);
	const material = {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		pkceVerifier: randomBytes(32).toString("base64url"),
	};
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const scope = { publicOrigin: ORIGIN, store: config };
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
			verifyCallback: async () => ({
				ok: true,
				account: { issuer: config.issuer, subject: "native-subject" },
				profile: {},
			}),
		},
		now: () => NOW,
	});
	const form = (cookie: string, fields: Record<string, string>) =>
		new Request(`${ORIGIN}/auth/rebind`, {
			method: "POST",
			headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields),
		});
	const code = randomBytes(32).toString("base64url");
	// Act
	const started = await ceremony.start(
		{
			attemptId: "native-rebind",
			signer,
			currentIdentityId: "local:native-device",
			loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
			browserStartHash: createHash("sha256").update(Buffer.from(code, "base64url")).digest("hex"),
			reviewDigest: "e".repeat(64),
		},
		"client",
	);
	const startCookie = await issueBrowserCookie("start");
	const claimed = await ceremony.claimBrowser(
		form(startCookie.setCookie.split(";")[0] ?? "", {
			csrf: await issueBrowserCsrfToken(csrfKey, startCookie.secret, "start", scope),
			attempt_id: "native-rebind",
			start_code: code,
		}),
		"client",
	);
	if (claimed?.kind !== "browser_claimed") throw new Error(JSON.stringify(claimed));
	const transaction = claimed.setCookies[0]?.split(";")[0] ?? "";
	const verified = await ceremony.verifyCallback(
		new Request(`${config.redirectUri}?state=${material.state}&code=c`, { headers: { cookie: transaction } }),
	);
	if (verified?.kind !== "verified") throw new Error(JSON.stringify(verified));
	const confirmed = await ceremony.confirm(
		form(transaction, { csrf: verified.csrf, attempt_id: "native-rebind" }),
		"client",
		verified.confirmation.confirmationHash,
	);
	if (confirmed?.kind !== "confirmed") throw new Error(JSON.stringify(confirmed));
	const row = (await db
		.prepare("SELECT * FROM coordinator_device_rebind_attempts WHERE attempt_id = 'native-rebind'")
		.first()) as unknown as DeviceRebindAttempt;
	const finalized = await ceremony.finalize({
		attemptId: "native-rebind",
		signer,
		completionSecret: confirmed.completionSecret,
		signature: key.sign(deviceRebindFinalMessage(row, confirmed.completionSecret)),
	});
	// Assert
	expect(started).toMatchObject({ kind: "started" });
	expect(verified.confirmation.groupsWithoutAccess).toEqual(["native-rebind-a", "native-rebind-b"]);
	expect(finalized).toMatchObject({ kind: "finalized", receipt: { targetIdentityId: "native-target" } });
	const identities = await db
		.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id = ? ORDER BY group_id")
		.bind(signer.deviceId)
		.all<{ identity_id: string }>();
	expect(identities.results.map((r) => r.identity_id)).toEqual(["native-target", "native-target"]);
});

it("native D1 migrations leave the rebind tables the device routes require", async () => {
	// Arrange
	const backend = createD1AuthLinkBackend(db);
	// Act / Assert: the routes report not found unless this check sees the migrated tables.
	expect(await readDeviceRebindBackend(backend)).toBe(backend);
});
