import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as proof from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { clearBrowserCookie, issueBrowserCookie } from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import {
	confirmationScope,
	prepareConfirmation,
} from "./coordinator-device-rejoin-confirmation-test-harness.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

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
const now = confirmationScope.now;
const secret = new Uint8Array(32).fill(6);
const startCode = encodeCoordinatorAuthProof32(secret);
const attemptId = confirmationScope.attemptId;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	vi.restoreAllMocks();
});

async function fixture(kind: Backend) {
	vi.spyOn(Date, "now").mockReturnValue(now);
	const { db, store } = setupStore(kind, { authClock: () => now });
	closers.push(async () => {
		await store.close();
		if (db.open) db.close();
	});
	await prepareConfirmation(
		{
			proof: {
				...proof,
				controllerLinkEvidenceSql: (pins) =>
					proof.controllerLinkEvidenceSql(pins).replaceAll(confirmationScope.issuer, config.issuer),
			},
			first: async <T>({ sql, values }: AuthLinkStatement) =>
				(db.prepare(sql).get(...values) as T | undefined) ?? null,
			run: async (sql, ...values) => db.prepare(sql).run(...values),
			changed: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
		},
		{
			browserStartHash: await hashCoordinatorAuthProofBytes32(secret),
			scope: {
				...confirmationScope,
				issuer: config.issuer,
				origin,
				redirectUri: config.redirectUri,
			},
		},
	);
	const oidc = oidcFixture({ issuer: config.issuer });
	oidc.claims.sub = "private-subject";
	const ownerCallback = vi.fn(async () => new Response("Owner enrollment callback"));
	const readRejoinBackend = vi.spyOn(store, "readDeviceRejoinBackend");
	const snapshot = captureCoordinatorBrowserAuthOptions({
		config,
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
		oidcOptions: { fetch: oidc.fetch },
		ownerEnrollment: async () => ({ handle: async () => null, handleCallback: ownerCallback }),
	});
	const created = await createCoordinatorBrowserAuth(
		snapshot,
		store,
		createInMemoryRequestRateLimiter({ now: () => now }),
	);
	if (!created.ok) throw new Error(`browser auth: ${created.error}`);
	const app = new Hono();
	created.auth.register(app, () => "client-a");
	return { app, db, oidc, ownerCallback, readRejoinBackend };
}

const cookie = (r: Response) => r.headers.getSetCookie()[0]?.split(";")[0] ?? "";
const field = (html: string, name: string) =>
	new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

function post(app: Hono, path: string, binder: string, values: Record<string, string>) {
	return app.request(`${origin}${path}`, {
		method: "POST",
		headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(values).toString(),
	});
}

async function authorize(f: Awaited<ReturnType<typeof fixture>>) {
	const start = await f.app.request(
		`${origin}/auth/rejoin/start?attempt_id=${attemptId}&start_code=${startCode}`,
	);
	expect(start.status).toBe(200);
	expect(start.headers.get("Cache-Control")).toContain("no-store");
	const html = await start.text();
	const form = { attempt_id: attemptId, start_code: startCode, csrf: field(html, "csrf") };
	const rejected = await post(f.app, "/auth/rejoin/start", cookie(start), {
		...form,
		csrf: "wrong",
	});
	expect(rejected.status).toBe(403);
	const claimed = await post(f.app, "/auth/rejoin/start", cookie(start), form);
	expect(claimed.status).toBe(200);
	const url = /content="0;url=([^"]+)"/.exec(await claimed.text())?.[1]?.replaceAll("&amp;", "&");
	if (!url) throw new Error("Missing Google authorization URL");
	expect(new URL(url).searchParams.get("prompt")).toBe("select_account");
	return { transactionCookie: cookie(claimed), callbackUrl: f.oidc.authorize(url).href };
}

