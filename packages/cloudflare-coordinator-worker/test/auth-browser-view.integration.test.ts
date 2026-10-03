import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	renderAuthBrowserNotice,
	renderAuthLinkConfirmPage,
	renderCurrentAccountPage,
} from "../../core/src/coordinator-auth-browser-view.js";

const issuer = "https://accounts.google.com";
const csrfToken = "c".repeat(43);
const identity = { id: "identity-full-prefix-12345678", label: "<script>bad</script>" };
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
});
afterEach(() => vi.restoreAllMocks());

async function assertPage(page: { body: string; headers: Record<string, string> }) {
	const styles = [...page.body.matchAll(/<style>([\s\S]*?)<\/style>/g)];
	expect(styles).toHaveLength(1);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(styles[0][1]));
	const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
	expect(page.headers["Content-Security-Policy"]).toContain(`style-src 'sha256-${hash}'`);
	expect(page.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
	expect(page.headers["Cache-Control"]).toBe("no-store");
	expect(page.headers["Referrer-Policy"]).toBe("no-referrer");
	const unsafe = /<script|<[^>]+\son[a-z]+\s*=|nonce=|pkceVerifier|completion_secret/i;
	expect(page.body).not.toMatch(unsafe);
	expect(globalThis.fetch).not.toHaveBeenCalled();
}

it.each(["<SCRIPT>alert(1)</SCRIPT>", '<IMG SRC=x ONERROR="bad">', "<ScRiPt>bad</ScRiPt>"])(
	"escapes mixed-case executable markup in account labels: %s",
	async (label) => {
		const page = await renderCurrentAccountPage({
			issuer,
			identity: { ...identity, label },
			csrfToken,
		});
		await assertPage(page);
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
	await assertPage(page);
	expect(page.body).toContain('<img src="https://lh3.googleusercontent.com/avatar"');
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
	await assertPage(account);
	expect(account.body).not.toContain("<img");
	expect(account.body).toContain('class="initials" aria-hidden="true">ÉM</span>');
	expect(account.body).toContain('<form method="post" action="/auth/logout">');
	expect(account.body.match(/<input /g)).toHaveLength(1);
	expect(account.body).toContain(`name="csrf" value="${csrfToken}"`);
	for (const page of pages) {
		await assertPage(page);
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
