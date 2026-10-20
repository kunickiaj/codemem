import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
	changeFixture,
	changeTable,
	protectedTables,
	config as storeConfig,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import {
	ACCOUNT_CHANGE_BROWSER_PATHS,
	type AccountChangeBrowserReaders,
	createCoordinatorAccountChangeBrowser,
} from "./coordinator-account-change-browser.js";
import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import * as browserPages from "./coordinator-auth-browser-view.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	decodeCoordinatorAuthProof32,
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { AuthSessionOperations } from "./coordinator-auth-session.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { createCoordinatorBrowserAuthCallback } from "./coordinator-browser-auth-callback.js";
import {
	BROWSER_COOKIE_NAMES,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey, issueBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const config = {
	...storeConfig,
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};
const origin = new URL(config.redirectUri).origin;
const startUrl = `${origin}${ACCOUNT_CHANGE_BROWSER_PATHS.start}`;
const confirmUrl = `${origin}${ACCOUNT_CHANGE_BROWSER_PATHS.confirm}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const databases: ReturnType<typeof setupStore>["db"][] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fields(body: string) {
	return new URLSearchParams(
		[...body.matchAll(/name="([^"]+)" value="([^"]+)"/g)].map((match) => [
			match[1] ?? "",
			match[2] ?? "",
		]),
	);
}
function link(body: string) {
	const href = body.match(/href="([^"]+)"/)?.[1];
	if (!href) throw new Error("missing hosted link");
	return href.replaceAll("&amp;", "&");
}
function post(url: string, cookie: string, body: URLSearchParams, requestOrigin = origin) {
	return new Request(url, {
		method: "POST",
		headers: { origin: requestOrigin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body,
	});
}
async function storageFixture() {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1791028800000);
	const base = setupStore("SQLite", { authClock: () => 1791028800000 });
	databases.push(base.db);
	const db = sqliteD1(base.db),
		batch = db.batch?.bind(db);
	if (!batch) throw new Error("fixture batch missing");
	const backend: AuthLinkBackend = {
		first: ({ sql, values }) =>
			db
				.prepare(sql)
				.bind(...values)
				.first(),
		run: async ({ sql, values }) => base.db.prepare(sql).run(...values).changes,
		batch: (statements) =>
			batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values))),
	};
	// The birth helper currently pins a synthetic issuer globally. Scope its
	// override to seeding only; all HTTP is still the signed synthetic provider.
	const originalIssuer = storeConfig.issuer;
	storeConfig.issuer = config.issuer;
	let f: Awaited<ReturnType<typeof changeFixture>>;
	try {
		f = await changeFixture(base.store, backend);
	} finally {
		storeConfig.issuer = originalIssuer;
	}
	return { base, backend, f };
}
async function fixture(
	intent: "refresh" | "disconnect" = "disconnect",
	destination = "http://127.0.0.1:4567/codemem/auth/complete",
) {
	const { base, backend, f } = await storageFixture();
	const sessions = new AuthSessionOperations(backend, () => f.clock.now);
	const oidc = oidcFixture({ issuer: config.issuer });
	oidc.claims.sub = "account-A";
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(19));
	const limiter = createInMemoryRequestRateLimiter({ now: () => f.clock.now });
	const readers: AccountChangeBrowserReaders = {
		readStart: f.operations.readStart.bind(f.operations),
		readManagementActivity: f.operations.readManagementActivity.bind(f.operations),
		readBrowserBinding: f.operations.readBrowserBinding.bind(f.operations),
	};
	const options = {
		config,
		csrfKey,
		operations: f.operations,
		readers,
		existing: new CoordinatorAuthBrowserTransactions(backend, () => f.clock.now),
		limiter,
		oidcOptions: { fetch: oidc.fetch },
	};
	const result = await createCoordinatorAccountChangeBrowser(options);
	if (!result.ok) throw new Error(result.error);
	const session = await issueBrowserCookie("session");
	base.db
		.prepare("UPDATE coordinator_auth_sessions SET credential_hash = ?")
		.run(session.cookieHash);
	const sessionHeader = session.setCookie.split(";")[0] ?? "";
	expect(await sessions.readAuthSession(session.cookieHash, config)).not.toBeNull();
	const startCode = encodeCoordinatorAuthProof32(new Uint8Array(32).fill(1));
	const signedInput = {
		...f.request(1, intent),
		browserStartHash: await hashCoordinatorAuthProofBytes32(new Uint8Array(32).fill(1)),
		loopbackRedirect: destination,
	};
	expect(await f.operations.create(signedInput, config)).toBe(true);
	const page = await result.handlers.startPage(
		new Request(`${startUrl}?attempt_id=change-1&start_code=${startCode}`, {
			headers: { cookie: sessionHeader },
		}),
	);
	expect(page.status).toBe(200);
	const startHeader = page.headers.getSetCookie()[0]?.split(";")[0];
	if (!startHeader) throw new Error("missing start cookie");
	const admitted = await result.handlers.start(
		post(startUrl, `${startHeader}; ${sessionHeader}`, fields(await page.text())),
		"trusted-client",
	);
	expect(admitted.status).toBe(200);
	const transactionHeader = admitted.headers
		.getSetCookie()
		.find((value) => value.startsWith(`${BROWSER_COOKIE_NAMES.transaction}=`))
		?.split(";")[0];
	if (!transactionHeader) throw new Error("missing transaction cookie");
	const cookie = await readBrowserCookie(transactionHeader, "transaction");
	if (cookie.kind !== "present") throw new Error("invalid transaction cookie");
	const authorizationUrl = link(await admitted.text());
	const state = new URL(authorizationUrl).searchParams.get("state");
	if (!state) throw new Error("missing OIDC state");
	const stored = base.db.prepare(`SELECT nonce,pkce_verifier FROM ${changeTable}`).get() as {
		nonce: string;
		pkce_verifier: string;
	};
	const materials = {
		...f.materials(),
		state,
		stateHash: digest(state),
		binderHash: cookie.cookieHash,
		nonce: stored.nonce,
		pkceVerifier: stored.pkce_verifier,
	};
	const callbackUrl = oidc.authorize(authorizationUrl);
	const header = `${transactionHeader}; ${sessionHeader}`;
	const request = (url = callbackUrl.href, cookieHeader = header) =>
		new Request(url, { headers: { cookie: cookieHeader } });
	const row = () =>
		base.db.prepare(`SELECT * FROM ${changeTable}`).get() as Record<string, unknown>;
	const protectedSnapshot = () =>
		[...protectedTables, "coordinator_auth_session_receipts"].map((table) =>
			base.db.prepare(`SELECT * FROM ${table}`).all(),
		);
	return {
		...base,
		...f,
		backend,
		oidc,
		csrfKey,
		options,
		handlers: result.handlers,
		cookie,
		session,
		sessions,
		sessionHeader,
		signedInput,
		header,
		signedRequest: f.request,
		request,
		callbackUrl,
		materials,
		authorizationUrl,
		row,
		protectedSnapshot,
	};
}

it("refuses an absent private reader instead of treating unknown activity as inactive", async () => {
	const f = await fixture();
	const incompleteReaders = { ...f.options.readers };
	Reflect.deleteProperty(incompleteReaders, "readManagementActivity");
	const result = await createCoordinatorAccountChangeBrowser({
		...f.options,
		readers: incompleteReaders,
	});
	expect(result).toEqual({ ok: false, error: "private_reader_required" });
});
it("a delayed old sign-in failure cannot clear the newly promoted active management cookie", async () => {
	const f = await fixture();
	const old = await issueBrowserCookie("transaction"),
		state = "s".repeat(43);
	expect(
		await f.store.startAuthBrowserTransaction(
			{
				purpose: "signin",
				stateHash: digest(state),
				binderHash: old.cookieHash,
				nonce: "o".repeat(43),
				pkceVerifier: "p".repeat(43),
			},
			config,
		),
	).toMatchObject({ kind: "started" });
	const callback = await createCoordinatorBrowserAuthCallback({
		config,
		store: f.store,
		oidcOptions: { fetch: f.oidc.fetch },
		completeLink: async () => {
			throw new Error("unexpected LINK");
		},
	});
	if (!callback.ok) throw new Error(callback.error);
	const before = { ...f.row() };
	const delayed = await callback.handlers.callback(
		new Request(`${config.redirectUri}?state=${state}&code=unknown-code`, {
			headers: { cookie: old.setCookie.split(";")[0] ?? "" },
		}),
	);
	expect(delayed.response.status).toBe(403);
	expect(delayed.response.headers.getSetCookie()).toEqual([]);
	expect(f.row()).toEqual(before);
	expect(
		await f.store.readAuthBrowserTransactionActivity({ binderHash: f.cookie.cookieHash }, config),
	).toEqual({ kind: "active" });
});

it("probes exact durable state and binder without consuming or contacting the provider", async () => {
	const f = await fixture();
	const before = f.row(),
		count = f.oidc.fetch.mock.calls.length;
	expect(await f.handlers.matchesCallback(f.request())).toBe(true);
	expect(await f.handlers.matchesCallback(f.request())).toBe(true);
	expect(f.row()).toEqual(before);
	expect(f.oidc.fetch).toHaveBeenCalledTimes(count);
});

it.each(["empty", "name", "email"])(
	"explains disconnect consequences with one confirmation for %s provider profile",
	async (profile) => {
		const f = await fixture();
		f.oidc.claims.name = undefined;
		f.oidc.claims.email = undefined;
		if (profile === "name") f.oidc.claims.name = '<Account & "Name">';
		if (profile === "email") f.oidc.claims.email = '<account&"email">@example.test';
		const response = await f.handlers.callback(f.request(), "trusted-client");
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain(
			"ends browser sessions for this connection and removes its display profile",
		);
		expect(body).toContain(
			"Identity, device keys, history, membership, and access grants stay unchanged",
		);
		expect(body.match(/<form /g)).toHaveLength(1);
		expect(body.match(/<button /g)).toHaveLength(1);
		if (profile === "empty") expect(body).toContain("Google account");
		if (profile === "name") expect(body).toContain("&lt;Account &amp; &quot;Name&quot;&gt;");
		if (profile === "email")
			expect(body).toContain("&lt;account&amp;&quot;email&quot;&gt;@example.test");
		expect(body).not.toContain("<Account");
		expect(body).not.toContain("<account");
	},
);

it.each(["state", "binder", "missing", "duplicate", "origin", "method"])(
	"rejects %s before consumption and OIDC exchange without failing the victim",
	async (fault) => {
		const f = await fixture();
		const url = new URL(f.callbackUrl);
		let cookie = f.header;
		if (fault === "state") url.searchParams.set("state", "z".repeat(43));
		if (fault === "binder")
			cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0] ?? "";
		if (fault === "missing") cookie = "";
		if (fault === "duplicate") url.searchParams.append("state", f.materials.state);
		if (fault === "origin") url.hostname = "attacker.example.test";
		const request =
			fault === "method"
				? new Request(url, { method: "POST", headers: { cookie } })
				: f.request(url.href, cookie);
		const before = f.row(),
			count = f.oidc.fetch.mock.calls.length;
		expect(await f.handlers.matchesCallback(request)).toBe(false);
		const response = await f.handlers.callback(request, "trusted-client");
		expect(response.status).toBe(403);
		expect(response.headers.get("Set-Cookie")).toBeNull();
		expect(f.row()).toEqual(before);
		expect(f.oidc.fetch).toHaveBeenCalledTimes(count);
	},
);

it.each(["signature", "nonce", "pkce", "subject", "denied"])(
	"fails only the consumed attempt on real OIDC %s rejection",
	async (fault) => {
		const f = await fixture();
		if (fault === "signature") f.oidc.settings.signature = "wrong-key";
		if (fault === "nonce") f.oidc.claims.nonce = "wrong-nonce";
		if (fault === "subject") f.oidc.claims.sub = "different-account";
		if (fault === "pkce")
			f.callbackUrl = f.oidc.authorize(f.authorizationUrl, {
				challenge: "wrong-challenge",
			});
		if (fault === "denied") {
			f.callbackUrl.searchParams.delete("code");
			f.callbackUrl.searchParams.set("error", "access_denied");
		}
		const protectedBefore = f.protectedSnapshot();
		const response = await f.handlers.callback(f.request(f.callbackUrl.href), "trusted-client");
		expect(response.status).toBe(403);
		expect(response.headers.get("Set-Cookie")).toBeNull();
		expect(f.row()).toMatchObject({ state: "failed", nonce: null, pkce_verifier: null });
		expect(f.protectedSnapshot()).toEqual(protectedBefore);
		const body = await response.text();
		expect(body).not.toContain("account-A");
		expect(body).not.toContain("different-account");
		const count = f.oidc.fetch.mock.calls.length;
		await f.handlers.callback(f.request(f.callbackUrl.href), "trusted-client");
		expect(f.oidc.fetch).toHaveBeenCalledTimes(count);
		await freshStart(f);
		expect(f.protectedSnapshot()).toEqual(protectedBefore);
	},
);

it.each([
	["disconnect", "http://127.0.0.1:80/codemem/auth/complete"],
	["disconnect", "http://[::1]:4567/codemem/auth/complete"],
	["refresh", "http://127.0.0.1:80/codemem/auth/complete"],
	["refresh", "http://[::1]:4567/codemem/auth/complete"],
] as const)(
	"verifies %s, preserves the current session and hands proof only to pinned %s before private signed-input finalization",
	async (intent, destination) => {
		const f = await fixture(intent, destination);
		const protectedBefore = f.protectedSnapshot();
		const sessionBefore = await f.sessions.readAuthSession(f.session.cookieHash, config);
		const consume = vi.spyOn(f.operations, "consumeCallback");
		const confirm = vi.spyOn(f.operations, "confirmDisconnect");
		const originalFetch = f.oidc.fetch.getMockImplementation();
		if (!originalFetch) throw new Error("missing synthetic provider");
		f.oidc.fetch.mockImplementation(async (url, options) => {
			if (url.endsWith("/token"))
				expect(f.row()).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
			return originalFetch(url, options);
		});
		f.callbackUrl.searchParams.set("return_url", "https://attacker.example.test/");
		const response = await f.handlers.callback(f.request(), "trusted-client");
		expect(consume).toHaveBeenCalledTimes(1);
		expect(f.oidc.requests.some(({ url }) => url.endsWith("/jwks"))).toBe(true);
		expect(f.row()).toMatchObject({
			state: intent === "refresh" ? "confirmed" : "verified",
			display_name: "Fixture User",
		});
		expect(f.protectedSnapshot()).toEqual(protectedBefore);
		expect(response.status).toBe(200);
		expect(response.headers.get("Set-Cookie")).toBeNull();
		expect(await f.sessions.readAuthSession(f.session.cookieHash, config)).toEqual(sessionBefore);
		let body = await response.text();
		if (intent === "disconnect") {
			expect(body.match(/<form /g)).toHaveLength(1);
			expect(body).toContain('action="/auth/account/change/confirm"');
			expect(body).toContain("user@example.test");
			expect(body).not.toContain("completion=");
			const form = fields(body),
				invalid = new URLSearchParams(form);
			invalid.set("csrf", "invalid");
			expect(
				(await f.handlers.confirm(post(confirmUrl, f.header, invalid), "trusted-client")).status,
			).toBe(403);
			expect(confirm).not.toHaveBeenCalled();
			const redirect = new URLSearchParams(form);
			redirect.set("return_url", "https://attacker.example.test/");
			expect(
				(await f.handlers.confirm(post(confirmUrl, f.header, redirect), "trusted-client")).status,
			).toBe(403);
			const completed = await f.handlers.confirm(
				post(confirmUrl, f.header, form),
				"trusted-client",
			);
			expect(completed.status).toBe(200);
			expect(completed.headers.get("Set-Cookie")).toBeNull();
			expect(confirm).toHaveBeenCalledTimes(1);
			body = await completed.text();
			expect(
				(await f.handlers.confirm(post(confirmUrl, f.header, form), "trusted-client")).status,
			).toBe(403);
			expect(confirm).toHaveBeenCalledTimes(1);
		} else {
			expect(body).not.toContain("<form");
			expect(confirm).not.toHaveBeenCalled();
		}
		const href = link(body);
		expect(href.startsWith(`${destination}?attempt_id=change-1&completion=`)).toBe(true);
		expect(body).not.toContain("attacker.example.test");
		expect(body).not.toContain("window.opener");
		expect(body).not.toContain("window.close");
		expect(body).not.toContain("account-A");
		const completion = new URL(href).searchParams.get("completion"),
			bytes = decodeCoordinatorAuthProof32(completion);
		if (!bytes) throw new Error("missing completion proof");
		const completionSecretHash = await hashCoordinatorAuthProofBytes32(bytes);
		expect(completionSecretHash).not.toBe(digest(completion ?? ""));
		expect(f.row()).toMatchObject({
			state: "confirmed",
			completion_secret_hash: completionSecretHash,
		});
		expect(JSON.stringify(f.row())).not.toContain(completion);
		expect(f.protectedSnapshot()).toEqual(protectedBefore);
		// This invokes the private store with captured signed-input fields. It is
		// not evidence of HTTP request-signature verification or a mounted route.
		expect(
			await f.operations.finalize(
				{ ...f.signedInput, completionSecretHash: "0".repeat(64) },
				config,
			),
		).toBeNull();
		expect(
			await f.operations.finalize({ ...f.signedInput, completionSecretHash }, config),
		).toMatchObject({ intent });
		if (intent === "refresh") {
			expect(f.protectedSnapshot()).toEqual(protectedBefore);
			expect(
				f.db.prepare("SELECT display_name,email FROM coordinator_auth_link_profiles").all(),
			).toEqual([{ display_name: "Fixture User", email: "user@example.test" }]);
			expect(await f.sessions.readAuthSession(f.session.cookieHash, config)).toEqual(sessionBefore);
		} else {
			expect(await f.sessions.readAuthSession(f.session.cookieHash, config)).toBeNull();
			expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
		}
		const count = f.oidc.fetch.mock.calls.length;
		const delayed = await f.handlers.callback(f.request(), "trusted-client");
		expect(delayed.status).toBe(403);
		expect(delayed.headers.get("Set-Cookie")).toBeNull();
		expect(f.oidc.fetch).toHaveBeenCalledTimes(count);
	},
);

it("fails closed on an exact cross-purpose collision without consuming or exchanging", async () => {
	const f = await fixture();
	f.db
		.prepare(`INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
 VALUES (?,?, 'signin',NULL,?,?,?,?,?,'pending',?,?,?,?)`)
		.run(
			config.coordinatorId,
			"7".repeat(64),
			f.materials.stateHash,
			f.cookie.cookieHash,
			config.issuer,
			config.revision,
			config.redirectUri,
			"n".repeat(43),
			"p".repeat(43),
			f.clock.now,
			f.clock.now + 600000,
		);
	const before = f.row(),
		count = f.oidc.fetch.mock.calls.length;
	const response = await f.handlers.callback(f.request(), "trusted-client");
	expect(response.status).toBe(403);
	expect(f.row()).toEqual(before);
	expect(f.oidc.fetch).toHaveBeenCalledTimes(count);
});

it.each(["refresh", "disconnect"] as const)(
	"fails %s before committing when response preparation cannot read storage",
	async (intent) => {
		const f = await fixture(intent);
		const before = f.protectedSnapshot();
		vi.spyOn(f.operations, "readCallbackView").mockRejectedValueOnce(new Error("read unavailable"));
		const record = vi.spyOn(f.operations, "recordVerifiedCallback");
		const response = await f.handlers.callback(f.request(), "trusted-client");
		expect(response.status).toBe(403);
		expect(record).not.toHaveBeenCalled();
		expect(f.row()).toMatchObject({ state: "failed", completion_secret_hash: null });
		expect(f.protectedSnapshot()).toEqual(before);
		await freshStart(f);
	},
);

it.each(["refresh", "disconnect"] as const)(
	"fails %s before committing when response rendering fails",
	async (intent) => {
		const f = await fixture(intent);
		const render =
			intent === "refresh" ? "renderAuthLinkCompletionHopPage" : "renderAuthBrowserNotice";
		vi.spyOn(browserPages, render).mockRejectedValueOnce(new Error("render unavailable"));
		const response = await f.handlers.callback(f.request(), "trusted-client");
		expect(response.status).toBe(403);
		expect(f.row()).toMatchObject({ state: "failed", completion_secret_hash: null });
	},
);

it("delivers the same prepared secret when disconnect confirmation commits before transport failure", async () => {
	const f = await fixture("disconnect");
	const page = await f.handlers.callback(f.request(), "trusted-client");
	const form = fields(await page.text());
	const batch = f.backend.batch;
	vi.spyOn(f.backend, "batch").mockImplementationOnce(async (statements) => {
		await batch(statements);
		throw new Error("private postcommit transport failure");
	});
	const response = await f.handlers.confirm(post(confirmUrl, f.header, form), "trusted-client");
	expect(response.status).toBe(200);
	const bytes = decodeCoordinatorAuthProof32(
		new URL(link(await response.text())).searchParams.get("completion"),
	);
	if (!bytes) throw new Error("missing delivered proof");
	expect(f.row()).toMatchObject({
		state: "confirmed",
		completion_secret_hash: await hashCoordinatorAuthProofBytes32(bytes),
	});
	const proof = {
		...f.materials,
		completionSecretHash: await hashCoordinatorAuthProofBytes32(bytes),
	};
	const before = f.row();
	for (const field of ["stateHash", "binderHash", "completionSecretHash"])
		expect(
			await f.operations.confirmDisconnect({ ...proof, [field]: "0".repeat(64) }, config),
		).toBe(false);
	expect(await f.operations.confirmDisconnect(proof, config)).toBe(true);
	expect(f.row()).toEqual(before);
	expect(
		(await f.handlers.confirm(post(confirmUrl, f.header, form), "trusted-client")).status,
	).toBe(403);
	f.clock.now = Number(before.expires_at_ms) + 1;
	expect(await f.operations.confirmDisconnect(proof, config)).toBe(false);
});

it.each(["before commit", "ignored transition", "authority lost", "expired", "readback failed"])(
	"withholds disconnect proof after %s",
	async (fault) => {
		const f = await fixture("disconnect");
		const page = await f.handlers.callback(f.request(), "trusted-client");
		const form = fields(await page.text());
		const batch = f.backend.batch;
		vi.spyOn(f.backend, "batch").mockImplementationOnce(async (statements) => {
			if (fault === "before commit") throw new Error("private write failure");
			if (fault === "ignored transition") {
				f.db.exec(
					`CREATE TRIGGER fixture_ignore_confirm BEFORE UPDATE ON ${changeTable} WHEN NEW.state='confirmed' BEGIN SELECT RAISE(IGNORE); END`,
				);
				try {
					return await batch(statements);
				} finally {
					f.db.exec("DROP TRIGGER fixture_ignore_confirm");
				}
			}
			await batch(statements);
			if (fault === "authority lost") f.db.exec("UPDATE enrolled_devices SET enabled=0");
			if (fault === "expired") f.clock.now = Number(f.row().expires_at_ms) + 1;
			if (fault === "readback failed")
				vi.spyOn(f.backend, "first").mockRejectedValueOnce(new Error("private read failure"));
			throw new Error("private postcommit failure");
		});
		const response = await f.handlers.confirm(post(confirmUrl, f.header, form), "trusted-client");
		expect(response.status).toBe(fault === "readback failed" ? 503 : 403);
		expect(await response.text()).not.toContain("completion=");
		if (fault === "before commit" || fault === "ignored transition") {
			expect(f.row().state).toBe("verified");
			expect(
				(await f.handlers.confirm(post(confirmUrl, f.header, form), "trusted-client")).status,
			).toBe(200);
		} else expect(f.row().state).toBe("confirmed");
	},
);

it("keeps disconnect confirmation retryable when completion rendering fails", async () => {
	const f = await fixture("disconnect");
	const page = await f.handlers.callback(f.request(), "trusted-client");
	const form = fields(await page.text());
	vi.spyOn(browserPages, "renderAuthLinkCompletionHopPage").mockRejectedValueOnce(
		new Error("render unavailable"),
	);
	expect(
		(await f.handlers.confirm(post(confirmUrl, f.header, form), "trusted-client")).status,
	).toBe(503);
	expect(f.row()).toMatchObject({ state: "verified", completion_secret_hash: null });
	expect(
		(await f.handlers.confirm(post(confirmUrl, f.header, form), "trusted-client")).status,
	).toBe(200);
	expect(f.row()).toMatchObject({ state: "confirmed" });
});

it.each(["refresh", "disconnect"] as const)(
	"delivers prepared %s response without a fallible postcommit storage read",
	async (intent) => {
		const f = await fixture(intent);
		const record = f.operations.recordVerifiedCallback.bind(f.operations);
		vi.spyOn(f.operations, "recordVerifiedCallback").mockImplementation(async (...args) => {
			const won = await record(...args);
			vi.spyOn(f.operations, "readBrowserView").mockRejectedValue(new Error("postcommit outage"));
			vi.spyOn(f.operations, "readCallbackView").mockRejectedValue(new Error("postcommit outage"));
			return won;
		});
		const response = await f.handlers.callback(f.request(), "trusted-client");
		expect(response.status).toBe(200);
		const body = await response.text();
		if (intent === "refresh") {
			const bytes = decodeCoordinatorAuthProof32(
				new URL(link(body)).searchParams.get("completion"),
			);
			if (!bytes) throw new Error("missing completion proof");
			expect(f.row().completion_secret_hash).toBe(await hashCoordinatorAuthProofBytes32(bytes));
		} else {
			expect(body.match(/<form /g)).toHaveLength(1);
			expect(body).toContain('action="/auth/account/change/confirm"');
		}
	},
);

it("rechecks current device authority in the winning callback write after response preparation", async () => {
	const f = await fixture("refresh");
	const read = f.operations.readCallbackView.bind(f.operations);
	vi.spyOn(f.operations, "readCallbackView").mockImplementation(async (...args) => {
		const view = await read(...args);
		f.db.prepare("UPDATE enrolled_devices SET enabled=0").run();
		return view;
	});
	const response = await f.handlers.callback(f.request(), "trusted-client");
	expect(response.status).toBe(403);
	expect(await response.text()).not.toContain("completion=");
	expect(f.row()).toMatchObject({ state: "failed", completion_secret_hash: null });
});

it.each(["duplicate", "extra", "code", "wrong-origin"])(
	"rejects malformed start GET %s without setting or clearing cookies",
	async (fault) => {
		const f = await fixture();
		const url = new URL(startUrl);
		url.searchParams.set("attempt_id", "change-1");
		url.searchParams.set("start_code", "A".repeat(43));
		if (fault === "duplicate") url.searchParams.append("attempt_id", "change-1");
		if (fault === "extra") url.searchParams.set("return_url", "http://127.0.0.1:1234/");
		if (fault === "code") url.searchParams.set("start_code", "invalid");
		if (fault === "wrong-origin") url.hostname = "attacker.example.test";
		const response = await f.handlers.startPage(f.request(url.href));
		expect(response.status).toBe(400);
		expect(response.headers.get("Set-Cookie")).toBeNull();
	},
);

it("does not issue a start page when private start-code validation is unavailable", async () => {
	const f = await fixture();
	const result = await createCoordinatorAccountChangeBrowser({
		...f.options,
		readers: {
			...f.options.readers,
			async readStart() {
				throw new Error("injected persistence outage");
			},
		},
	});
	if (!result.ok) throw new Error(result.error);
	const response = await result.handlers.startPage(
		f.request(`${startUrl}?attempt_id=change-1&start_code=${"A".repeat(43)}`),
	);
	expect(response.status).toBe(503);
	expect(response.headers.get("Set-Cookie")).toBeNull();
});

it.each(["origin", "csrf", "body", "method"])(
	"rejects start POST %s with no claim and no transaction cookie replacement",
	async (fault) => {
		const f = await fixture();
		const cookie = await issueBrowserCookie("start");
		const csrf = await issueBrowserCsrfToken(f.csrfKey, cookie.secret, "start", {
			publicOrigin: origin,
			store: config,
		});
		const form = new URLSearchParams({ attempt_id: "change-1", start_code: "A".repeat(43), csrf });
		if (fault === "csrf") form.set("csrf", "invalid");
		if (fault === "body") form.set("extra", "invalid");
		const request = new Request(startUrl, {
			method: fault === "method" ? "GET" : "POST",
			headers: {
				origin: fault === "origin" ? "https://attacker.example.test" : origin,
				cookie: `${f.header}; ${cookie.setCookie.split(";")[0]}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			...(fault === "method" ? {} : { body: form }),
		});
		const before = f.row();
		const response = await f.handlers.start(request, "trusted-client");
		expect(response.status).toBe(fault === "method" ? 405 : 403);
		expect(response.headers.get("Set-Cookie")).toBeNull();
		expect(f.row()).toEqual(before);
	},
);

