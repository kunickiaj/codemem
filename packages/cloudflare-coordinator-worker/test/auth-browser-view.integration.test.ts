import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	renderAuthBrowserNotice,
	renderAuthLinkConfirmPage,
	renderCurrentAccountPage,
} from "../../core/src/coordinator-auth-browser-view.js";
import {
	BROWSER_COOKIE_NAMES,
	readBrowserCookie,
} from "../../core/src/coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
} from "../../core/src/coordinator-browser-csrf.js";

const issuer = "https://accounts.google.com";
const csrfToken = `${"c".repeat(85)}A`;
const identity = { id: "identity-full-prefix-12345678", label: "<script>bad</script>" };
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
});
afterEach(() => vi.restoreAllMocks());

async function assertPage(
	page: { body: string; headers: Record<string, string> },
	options: { referrerPolicy: "same-origin" | "no-referrer" },
) {
	const styles = [...page.body.matchAll(/<style>([\s\S]*?)<\/style>/g)];
	expect(styles).toHaveLength(1);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(styles[0][1]));
	const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
	expect(page.headers["Content-Security-Policy"]).toContain(`style-src 'sha256-${hash}'`);
	expect(page.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
	expect(page.headers["Content-Security-Policy"]).toContain("form-action 'self'");
	expect(page.headers["Content-Security-Policy"]).not.toMatch(
		/unsafe-inline|nonce-|data:|\bhttps:\s|\bhttp:/,
	);
	expect(page.headers["Cache-Control"]).toBe("no-store");
	expect(page.headers["Referrer-Policy"]).toBe(options.referrerPolicy);
	const unsafe = /<script|<[^>]+\son[a-z]+\s*=|nonce=|pkceVerifier|completion_secret/i;
	expect(page.body).not.toMatch(unsafe);
	expect(globalThis.fetch).not.toHaveBeenCalled();
}

it.each(["<SCRIPT>alert(1)</SCRIPT>", '<IMG SRC=x ONERROR="bad">', "<ScRiPt>bad</ScRiPt>"])(
	"escapes mixed-case executable markup in account labels: %s",
	async (label) => {
		// Arrange
		const input = {
			issuer,
			identity: { ...identity, label },
			csrfToken,
		};
		// Act
		const page = await renderCurrentAccountPage(input);
		// Assert
		await assertPage(page, { referrerPolicy: "same-origin" });
		expect(page.body).not.toContain(label);
		expect(page.body).toContain("&lt;");
	},
);

it("renders fixed link forms, escaped labels and a canonical Google avatar in workerd", async () => {
	// Arrange: unrelated profile secrets must not leak.
	const input = {
		issuer,
		identity,
		csrfToken,
		attemptId: "attempt-a",
		device: { id: "device-full-prefix-12345678", label: "<img src=x onerror=bad>" },
		group: { id: "group-full-prefix-12345678" },
		profile: {
			displayName: "Élodie Martin",
			pictureUrl: "https://lh3.googleusercontent.com:443/avatar",
			cookie: "secret-cookie",
		},
	};
	// Act
	const page = await renderAuthLinkConfirmPage(input);
	// Assert
	await assertPage(page, { referrerPolicy: "same-origin" });
	expect(page.body).toContain('<img src="https://lh3.googleusercontent.com/avatar"');
	expect(page.body).toContain('referrerpolicy="no-referrer"');
	expect(page.body).toContain('class="initials" aria-hidden="true">ÉM</span>');
	expect(page.body).toContain("&lt;img src=x onerror=bad&gt;");
	expect(page.body).toContain("&lt;script&gt;bad&lt;/script&gt;");
	for (const entity of [identity, input.device, input.group]) {
		expect(page.body).toContain(`<code>${entity.id}</code>`);
	}
	expect([...page.body.matchAll(/action="([^"]+)"/g)].map((m) => m[1])).toEqual([
		"/auth/link/confirm",
		"/auth/link/cancel",
	]);
	expect([...page.body.matchAll(/<input[^>]+name="([^"]+)"/g)].map((m) => m[1])).toEqual([
		"csrf",
		"attempt_id",
		"csrf",
		"attempt_id",
	]);
	expect(page.body.match(/method="post"/g)).toHaveLength(2);
	expect(page.body.match(new RegExp(`value="${csrfToken}"`, "g"))).toHaveLength(2);
	expect(page.body.match(/value="attempt-a"/g)).toHaveLength(2);
	expect(page.body).not.toContain("secret-cookie");
	await expect(renderAuthLinkConfirmPage({ ...input, csrfToken: "invalid" })).rejects.toThrow(
		"auth_browser_view_invalid_input",
	);
});