function authorityRows(db: Awaited<ReturnType<typeof fixture>>["db"]) {
	return [
		"coordinator_auth_account_links",
		"coordinator_identity_group_grants",
		"coordinator_device_ownership_bindings",
		"coordinator_device_removals",
		"coordinator_device_rejoin_audit_log",
		"enrolled_devices",
	].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

describe.each(["SQLite", "D1"] as const)("mounted rejoin browser (%s)", (kind) => {
	it("reuses ready browser handlers for subsequent requests, including an unauthenticated POST", async () => {
		const f = await fixture(kind);
		const url = `${origin}/auth/rejoin/start?attempt_id=${attemptId}&start_code=${startCode}`;
		expect((await f.app.request(url)).status).toBe(200);
		expect(f.readRejoinBackend).toHaveBeenCalledOnce();

		expect((await f.app.request(url)).status).toBe(200);
		expect((await post(f.app, "/auth/rejoin/start", "", { attempt_id: attemptId })).status).toBe(
			403,
		);
		expect(f.readRejoinBackend).toHaveBeenCalledOnce();
	});

	it("consumes the rejoin callback before owner dispatch and confirms only the reviewed browser", async () => {
		const f = await fixture(kind);
		const { transactionCookie, callbackUrl } = await authorize(f);
		const review = await f.app.request(callbackUrl, { headers: { cookie: transactionCookie } });
		expect(review.status).toBe(200);
		expect(review.headers.getSetCookie()).toEqual([]);
		const html = await review.text();
		expect(html).toContain("user@example.test");
		expect(html).toContain("group-a");
		expect(f.ownerCallback).not.toHaveBeenCalled();
		const fields = {
			attempt_id: attemptId,
			confirmation_hash: field(html, "confirmation_hash"),
			csrf: field(html, "csrf"),
		};
		expect(
			(
				await post(f.app, "/auth/rejoin/confirm", transactionCookie, {
					...fields,
					confirmation_hash: "9".repeat(64),
				})
			).status,
		).toBe(403);
		const confirmed = await post(f.app, "/auth/rejoin/confirm", transactionCookie, fields);
		expect(confirmed.status).toBe(200);
		const href = /href="(http:\/\/127[^"]+)"/
			.exec(await confirmed.text())?.[1]
			?.replaceAll("&amp;", "&");
		const returned = new URL(href ?? "");
		expect(returned.searchParams.get("attempt_id")).toBe(attemptId);
		expect(returned.searchParams.get("confirmation")).toBe(fields.confirmation_hash);
		expect(returned.searchParams.get("completion")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect((await post(f.app, "/auth/rejoin/confirm", transactionCookie, fields)).status).toBe(403);
	});

	it("ends the browser ceremony without changing authority when no destination qualifies", async () => {
		const f = await fixture(kind);
		f.db.prepare("UPDATE groups SET archived_at = 'archived'").run();
		const { transactionCookie, callbackUrl } = await authorize(f);
		const authority = authorityRows(f.db);
		const review = await f.app.request(callbackUrl, { headers: { cookie: transactionCookie } });
		const html = await review.text();
		expect(review.status).toBe(200);
		expect(html).toContain("group-a: Archived");
		expect(html).toContain("refused=no_destination");
		expect(html).not.toContain('action="/auth/rejoin/confirm"');
		expect(f.ownerCallback).not.toHaveBeenCalled();
		expect(authorityRows(f.db)).toEqual(authority);

		const next = `${origin}/auth/rejoin/start?attempt_id=next-attempt&start_code=${startCode}`;
		const stale = await f.app.request(next, { headers: { cookie: transactionCookie } });
		expect(stale.status).toBe(409);
		expect(review.headers.getSetCookie()).toEqual([clearBrowserCookie("transaction")]);
		// Browsers omit the expired transaction cookie on the next request.
		expect((await f.app.request(next)).status).toBe(200);
	});

	it("leaves a matching owner-only transaction for the owner callback", async () => {
		const f = await fixture(kind);
		const state = "s".repeat(43);
		const binder = await issueBrowserCookie("transaction");
		f.db
			.prepare(`INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,
 auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms,start_order)
 VALUES (?,?,'owner_enroll',?,?,?,?,?,?,'pending',?,?,?,?,1)`)
			.run(
				config.coordinatorId,
				"2".repeat(64),
				attemptId,
				createHash("sha256").update(state).digest("hex"),
				binder.cookieHash,
				config.issuer,
				config.revision,
				config.redirectUri,
				"n".repeat(43),
				"v".repeat(43),
				now,
				now + 10_000,
			);
		const response = await f.app.request(`${config.redirectUri}?code=owner&state=${state}`, {
			headers: { cookie: binder.setCookie.split(";")[0] },
		});
		expect(await response.text()).toBe("Owner enrollment callback");
		expect(f.ownerCallback).toHaveBeenCalledOnce();
		expect(f.db.prepare("SELECT state FROM coordinator_device_rejoin_attempts").get()).toEqual({
			state: "pending",
		});
	});
});
