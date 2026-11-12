import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { seedConnectionOrder } from "./coordinator-account-schema-sqlite-test-fixtures.js";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import {
	HEADLESS_CODE_LIMITS_TABLE,
	HEADLESS_LINK_PROVENANCE_TABLE,
} from "./coordinator-auth-headless-schema.js";
import { type Backend, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import {
	createDeviceRebindCeremony,
	type DeviceRebindSigner,
} from "./coordinator-device-rebind-ceremony.js";
import { commitDeviceRebind } from "./coordinator-device-rebind-commit.js";
import { deviceRebindFinalMessage } from "./coordinator-device-rebind-proof.js";
import { type RebindFixture, rebindFixture } from "./coordinator-device-rebind-test-fixtures.js";
import { renderDeviceRebindReturnPage } from "./coordinator-device-rebind-view.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	browserForm,
	config,
	nativeBackend,
	ORIGIN,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { createD1AuthLinkBackend } from "./d1-coordinator-store.js";

const NOW = 1_791_028_800_000;
const TARGET = "identity-target";
const SUBJECT = "subject-target";
const BLOCKED =
	"This account was linked from a device without a browser. Link it once from a computer with a browser before moving other devices into it.";
const closers: Array<() => unknown> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

/** Marks a link as written by headless finalize, as the finalize batch would. */
function markHeadless(db: Database.Database, coordinatorId: string, linkId: string) {
	db.prepare(
		`INSERT INTO ${HEADLESS_LINK_PROVENANCE_TABLE} (coordinator_id, link_id, identity_id, issuer, subject,
		 attempt_id, created_at_ms) VALUES (?, ?, ?, 'https://accounts.example.test', ?, ?, 1)`,
	).run(coordinatorId, linkId, TARGET, SUBJECT, `headless-${linkId}`);
}
function dropHeadlessTables(db: Database.Database) {
	db.exec(
		`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}; DROP TABLE ${HEADLESS_LINK_PROVENANCE_TABLE};`,
	);
}

function registerCommit(kind: Backend) {
	describe(`${kind} rebind commit into a headless-linked account`, () => {
		let f: RebindFixture;
		const setup = async () => {
			f = await rebindFixture(kind);
			closers.push(() => f.close());
			return f;
		};

		it("refuses when the target link gained headless provenance after verification", async () => {
			// Arrange
			await setup();
			markHeadless(f.db, f.attempt.coordinator_id, "link-target");
			const before = f.effects();
			// Act
			const result = await commitDeviceRebind(f.input());
			// Assert
			expect(result).toEqual({ kind: "refused" });
			expect(f.effects()).toEqual(before);
		});

		it("commits when only another link is headless", async () => {
			// Arrange
			await setup();
			markHeadless(f.db, f.attempt.coordinator_id, "link-other");
			// Act
			const result = await commitDeviceRebind(f.input());
			// Assert
			expect(result).toMatchObject({ kind: "committed" });
		});

		it("commits as before on a coordinator without the headless tables", async () => {
			// Arrange
			await setup();
			dropHeadlessTables(f.db);
			// Act
			const result = await commitDeviceRebind(f.input());
			// Assert
			expect(result).toMatchObject({ kind: "committed" });
		});
	});
}

/** A device in two groups; the person's Google account is linked to TARGET by link-target. */
async function ceremonyFixture(kind: Backend) {
	const store = setupStore(kind, { authClock: () => NOW });
	closers.push(async () => {
		await store.store.close();
		if (store.db.open) store.db.close();
	});
	const { db } = store;
	const key = commitPendingKey();
	const fingerprint = createHash("sha256").update(key.publicKey).digest("hex");
	const signer: DeviceRebindSigner = {
		groupId: "group-a",
		deviceId: "device-work",
		publicKey: key.publicKey,
		fingerprint,
	};
	db.prepare("INSERT INTO groups (group_id, created_at) VALUES ('group-a', 'created')").run();
	db.prepare(
		`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
		 VALUES ('group-a', 'device-work', ?, ?, NULL, 1, 'created')`,
	).run(key.publicKey, fingerprint);
	db.prepare(
		`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
		 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
		 VALUES (?, 'link-target', ?, ?, ?, 'link-attempt', ?, 1, 'device_claim', 'claim-target')`,
	).run(config.coordinatorId, config.issuer, SUBJECT, TARGET, config.revision);
	// The seeded target link follows this coordinator's earlier browser starts.
	seedConnectionOrder(db, config.coordinatorId);
	const material = {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		pkceVerifier: randomBytes(32).toString("base64url"),
	};
	const ceremony = createDeviceRebindCeremony({
		backend: kind === "SQLite" ? nativeBackend(db) : createD1AuthLinkBackend(sqliteD1(db)),
		config: config as unknown as CoordinatorAuthBrowserConfig,
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
				account: { issuer: config.issuer, subject: SUBJECT },
				profile: {},
			}),
		},
		now: () => NOW,
	});
	return { db, signer, key, ceremony, material };
}
type CeremonyFixture = Awaited<ReturnType<typeof ceremonyFixture>>;