it("renders account fallback and fixed notices without granting image or script access", async () => {
	// Arrange
	const kinds = ["expired", "unavailable", "signed_out"] as const;
	const profile = { displayName: "Élodie Martin", pictureUrl: "https://unknown.example/avatar" };
	// Act
	const account = await renderCurrentAccountPage({ issuer, identity, csrfToken, profile });
	const pages = await Promise.all(kinds.map((kind) => renderAuthBrowserNotice(kind)));
	// Assert
	await assertPage(account, { referrerPolicy: "same-origin" });
	expect(account.body).not.toContain("<img");
	expect(account.body).toContain('class="initials" aria-hidden="true">ÉM</span>');
	expect(account.body).toContain('<form method="post" action="/auth/logout">');
	expect(account.body.match(/<input /g)).toHaveLength(1);
	expect(account.body).toContain(`name="csrf" value="${csrfToken}"`);
	for (const page of pages) {
		await assertPage(page, { referrerPolicy: "no-referrer" });
		expect(page.body).not.toMatch(/<form|<input|<img/);
		expect(page.headers["Content-Security-Policy"]).toContain("img-src 'none'");
	}
	expect(pages[0].body).toContain("Link expired");
	expect(pages[1].body).toContain("Account linking unavailable");
	expect(pages[2].body).toContain('href="/auth/sign-in"');
	await expect(renderAuthBrowserNotice("<script>" as "expired")).rejects.toThrow(
		"auth_browser_view_invalid_input",
	);
});

it.each([
	"",
	"a".repeat(43),
	"a".repeat(85),
	"a".repeat(87),
	`${"a".repeat(85)}=`,
	`${"a".repeat(85)}.`,
	`${"a".repeat(85)}B`,
	`${"a".repeat(85)}\n`,
	`${csrfToken}==`,
])("rejects noncanonical CSRF in both workerd form renderers: %j", async (token) => {
	// Arrange
	const input = {
		issuer,
		identity,
		csrfToken: token,
		attemptId: "attempt-a",
		device: { id: "device-fixture" },
	};
	// Act
	const outcomes = await Promise.allSettled([
		renderAuthLinkConfirmPage(input),
		renderCurrentAccountPage(input),
	]);
	// Assert
	for (const outcome of outcomes) {
		expect(outcome.status).toBe("rejected");
		if (outcome.status === "rejected")
			expect(outcome.reason.message).toBe("auth_browser_view_invalid_input");
	}
});

it.each(["transaction", "session"] as const)(
	"preserves a helper-issued %s CSRF token in workerd forms",
	async (purpose) => {
		// Arrange: deterministic entropy, independent server key, and opaque cookie.
		vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
			if (!(array instanceof Uint8Array)) throw new Error("expected byte array");
			array.fill(17);
			return array;
		});
		const key = await importBrowserCsrfKey(new Uint8Array(32).fill(29));
		const cookie = await readBrowserCookie(
			`${BROWSER_COOKIE_NAMES[purpose]}=${"A".repeat(43)}`,
			purpose,
		);
		if (cookie.kind !== "present") throw new Error("fixture cookie missing");
		const token = await issueBrowserCsrfToken(key, cookie.secret, purpose, {
			publicOrigin: "https://coordinator.example.test",
			store: { coordinatorId: "coordinator-fixture", revision: "a".repeat(64) },
		});
		const input = {
			issuer,
			identity,
			csrfToken: token,
			attemptId: "attempt-a",
			device: { id: "device-fixture" },
		};
		// Act
		const page = await (purpose === "transaction"
			? renderAuthLinkConfirmPage(input)
			: renderCurrentAccountPage(input));
		// Assert: shape preservation is not token authentication.
		expect(token).toHaveLength(86);
		expect(token).toMatch(/^[A-Za-z0-9_-]{85}[AQgw]$/);
		expect(
			[...page.body.matchAll(/name="csrf" value="([^"]+)"/g)].map((match) => match[1]),
		).toEqual(purpose === "transaction" ? [token, token] : [token]);
		await assertPage(page, { referrerPolicy: "same-origin" });
	},
);