it("terminal confirm GET and invalid confirm POST never clear an unrelated transaction", async () => {
	const f = await fixture();
	for (const method of ["GET", "POST"]) {
		const response = await f.handlers.confirm(
			new Request(confirmUrl, {
				method,
				headers: { cookie: `${BROWSER_COOKIE_NAMES.transaction}=${"A".repeat(43)}` },
			}),
			"trusted-client",
		);
		expect(response.status).toBe(method === "GET" ? 405 : 403);
		expect(response.headers.get("Set-Cookie")).toBeNull();
	}
});

async function freshStart(f: Awaited<ReturnType<typeof fixture>>, cookieHeader = f.header) {
	const code = "A".repeat(43),
		bytes = decodeCoordinatorAuthProof32(code);
	if (!bytes) throw new Error("invalid fixture proof");
	expect(
		await f.operations.create(
			{ ...f.signedRequest(2), browserStartHash: await hashCoordinatorAuthProofBytes32(bytes) },
			config,
		),
	).toBe(true);
	const response = await f.handlers.startPage(
		new Request(`${startUrl}?attempt_id=change-2&start_code=${code}`, {
			headers: { cookie: cookieHeader },
		}),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
	const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
	expect(cookie).toContain(BROWSER_COOKIE_NAMES.start);
	const csrf = (await response.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
	if (!csrf || !cookie) throw new Error("missing real form credentials");
	const form = new URLSearchParams({ attempt_id: "change-2", start_code: code, csrf });
	const send = () =>
		f.handlers.start(post(startUrl, `${cookie}; ${cookieHeader}`, form), "trusted-client");
	const admitted = await send();
	expect(admitted.status).toBe(200);
	expect(admitted.headers.getSetCookie()).toEqual(
		expect.arrayContaining([
			expect.stringContaining(`${BROWSER_COOKIE_NAMES.transaction}=${cookie.split("=")[1]};`),
			expect.stringContaining(`${BROWSER_COOKIE_NAMES.start}=; Max-Age=0`),
		]),
	);
	expect(await admitted.text()).not.toContain(code);
	const stored = f.db.prepare(`SELECT * FROM ${changeTable} WHERE attempt_id = 'change-2'`).get();
	expect(stored).toMatchObject({
		state: "browser_pending",
		nonce: expect.any(String),
		pkce_verifier: expect.any(String),
	});
	const retry = await send();
	expect(retry.headers.get("Set-Cookie")).toBeNull();
	expect(retry.status).toBe(403);
}
it("validates the real private start code and promotes only its successful CSRF credential POST", async () => {
	const f = await fixture();
	await freshStart(f, f.sessionHeader);
});

it.each(["management", "ordinary"])(
	"the real %s activity read prevents replacement of another active transaction",
	async (purpose) => {
		const f = await fixture();
		let transaction = f.header;
		if (purpose === "ordinary") {
			const existing = await issueBrowserCookie("transaction");
			transaction = `${existing.setCookie.split(";")[0]}; ${f.sessionHeader}`;
			expect(
				await f.options.existing.startAuthBrowserTransaction(
					{
						purpose: "signin",
						binderHash: existing.cookieHash,
						stateHash: digest("s".repeat(43)),
						nonce: "n".repeat(43),
						pkceVerifier: "p".repeat(43),
					},
					config,
				),
			).toMatchObject({ kind: "started" });
		}
		const cookie = await issueBrowserCookie("start");
		const csrf = await issueBrowserCsrfToken(f.csrfKey, cookie.secret, "start", {
			publicOrigin: origin,
			store: config,
		});
		const response = await f.handlers.start(
			post(
				startUrl,
				`${transaction}; ${cookie.setCookie.split(";")[0]}`,
				new URLSearchParams({ attempt_id: "change-1", start_code: "A".repeat(43), csrf }),
			),
			"trusted-client",
		);
		expect(response.status).toBe(409);
		expect(response.headers.get("Set-Cookie")).toBeNull();
	},
);
