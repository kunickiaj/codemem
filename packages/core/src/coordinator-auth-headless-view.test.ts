import { describe, expect, it } from "vitest";
import { COORDINATOR_AUTH_STYLE } from "./coordinator-auth-browser-style.js";
import { renderHeadlessConsentPage } from "./coordinator-auth-headless-view.js";
import { formatShortKeyFingerprint } from "./coordinator-auth-key-fingerprint.js";

const FINGERPRINT = `0123abcd${"5".repeat(48)}89abcdef`;
// A real token shape is needed; its signature is never checked by the view.
const CSRF = `${"A".repeat(85)}A`;

function render(deviceName: string | null) {
	return renderHeadlessConsentPage({
		issuer: "https://accounts.google.com",
		identityId: "identity-a",
		groupId: "group-a",
		deviceId: "device-a",
		deviceName,
		fingerprint: FINGERPRINT,
		attemptId: "attempt-a",
		csrfToken: CSRF,
	});
}

function deviceEntry(body: string) {
	return /<dt>Device<\/dt><dd>([\s\S]*?)<\/dd>/.exec(body)?.[1];
}

describe("headless consent device name", () => {
	it.each([
		["a bidi override", "Build \u202Ebox"],
		["a zero-width character", "Build\u200Bbox"],
		["a forged fingerprint", "SHA256:deadbeef...cafebabe"],
		["a bare hex run", "box deadbeefcafe"],
		["a machine-shaped name", "device:abc123"],
		["only whitespace", "   "],
	])("falls back to Device for %s", async (_case, name) => {
		// Act
		const page = await render(name);
		// Assert
		expect(deviceEntry(page.body)).toBe("<bdi>Device</bdi><br><code>device-a</code>");
		expect(page.body.match(/SHA256/gi)).toEqual(["SHA256"]);
		expect(page.body).toContain(formatShortKeyFingerprint(FINGERPRINT));
	});

	it("isolates a valid name in its own element, apart from the fingerprint", async () => {
		// Act
		const page = await render("  Build   box ");
		// Assert
		expect(deviceEntry(page.body)).toBe("<bdi>Build box</bdi><br><code>device-a</code>");
		expect(page.body).toMatch(
			/<\/dl><\/section><section aria-label="Device key"><h2>Device key fingerprint<\/h2><p><code>SHA256:0123abcd\.\.\.89abcdef<\/code><\/p><\/section>/,
		);
	});
});

describe("headless consent link details", () => {
	it("shows only the ID for the Identity and Group rows", async () => {
		// Act
		const page = await render("Build box");
		// Assert
		expect(page.body).toContain("<dt>Identity</dt><dd><code>identity-a</code></dd>");
		expect(page.body).toContain("<dt>Group</dt><dd><code>group-a</code></dd>");
	});

	it("keeps the headless command on one line", async () => {
		// Act
		const page = await render("Build box");
		// Assert
		expect(page.body).toContain(
			'<code class="command">codemem coordinator link-account --headless</code>',
		);
		// The page CSP allows only the hashed stylesheet, so the rule lives there.
		expect(COORDINATOR_AUTH_STYLE).toContain("code.command{white-space:nowrap");
	});
});
