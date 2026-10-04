import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCurrentAccountPage } from "./coordinator-auth-browser-view.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { linked, SESSION_TTL } from "./coordinator-auth-session-test-fixtures.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { createCoordinatorBrowserAccount } from "./coordinator-browser-account.js";
import {
	BROWSER_COOKIE_NAMES,
	clearBrowserCookie,
	issueBrowserCookie,
} from "./coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
	verifyBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";

const ORIGIN = "https://app.example.test";
const GOOGLE = "https://accounts.google.com";
const config = () => ({
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: GOOGLE,
	clientId: "fixture-client",
	clientSecret: "fixture-private-client-secret",
	redirectUri: `${ORIGIN}/auth/callback`,
	revision: "a".repeat(64),
});
const scope = () => ({
	publicOrigin: ORIGIN,
	store: { coordinatorId: "coordinator-a", revision: config().revision },
});
const databases: ReturnType<typeof setupStore>["db"][] = [];
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const db of databases.splice(0)) db.close();
	}
});

async function harness(backend: Backend) {
	const clock = { now: NOW };
	const f = setupStore(backend, { authClock: () => clock.now });
	databases.push(f.db);
	const key = await importBrowserCsrfKey(new Uint8Array(32).fill(7));
	const store = {
		readAuthSessionAccount: vi.fn(f.store.readAuthSessionAccount.bind(f.store)),
		readAuthSession: vi.fn(f.store.readAuthSession.bind(f.store)),
		signOutAuthSession: vi.fn(f.store.signOutAuthSession.bind(f.store)),
	};
	const limiter = { check: vi.fn(() => ({ allowed: true, retryAfterS: 0 })) };
	const input = { config: config(), csrfKey: key, store, limiter };
	const result = await createCoordinatorBrowserAccount(input);
	if (!result.ok) throw new Error(`account_fixture_failed:${JSON.stringify(result)}`);
	await linked({ ...f, now: NOW, cfg: config() });
	return {
		...f,
		persistence: f.store,
		store,
		limiter,
		input,
		key,
		clock,
		handlers: result.handlers,
	};
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function session(f: Harness, index = 0) {
	const cookie = await issueBrowserCookie("session");
	const issued = await f.persistence.signInWithAuthAccount(
		{
			credentialHash: cookie.cookieHash,
			browserTransactionHash: String(index + 1).repeat(64),
			account: { issuer: GOOGLE, subject: "opaque-subject-a" },
		},
		config(),
	);
	if (issued.kind !== "issued") throw new Error("session_fixture_failed");
	const token = await issueBrowserCsrfToken(f.key, cookie.secret, "session", scope());
	return {
		...cookie,
		cookie: cookie.setCookie.split(";")[0] ?? "",
		token,
		session: issued.session,
	};
}
function get(cookie?: string) {
	return new Request(`${ORIGIN}/auth/account`, { headers: cookie ? { cookie } : {} });
}
function post(cookie: string, token: string) {
	return new Request(`${ORIGIN}/auth/logout`, {
		method: "POST",
		headers: {
			cookie,
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: `csrf=${token}`,
	});
}
function snapshot(f: Harness, excludeSessions = false) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(({ name }) => !excludeSessions || name !== "coordinator_auth_sessions")
		.map(({ name }) => ({ name, rows: f.db.prepare(`SELECT * FROM "${name}"`).all() }));
}
function noStore(f: Harness) {
	expect(f.store.readAuthSessionAccount).not.toHaveBeenCalled();
	expect(f.store.readAuthSession).not.toHaveBeenCalled();
	expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
}
async function failure(response: Response, status = 503) {
	expect(response.status).toBe(status);
	expect(response.headers.getSetCookie()).toEqual([]);
	const body = await response.text();
	expect(body).not.toContain("synthetic-private-failure");
	expect(body).not.toContain(config().clientSecret);
}

describe.each(["SQLite", "D1"] as const)(
	"%s account (D1 uses the fixture's SQLite connection)",
	(backend) => {
		it("renders only live identity and display metadata with a real SESSION-scoped MAC", async () => {
			// Arrange
			const f = await harness(backend);
			const s = await session(f);
			const profile = {
				displayName: "Example Person",
				email: "person@example.test",
				emailVerified: true,
			};
			expect(
				await f.persistence.recordAuthAccountProfile(
					{
						credentialHash: s.cookieHash,
						profile: {
							...profile,
							identityId: "profile-nominated-authority",
							issuer: "https://other.example.test",
							subject: "profile-nominated-subject",
						},
					},
					config(),
				),
			).toEqual({ kind: "recorded" });
			const before = snapshot(f);
			// Act
			const reply = await f.handlers.account(get(s.cookie));
			const body = await reply.response.text();
			const token = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(body)?.[1];
			const expected = await renderCurrentAccountPage({
				profile,
				issuer: GOOGLE,
				identity: { id: s.session.identityId },
				csrfToken: token ?? "",
			});
			const other = await issueBrowserCookie("session");
			// Assert
			expect(reply.response.status).toBe(200);
			expect(reply.response.headers.getSetCookie()).toEqual([]);
			expect(body).toBe(expected.body);
			expect(body).not.toContain("profile-nominated-authority");
			expect(body).not.toContain("profile-nominated-subject");
			for (const [name, value] of Object.entries(expected.headers))
				expect(reply.response.headers.get(name)).toBe(value);
			expect(body).toContain(s.session.identityId);
			for (const value of [
				s.session.linkId,
				s.session.sessionId,
				"opaque-subject-a",
				s.cookieHash,
				s.cookie,
				config().clientSecret,
			])
				expect(body).not.toContain(value);
			expect(await verifyBrowserCsrfToken(f.key, s.secret, "session", scope(), token)).toBe(true);
			for (const purpose of ["start", "transaction"] as const)
				expect(await verifyBrowserCsrfToken(f.key, s.secret, purpose, scope(), token)).toBe(false);
			expect(await verifyBrowserCsrfToken(f.key, other.secret, "session", scope(), token)).toBe(
				false,
			);
			expect(
				await verifyBrowserCsrfToken(
					f.key,
					s.secret,
					"session",
					{ ...scope(), publicOrigin: "https://other.example.test" },
					token,
				),
			).toBe(false);
			expect(
				await verifyBrowserCsrfToken(
					f.key,
					s.secret,
					"session",
					{ ...scope(), store: { ...scope().store, revision: "b".repeat(64) } },
					token,
				),
			).toBe(false);
			expect(f.store.readAuthSessionAccount).toHaveBeenCalledExactlyOnceWith(
				s.cookieHash,
				expect.objectContaining({ enabled: true, issuer: GOOGLE, revision: config().revision }),
			);
			expect(f.store.readAuthSession).not.toHaveBeenCalled();
			expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual(before);
		});

		it.each(["missing", "malformed", "duplicate", "ambiguous-start", "ambiguous-transaction"])(
			"GET %s cookies show signed out without reads or writes",
			async (state) => {
				// Arrange
				const f = await harness(backend);
				const s = await session(f);
				const cookies: Record<string, string | undefined> = {
					missing: undefined,
					malformed: `${BROWSER_COOKIE_NAMES.session}=bad`,
					duplicate: `${s.cookie}; ${s.cookie}`,
					"ambiguous-start": `${s.cookie}; ${BROWSER_COOKIE_NAMES.start}=bad`,
					"ambiguous-transaction": `${s.cookie}; ${BROWSER_COOKIE_NAMES.transaction}=bad`,
				};
				const before = snapshot(f);
				// Act
				const reply = await f.handlers.account(get(cookies[state]));
				// Assert
				expect(reply.response.status).toBe(200);
				expect(await reply.response.text()).toContain("You are signed out.");
				expect(reply.response.headers.getSetCookie()).toEqual([]);
				expect(f.store.readAuthSessionAccount).not.toHaveBeenCalled();
				expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
				expect(snapshot(f)).toEqual(before);
			},
		);
	},
);
describe.each(["SQLite", "D1"] as const)("%s exact routing and transport admission", (backend) => {
	it.each([
		["account", "POST", `${ORIGIN}/auth/account`, 405, "GET"],
		["account", "GET", `${ORIGIN}/auth/account?x=1`, 404, null],
		["account", "GET", `${ORIGIN}/auth/account#x`, 404, null],
		["account", "GET", `${ORIGIN}/auth/other`, 404, null],
		["account", "GET", "https://other.example.test/auth/account", 404, null],
		["logout", "GET", `${ORIGIN}/auth/logout`, 405, "POST"],
		["logout", "POST", `${ORIGIN}/auth/logout?x=1`, 404, null],
		["logout", "POST", `${ORIGIN}/auth/logout#x`, 404, null],
		["logout", "POST", `${ORIGIN}/auth/other`, 404, null],
		["logout", "POST", "https://other.example.test/auth/logout", 404, null],
	] as const)("%s rejects %s %s before admission", async (handler, method, url, status, allow) => {
		// Arrange
		const f = await harness(backend);
		const s = await session(f);
		const request = new Request(url, { method, headers: { cookie: s.cookie } });
		// Act
		const reply =
			handler === "account"
				? await f.handlers.account(request)
				: await f.handlers.logout(request, "trusted-client");
		// Assert
		await failure(reply.response.clone(), status);
		expect(reply.response.headers.get("allow")).toBe(allow);
		expect(f.limiter.check).not.toHaveBeenCalled();
		noStore(f);
	});
	it.each([null, "null", "https://other.example.test", `${ORIGIN}/`])(
		"Origin %j fails before checker/body/store",
		async (origin) => {
			// Arrange
			const f = await harness(backend);
			const s = await session(f);
			const original = post(s.cookie, s.token);
			const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
				controller.enqueue(new TextEncoder().encode(`csrf=${s.token}`));
				controller.close();
			});
			const request = new Request(original.url, {
				method: "POST",
				headers: original.headers,
				body: new ReadableStream({ pull }, { highWaterMark: 0 }),
				duplex: "half",
			} as RequestInit);
			if (origin === null) request.headers.delete("origin");
			else request.headers.set("origin", origin);
			// Act
			const reply = await f.handlers.logout(request, "trusted-client");
			// Assert
			await failure(reply.response, 403);
			expect(reply.outcome).toBe("origin_rejected");
			expect(request.bodyUsed).toBe(false);
			expect(pull).not.toHaveBeenCalled();
			expect(f.limiter.check).not.toHaveBeenCalled();
			noStore(f);
		},
	);
	it("rate refusal retains original twenty-request policy and Retry-After", async () => {
		// Arrange
		const f = await harness(backend);
		const s = await session(f);
		f.limiter.check.mockReturnValue({ allowed: false, retryAfterS: 9 });
		const request = post(s.cookie, s.token);
		// Act
		const reply = await f.handlers.logout(request, "trusted-client");
		// Assert
		await failure(reply.response.clone(), 429);
		expect(reply.response.headers.get("retry-after")).toBe("9");
		expect(f.limiter.check).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify(["browser-form", "coordinator-a", "trusted-client"]),
			20,
		);
		expect(request.bodyUsed).toBe(false);
		noStore(f);
	});
});
describe.each(["SQLite", "D1"] as const)("%s fresh LIVE account guards", (backend) => {
	it.each(["expired", "session-revoked", "link-revoked", "revision", "issuer"])(
		"GET honors current LIVE denial %s without clearing cookies",
		async (state) => {
			// Arrange
			const f = await harness(backend);
			const s = await session(f);
			if (state === "expired") f.clock.now += SESSION_TTL;
			if (state === "session-revoked")
				f.db.prepare("UPDATE coordinator_auth_sessions SET revoked_at_ms=?").run(NOW);
			if (state === "link-revoked")
				f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=?").run(NOW);
			if (state === "revision")
				f.db
					.prepare("UPDATE coordinator_auth_sessions SET auth_config_revision=?")
					.run("b".repeat(64));
			if (state === "issuer")
				f.db
					.prepare("UPDATE coordinator_auth_account_links SET issuer=?")
					.run("https://other.example.test");
			const before = snapshot(f);
			// Act
			const reply = await f.handlers.account(get(s.cookie));
			// Assert
			expect(reply.response.status).toBe(200);
			expect(await reply.response.text()).toContain("You are signed out.");
			expect(reply.response.headers.getSetCookie()).toEqual([]);
			expect(f.store.readAuthSessionAccount).toHaveBeenCalledExactlyOnceWith(
				s.cookieHash,
				expect.objectContaining({ enabled: true, issuer: GOOGLE, revision: config().revision }),
			);
			expect(snapshot(f)).toEqual(before);
		},
	);

	it("reads every GET anew so revocation between reads removes the profile", async () => {
		// Arrange
		const f = await harness(backend);
		const s = await session(f);
		await f.persistence.recordAuthAccountProfile(
			{ credentialHash: s.cookieHash, profile: { displayName: "Visible Person" } },
			config(),
		);
		// Act
		const first = await f.handlers.account(get(s.cookie));
		await f.persistence.signOutAuthSession(s.cookieHash, { coordinatorId: "coordinator-a" });
		const second = await f.handlers.account(get(s.cookie));
		// Assert
		expect(await first.response.text()).toContain("Visible Person");
		expect(await second.response.text()).not.toContain("Visible Person");
		expect(second.response.status).toBe(200);
		expect(second.response.headers.getSetCookie()).toEqual([]);
		expect(f.store.readAuthSessionAccount).toHaveBeenCalledTimes(2);
	});
});
describe.each(["SQLite", "D1"] as const)("%s logout lifecycle", (backend) => {
	it("logout reads/writes/reads exactly one hash and preserves every other authority table", async () => {
		// Arrange
		const f = await harness(backend);
		const s = await session(f);
		const other = await session(f, 1);
		const start = await issueBrowserCookie("start");
		const txn = await issueBrowserCookie("transaction");
		const before = snapshot(f, true);
		const order: string[] = [];
		f.store.readAuthSession.mockImplementation(async (...args) => {
			order.push("read");
			return f.persistence.readAuthSession(...args);
		});
		f.store.signOutAuthSession.mockImplementation(async (...args) => {
			order.push("write");
			return f.persistence.signOutAuthSession(...args);
		});
		// Act
		const reply = await f.handlers.logout(
			post(
				`${s.cookie}; ${start.setCookie.split(";")[0]}; ${txn.setCookie.split(";")[0]}`,
				s.token,
			),
			"trusted-client",
		);
		// Assert
		expect(reply.outcome).toBe("signed_out");
		expect(reply.response.status).toBe(200);
		expect(reply.response.headers.getSetCookie()).toEqual([clearBrowserCookie("session")]);
		expect(order).toEqual(["read", "write", "read"]);
		expect(f.store.readAuthSession).toHaveBeenNthCalledWith(
			1,
			s.cookieHash,
			expect.objectContaining({ revision: config().revision, issuer: GOOGLE }),
		);
		expect(f.store.readAuthSession).toHaveBeenNthCalledWith(
			2,
			s.cookieHash,
			expect.objectContaining({ revision: config().revision, issuer: GOOGLE }),
		);
		expect(f.store.signOutAuthSession).toHaveBeenCalledExactlyOnceWith(s.cookieHash, {
			coordinatorId: "coordinator-a",
		});
		expect(
			f.db
				.prepare("SELECT revoked_at_ms FROM coordinator_auth_sessions WHERE credential_hash=?")
				.get(s.cookieHash),
		).toEqual({ revoked_at_ms: NOW });
		expect(await f.persistence.readAuthSession(other.cookieHash, config())).toEqual(other.session);
		expect(f.db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_sessions").get()).toEqual({
			count: 2,
		});
		expect(snapshot(f, true)).toEqual(before);
	});

	it("lost clear-cookie replay clears a dead row without writing; missing-cookie replay does nothing", async () => {
		// Arrange
		const f = await harness(backend);
		const s = await session(f);
		await f.handlers.logout(post(s.cookie, s.token), "trusted-client");
		f.store.signOutAuthSession.mockClear();
		const before = snapshot(f);
		// Act
		const replay = await f.handlers.logout(post(s.cookie, s.token), "trusted-client");
		const absent = await f.handlers.logout(post("", "bad"), "trusted-client");
		// Assert
		expect(replay.outcome).toBe("already_signed_out");
		expect(replay.response.headers.getSetCookie()).toEqual([clearBrowserCookie("session")]);
		expect(absent.response.status).toBe(200);
		expect(absent.response.headers.getSetCookie()).toEqual([]);
		expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
		expect(snapshot(f)).toEqual(before);
	});

	it("a current revision denies an old row and clears only the browser, not durable authority", async () => {
		// Arrange: a later return to the old config may make that unchanged row LIVE again.
		const f = await harness(backend);
		const s = await session(f);
		const cfg = { ...config(), revision: "b".repeat(64) };
		const result = await createCoordinatorBrowserAccount({ ...f.input, config: cfg });
		if (!result.ok) throw new Error("fixture_revision_factory_failed");
		const token = await issueBrowserCsrfToken(f.key, s.secret, "session", {
			...scope(),
			store: { ...scope().store, revision: cfg.revision },
		});
		const before = snapshot(f);
		// Act
		const reply = await result.handlers.logout(post(s.cookie, token), "trusted-client");
		// Assert
		expect(reply.outcome).toBe("already_signed_out");
		expect(reply.response.headers.getSetCookie()).toEqual([clearBrowserCookie("session")]);
		expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
		expect(snapshot(f)).toEqual(before);
		expect(await f.persistence.readAuthSession(s.cookieHash, config())).toEqual(s.session);
	});
});
describe.each(["SQLite", "D1"] as const)("%s logout races and failures", (backend) => {
	it("two native concurrent calls on the shared fixture connection confirm idempotent revocation", async () => {
		// Arrange: this is not a claim about independent production SQL connections.
		const f = await harness(backend);
		const s = await session(f);
		const gate = Promise.withResolvers<void>();
		const arrived = Promise.withResolvers<void>();
		let reads = 0;
		f.store.readAuthSession.mockImplementation(async (...args) => {
			const value = await f.persistence.readAuthSession(...args);
			if (++reads <= 2) {
				if (reads === 2) arrived.resolve();
				await gate.promise;
			}
			return value;
		});
		// Act
		const pending = [
			f.handlers.logout(post(s.cookie, s.token), "client-a"),
			f.handlers.logout(post(s.cookie, s.token), "client-b"),
		];
		await arrived.promise;
		gate.resolve();
		const replies = await Promise.all(pending);
		// Assert
		expect(replies.map((r) => r.outcome)).toEqual(["signed_out", "signed_out"]);
		for (const reply of replies)
			expect(reply.response.headers.getSetCookie()).toEqual([clearBrowserCookie("session")]);
		expect(f.store.signOutAuthSession).toHaveBeenCalledTimes(2);
		expect(await f.persistence.readAuthSession(s.cookieHash, config())).toBeNull();
		expect(
			f.db
				.prepare("SELECT revoked_at_ms FROM coordinator_auth_sessions WHERE credential_hash=?")
				.get(s.cookieHash),
		).toEqual({ revoked_at_ms: NOW });
	});

	it.each(["expiry", "link-revocation"])(
		"%s while awaiting write never revives the row",
		async (change) => {
			// Arrange
			const f = await harness(backend);
			const s = await session(f);
			f.store.signOutAuthSession.mockImplementation(async (...args) => {
				await Promise.resolve();
				if (change === "expiry") f.clock.now += SESSION_TTL;
				else f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=?").run(NOW);
				return f.persistence.signOutAuthSession(...args);
			});
			// Act
			const reply = await f.handlers.logout(post(s.cookie, s.token), "trusted-client");
			// Assert
			expect(reply.outcome).toBe("signed_out");
			expect(reply.response.status).toBe(200);
			expect(await f.persistence.readAuthSession(s.cookieHash, config())).toBeNull();
			expect(
				f.db
					.prepare("SELECT revoked_at_ms FROM coordinator_auth_sessions WHERE credential_hash=?")
					.get(s.cookieHash),
			).toEqual({ revoked_at_ms: f.clock.now });
			expect(f.store.signOutAuthSession).toHaveBeenCalledExactlyOnceWith(s.cookieHash, {
				coordinatorId: "coordinator-a",
			});
		},
	);

	it.each([
		"pre-read",
		"write",
		"post-read",
		"malformed-post",
		"still-live",
		"malformed-pre",
		"malformed-write",
		"getter-write",
	])("logout %s failure retains the browser cookie", async (fault) => {
		// Arrange
		const f = await harness(backend);
		const s = await session(f);
		const error = new Error("synthetic-private-failure");
		const getter = vi.fn(() => {
			throw error;
		});
		const faults: Record<string, () => unknown> = {
			"pre-read": () => f.store.readAuthSession.mockRejectedValueOnce(error),
			write: () => f.store.signOutAuthSession.mockRejectedValueOnce(error),
			"post-read": () =>
				f.store.readAuthSession.mockResolvedValueOnce(s.session).mockRejectedValueOnce(error),
			"malformed-post": () =>
				f.store.readAuthSession.mockResolvedValueOnce(s.session).mockResolvedValueOnce([] as never),
			"still-live": () => f.store.readAuthSession.mockResolvedValue(s.session),
			"malformed-pre": () =>
				f.store.readAuthSession.mockResolvedValueOnce({ ...s.session, identityId: "" }),
			"malformed-write": () =>
				f.store.signOutAuthSession.mockResolvedValueOnce({ kind: "other" } as never),
			"getter-write": () =>
				f.store.signOutAuthSession.mockResolvedValueOnce(
					Object.defineProperty({}, "kind", { get: getter }) as never,
				),
		};
		faults[fault]?.();
		// Act
		const reply = await f.handlers.logout(post(s.cookie, s.token), "trusted-client");
		// Assert
		await failure(reply.response);
		expect(getter).not.toHaveBeenCalled();
		if (fault === "still-live") expect(reply.outcome).toBe("signout_unconfirmed");
		if (fault === "pre-read" || fault === "malformed-pre")
			expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
	});
});