async function throughCallback(f: CeremonyFixture) {
	const code = randomBytes(32).toString("base64url");
	await f.ceremony.start(
		{
			attemptId: "rebind-a",
			signer: f.signer,
			currentIdentityId: "local:device-work",
			loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
			browserStartHash: createHash("sha256").update(Buffer.from(code, "base64url")).digest("hex"),
			reviewDigest: "e".repeat(64),
		},
		"client-a",
	);
	const claimed = await f.ceremony.claimBrowser(
		(await browserForm("rebind-a", code)).request(),
		"client-a",
	);
	if (claimed?.kind !== "browser_claimed") throw new Error(`claim: ${JSON.stringify(claimed)}`);
	const cookie = claimed.setCookies[0]?.split(";")[0] ?? "";
	const callback = await f.ceremony.verifyCallback(
		new Request(`${config.redirectUri}?state=${f.material.state}&code=provider-code`, {
			headers: { cookie },
		}),
	);
	return { callback, cookie };
}

function registerVerify(kind: Backend) {
	describe(`${kind} rebind verification into a headless-linked account`, () => {
		it("refuses at the Google callback and sends the device a reason it knows", async () => {
			// Arrange
			const f = await ceremonyFixture(kind);
			markHeadless(f.db, config.coordinatorId, "link-target");
			// Act
			const { callback } = await throughCallback(f);
			// Assert
			expect(callback).toMatchObject({
				kind: "refused",
				reason: "target_headless_linked",
				retired: true,
			});
			if (callback?.kind !== "refused" || !callback.returnTo) throw new Error("no return page");
			const page = await renderDeviceRebindReturnPage({
				reason: callback.reason,
				...callback.returnTo,
			});
			expect(page.body).toContain(BLOCKED);
			expect(page.body).toContain("refused=unavailable");
		});

		it("verifies normally on a coordinator without the headless tables", async () => {
			// Arrange
			const f = await ceremonyFixture(kind);
			dropHeadlessTables(f.db);
			// Act
			const { callback } = await throughCallback(f);
			// Assert
			expect(callback).toMatchObject({ kind: "verified" });
		});

		it("explains a finalize refused because the link became headless", async () => {
			// Arrange
			const f = await ceremonyFixture(kind);
			const { callback, cookie } = await throughCallback(f);
			if (callback?.kind !== "verified") throw new Error(`callback: ${JSON.stringify(callback)}`);
			const confirmed = await f.ceremony.confirm(
				new Request(`${ORIGIN}/auth/rebind/confirm`, {
					method: "POST",
					headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ csrf: callback.csrf, attempt_id: "rebind-a" }),
				}),
				"client-a",
				callback.confirmation.confirmationHash,
			);
			if (confirmed?.kind !== "confirmed") throw new Error(`confirm: ${JSON.stringify(confirmed)}`);
			markHeadless(f.db, config.coordinatorId, "link-target");
			const row = f.db
				.prepare("SELECT * FROM coordinator_device_rebind_attempts WHERE attempt_id = 'rebind-a'")
				.get() as Parameters<typeof deviceRebindFinalMessage>[0];
			// Act
			const finalized = await f.ceremony.finalize({
				attemptId: "rebind-a",
				signer: f.signer,
				completionSecret: confirmed.completionSecret,
				signature: f.key.sign(deviceRebindFinalMessage(row, confirmed.completionSecret)),
			});
			// Assert
			expect(finalized).toEqual({ kind: "refused", reason: "target_headless_linked" });
			expect(
				f.db.prepare("SELECT count(*) AS n FROM coordinator_device_ownership_bindings").get(),
			).toEqual({ n: 0 });
		});
	});
}

for (const kind of ["SQLite", "D1"] as const) {
	registerCommit(kind);
	registerVerify(kind);
}
