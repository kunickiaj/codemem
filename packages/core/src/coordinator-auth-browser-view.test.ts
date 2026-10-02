import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
	AUTH_BROWSER_AVATAR_HOSTS,
	AUTH_BROWSER_FORM_ACTIONS,
	projectAccountProfileView,
	renderAuthBrowserNotice,
	renderAuthLinkConfirmPage,
	renderCurrentAccountPage,
} from "./coordinator-auth-browser-view.js";

const issuer = "https://accounts.google.com";
const csrfToken = "a".repeat(43);
const picture = "https://lh3.googleusercontent.com/avatar?sz=64&x=y";
const profile = { displayName: "Ada Lovelace", email: "ada@example.test", emailVerified: true };
const linkInput = () => ({
	issuer,
	profile,
	identity: { id: "identity-prefix-abcdefgh", label: "Personal identity" },
	device: { id: "device-prefix-abcdefgh", label: "Laptop" },
	group: { id: "group-prefix-abcdefgh", label: "Development" },
	attemptId: "public-attempt",
	csrfToken,
});

// Default JSDOM does not execute scripts or load images, styles, or provider URLs.
function openPage(body: string): Document {
	return new JSDOM(body).window.document;
}

function header(headers: Record<string, string>, name: string): string {
	return (
		Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? ""
	);
}

function assertPassivePage(document: Document): void {
	expect(
		document.querySelector("script,base,svg,iframe,link,meta[http-equiv='refresh']"),
	).toBeNull();
	for (const element of document.querySelectorAll("*")) {
		for (const attribute of element.attributes) {
			expect(attribute.name).not.toMatch(/^on/i);
			expect(attribute.name).not.toBe("style");
		}
	}
}

describe("account profile projection", () => {
	it("projects optional metadata without mutating it or granting authority", () => {
		// Arrange
		const input = Object.freeze({
			...profile,
			pictureUrl: picture,
			subject: "not-an-authority",
			isAdmin: true,
		});
		// Act
		const result = projectAccountProfileView(input, issuer);
		// Assert
		expect(result).toEqual({
			title: profile.displayName,
			email: profile.email,
			pictureUrl: picture,
			initials: "AL",
		});
		expect(input.subject).toBe("not-an-authority");
	});

	it.each([undefined, null, false, 42, "name", [], {}])(
		"uses account fallback for absent metadata %j",
		(input) => {
			// Arrange
			const googleIssuer = issuer;
			// Act
			const google = projectAccountProfileView(input, googleIssuer);
			const other = projectAccountProfileView(input, "https://other.example.test");
			// Assert
			expect(google).toEqual({ title: "Google account", initials: "" });
			expect(other).toEqual({ title: "Linked account", initials: "" });
		},
	);

	it.each([false, undefined, "true", 1, null])(
		"shows no verified badge for verification flag %j",
		(emailVerified) => {
			// Arrange
			const input = { email: profile.email, emailVerified };
			// Act
			const result = projectAccountProfileView(input, issuer);
			// Assert
			expect(result).toEqual({
				title: profile.email,
				email: profile.email,
				emailNote: "Email not verified by provider",
				initials: "",
			});
		},
	);

	it("does not show an email note when the email is absent", () => {
		// Arrange
		const input = { displayName: "Ada", emailVerified: false };
		// Act
		const result = projectAccountProfileView(input, issuer);
		// Assert
		expect(result).toEqual({ title: "Ada", initials: "A" });
	});

	it.each(["\n", "\u0000", "\u202e", "\u200b", "\ud800", "\udfff"])(
		"drops controlled/surrogate display fields %j",
		(bad) => {
			// Arrange
			const input = {
				displayName: `Ada${bad}`,
				email: `ada${bad}@example.test`,
				pictureUrl: `${picture}${bad}`,
				emailVerified: false,
			};
			// Act
			const result = projectAccountProfileView(input, issuer);
			// Assert
			expect(result).toEqual({ title: "Google account", initials: "" });
		},
	);

	it("accepts exact display limits and drops overlong fields independently", () => {
		// Arrange
		const atLimit = { displayName: "A".repeat(256), email: "e".repeat(320), emailVerified: true };
		const prefix = "https://lh3.googleusercontent.com/";
		const atPictureLimit = `${prefix}${"p".repeat(2048 - prefix.length)}`;
		const overLimit = {
			displayName: "A".repeat(257),
			email: "e".repeat(321),
			pictureUrl: `https://lh3.googleusercontent.com/${"p".repeat(2048)}`,
		};
		// Act
		const valid = projectAccountProfileView(atLimit, issuer);
		const invalid = projectAccountProfileView(overLimit, issuer);
		const avatar = projectAccountProfileView({ pictureUrl: atPictureLimit }, issuer);
		// Assert
		expect(valid.title).toBe(atLimit.displayName);
		expect(valid.email).toBe(atLimit.email);
		expect(invalid).toEqual({ title: "Google account", initials: "" });
		expect(avatar.pictureUrl).toBe(atPictureLimit);
	});

	it("ignores inherited fields and never invokes metadata accessors", () => {
		// Arrange
		const getter = vi.fn(() => {
			throw new Error("secret getter");
		});
		const inherited = Object.create({ ...profile, pictureUrl: picture });
		const input = {};
		for (const field of ["displayName", "email", "pictureUrl", "emailVerified"])
			Object.defineProperty(input, field, { get: getter });
		// Act
		const result = projectAccountProfileView(input, issuer);
		const inheritedResult = projectAccountProfileView(inherited, issuer);
		// Assert
		expect(getter).not.toHaveBeenCalled();
		expect(result).toEqual({ title: "Google account", initials: "" });
		expect(inheritedResult).toEqual(result);
	});

	it.each([
		["Ada Lovelace", "AL"],
		["Émile Zola", "ÉZ"],
		["123 456", "14"],
		["ß Test", "T"],
		["👩‍💻 Ada", ""],
		["👩 Ada", "A"],
		["A\u0301\u0302\u0303\u0304 B", "B"],
		["😀", ""],
		["", ""],
	])("keeps initials to two short letter/number graphemes for %j", (displayName, expected) => {
		// Arrange
		const input = { displayName };
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		// Act
		const result = projectAccountProfileView(input, issuer);
		// Assert
		const graphemes = [...segmenter.segment(result.initials)].map((part) => part.segment);
		expect(graphemes.length).toBeLessThanOrEqual(2);
		for (const grapheme of graphemes) {
			expect(grapheme).toMatch(/^[\p{L}\p{N}]/u);
			expect([...grapheme].length).toBeLessThanOrEqual(4);
		}
		expect(result.initials).toBe(expected);
	});
});

describe("fixed remote avatar policy", () => {
	it.each([
		picture,
		"https://lh3.googleusercontent.com:443/avatar",
		"https://ｌｈ3.googleusercontent.com/a",
	])("allows and canonicalizes selected Google avatar %s", (input) => {
		// Arrange
		const metadata = { ...profile, pictureUrl: input };
		// Act
		const result = projectAccountProfileView(metadata, issuer);
		// Assert
		expect(result.pictureUrl).toBe(new URL(input).href);
		expect(AUTH_BROWSER_AVATAR_HOSTS).toEqual({ [issuer]: ["lh3.googleusercontent.com"] });
		expect(Object.isFrozen(AUTH_BROWSER_AVATAR_HOSTS)).toBe(true);
		expect(Object.isFrozen(AUTH_BROWSER_AVATAR_HOSTS[issuer])).toBe(true);
	});

	it.each([
		"http://lh3.googleusercontent.com/a",
		"javascript:alert(1)",
		"data:image/png;base64,AA",
		"file:///a",
		"blob:https://lh3.googleusercontent.com/a",
		"https://user:password@lh3.googleusercontent.com/a",
		"https://lh3.googleusercontent.com:8443/a",
		`${picture}#fragment`,
		`${picture}#`,
		` ${picture}`,
		`${picture} `,
		"https://lh3.googleusercontent.com\\a",
		"https://lh3.googleusercontent.com/a\n",
		"https://sub.lh3.googleusercontent.com/a",
		"https://lh3.googleusercontent.com.evil.test/a",
		"https://lh3.googleusercontent.com./a",
		"https://lh4.googleusercontent.com/a",
		"https://accounts.google.com/a",
		"https://xn--google-9jg.example.test/a",
		"https://127.0.0.1/a",
		"https://[::1]/a",
		"https://public.example.test/a",
	])("drops unapproved picture %j", (input) => {
		// Arrange
		const metadata = { ...profile, pictureUrl: input };
		// Act
		const result = projectAccountProfileView(metadata, issuer);
		// Assert
		expect(result.pictureUrl).toBeUndefined();
		expect(result.title).toBe(profile.displayName);
	});

	it.each([
		"https://other.example.test",
		"https://accounts.google.com/",
		"https://ACCOUNTS.google.com",
	])("does not trust the selected host for another issuer %s", (otherIssuer) => {
		// Arrange
		const metadata = { pictureUrl: picture };
		// Act
		const result = projectAccountProfileView(metadata, otherIssuer);
		// Assert
		expect(result).toEqual({ title: "Linked account", initials: "" });
	});
});

describe("auth browser forms and safe display", () => {
	it("renders only fixed POST link forms with full identity/device/group IDs", async () => {
		// Arrange
		const input = linkInput();
		// Act
		const page = await renderAuthLinkConfirmPage(input);
		const document = openPage(page.body);
		// Assert
		const forms = [...document.querySelectorAll("form")];
		expect(forms.map((form) => form.getAttribute("action"))).toEqual([
			AUTH_BROWSER_FORM_ACTIONS.confirmLink,
			AUTH_BROWSER_FORM_ACTIONS.cancelLink,
		]);
		expect(forms.map((form) => form.querySelector("button")?.textContent?.trim())).toEqual([
			"Link account",
			"Cancel linking",
		]);
		for (const form of forms) {
			expect(form.getAttribute("method")?.toLowerCase()).toBe("post");
			expect(form.querySelector("input[name='csrf']")?.getAttribute("value")).toBe(csrfToken);
			expect(form.querySelector("input[name='csrf']")?.getAttribute("type")).toBe("hidden");
			expect(form.querySelector("input[name='attempt_id']")?.getAttribute("value")).toBe(
				input.attemptId,
			);
		}
		for (const entry of [input.identity, input.device, input.group]) {
			expect([...document.querySelectorAll("code")].map((code) => code.textContent)).toContain(
				entry.id,
			);
			expect(document.body.textContent).toContain(entry.label);
		}
		expect(AUTH_BROWSER_FORM_ACTIONS).toEqual({
			confirmLink: "/auth/link/confirm",
			cancelLink: "/auth/link/cancel",
			signOut: "/auth/logout",
		});
		expect(Object.isFrozen(AUTH_BROWSER_FORM_ACTIONS)).toBe(true);
		expect(document.body.textContent).not.toContain("Email not verified by provider");
		expect(document.body.textContent).not.toMatch(/verified (?:email|account)|email verified/i);
		assertPassivePage(document);
	});

	it("renders an account-only current page with logout, not unlink or device controls", async () => {
		// Arrange
		const input = linkInput();
		// Act
		const page = await renderCurrentAccountPage(input);
		const document = openPage(page.body);
		// Assert
		expect(document.querySelectorAll("form")).toHaveLength(1);
		expect(document.querySelector("form")?.getAttribute("action")).toBe("/auth/logout");
		expect(document.querySelector("form")?.getAttribute("method")?.toLowerCase()).toBe("post");
		expect(document.querySelector("button")?.textContent?.trim()).toBe("Sign out");
		expect(document.querySelector("input[name='csrf']")?.getAttribute("value")).toBe(csrfToken);
		expect(document.querySelector("input[name='attempt_id']")).toBeNull();
		expect(document.body.textContent).toContain(input.identity.id);
		expect(document.body.textContent).not.toContain(input.device.id);
		expect(document.body.textContent).not.toContain(input.group.id);
		expect(document.body.textContent?.toLowerCase()).not.toContain("unlink");
	});
});

describe("safe browser display", () => {
	it.each([
		'<script>alert("x")</script>',
		'"><img src=x onerror="alert(1)">',
		"A & B 'quoted' &lt;tag&gt;",
	])("preserves hostile text as text, never markup: %j", async (text) => {
		// Arrange
		const input = {
			...linkInput(),
			profile: { displayName: text, email: text },
			identity: { id: text, label: text },
			device: { id: "device", label: text },
			group: { id: "group", label: text },
			attemptId: text,
		};
		// Act
		const page = await renderAuthLinkConfirmPage(input);
		const document = openPage(page.body);
		// Assert
		expect(document.body.textContent).toContain(text);
		expect(document.querySelector("h2")?.textContent).toBe(text);
		for (const field of document.querySelectorAll("input[name='attempt_id']"))
			expect(field.getAttribute("value")).toBe(text);
		expect([...document.querySelectorAll("code")].map((code) => code.textContent)).toContain(text);
		expect(document.querySelectorAll("img")).toHaveLength(0);
		assertPassivePage(document);
	});

	it("retains initials behind a decorative avatar with canonical attribute values", async () => {
		// Arrange
		const input = { ...linkInput(), profile: { ...profile, pictureUrl: picture } };
		// Act
		const page = await renderAuthLinkConfirmPage(input);
		const document = openPage(page.body);
		// Assert
		const image = document.querySelector("img");
		expect(image?.getAttribute("src")).toBe(picture);
		expect(image?.getAttribute("alt")).toBe("");
		expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect([...document.querySelectorAll("span")].some((span) => span.textContent === "AL")).toBe(
			true,
		);
		assertPassivePage(document);
	});

	it("keeps the empty fallback span and omits invalid labels and absent group", async () => {
		// Arrange
		const input = {
			...linkInput(),
			profile: { email: profile.email },
			device: { id: "device", label: "bad\u202e" },
			identity: { id: "identity", label: "x".repeat(257) },
			group: undefined,
		};
		// Act
		const page = await renderAuthLinkConfirmPage(input);
		const document = openPage(page.body);
		// Assert
		expect(document.querySelector("img")).toBeNull();
		expect([...document.querySelectorAll("span")].some((span) => span.textContent === "")).toBe(
			true,
		);
		expect(document.body.textContent).not.toContain("bad\u202e");
		expect(document.body.textContent).not.toContain("x".repeat(257));
		expect([...document.querySelectorAll("code")].map((code) => code.textContent)).toEqual(
			expect.arrayContaining(["identity", "device"]),
		);
	});

	it("ignores caller action, style, callback and credential fields", async () => {
		// Arrange
		const secret = "DO-NOT-SERIALIZE-credential";
		const input = {
			...linkInput(),
			action: secret,
			html: secret,
			styles: secret,
			loopback: secret,
			providerAllowlist: [secret],
			nonce: secret,
			pkceVerifier: secret,
			cookie: secret,
			sessionCredential: secret,
			accountSubject: secret,
			completionProof: secret,
			signingPrivateKey: secret,
			device: { ...linkInput().device, privateKey: secret },
			profile: { ...profile, sub: secret },
		};
		// Act
		const pages = await Promise.all([
			renderAuthLinkConfirmPage(input),
			renderCurrentAccountPage(input),
		]);
		// Assert
		for (const page of pages) {
			expect(page.body).not.toContain(secret);
			expect(JSON.stringify(page.headers)).not.toContain(secret);
			assertPassivePage(openPage(page.body));
		}
	});
});

describe("redacted validation", () => {
	it("accepts full-length IDs and base64url CSRF without truncating identifiers", async () => {
		// Arrange
		const id = "i".repeat(256);
		const token = `${"a".repeat(41)}_-`;
		const input = {
			...linkInput(),
			identity: { id },
			device: { id },
			group: { id },
			attemptId: id,
			csrfToken: token,
		};
		// Act
		const page = await renderAuthLinkConfirmPage(input);
		const document = openPage(page.body);
		// Assert
		expect([...document.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
			id,
			id,
			id,
		]);
		expect(document.querySelector("input[name='csrf']")?.getAttribute("value")).toBe(token);
		expect(document.querySelector("input[name='attempt_id']")?.getAttribute("value")).toBe(id);
	});

	it.each(["", "issuer\n", "issuer\u202e", "x".repeat(257), 42, null])(
		"redacts invalid issuer %j",
		async (badIssuer) => {
			// Arrange
			const input = { ...linkInput(), issuer: badIssuer } as Parameters<
				typeof renderAuthLinkConfirmPage
			>[0];
			// Act
			const promise = renderAuthLinkConfirmPage(input);
			// Assert
			await expect(promise).rejects.toThrow(/^auth_browser_view_invalid_input$/);
		},
	);

	it.each(["", "x".repeat(257), "id\n", "id\u202e", "id\ud800", " id ", 42, new String("boxed")])(
		"rejects invalid required IDs %j",
		async (id) => {
			// Arrange
			const inputs = ["identity", "device", "group", "attemptId"].map((field) => ({
				...linkInput(),
				[field]: field === "attemptId" ? id : { id },
			})) as unknown as Parameters<typeof renderAuthLinkConfirmPage>[0][];
			// Act
			const outcomes = await Promise.allSettled(inputs.map(renderAuthLinkConfirmPage));
			// Assert
			for (const outcome of outcomes) {
				expect(outcome.status).toBe("rejected");
				if (outcome.status === "rejected")
					expect(outcome.reason.message).toBe("auth_browser_view_invalid_input");
			}
		},
	);

	it.each(["", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}\n`])(
		"rejects malformed CSRF %j",
		async (token) => {
			// Arrange
			const input = { ...linkInput(), csrfToken: token };
			// Act
			const promises = [renderAuthLinkConfirmPage(input), renderCurrentAccountPage(input)];
			// Assert
			for (const promise of promises)
				await expect(promise).rejects.toThrow(/^auth_browser_view_invalid_input$/);
		},
	);

	it.each(["issuer", "identity", "device", "attemptId", "csrfToken"])(
		"rejects required accessor %s without executing it",
		async (field) => {
			// Arrange
			const getter = vi.fn(() => {
				throw new Error("sensitive accessor");
			});
			const input = Object.defineProperty(linkInput(), field, { get: getter });
			// Act
			const promise = renderAuthLinkConfirmPage(input);
			// Assert
			await expect(promise).rejects.toThrow(/^auth_browser_view_invalid_input$/);
			expect(getter).not.toHaveBeenCalled();
		},
	);

	it.each(["profile", "device", "identity", "group"])(
		"never executes optional %s metadata getters",
		async (field) => {
			// Arrange
			const getter = vi.fn(() => {
				throw new Error("sensitive metadata");
			});
			const input = linkInput();
			if (field === "profile") Object.defineProperty(input, field, { get: getter });
			else
				Object.defineProperty(input[field as "device" | "identity" | "group"], "label", {
					get: getter,
				});
			// Act
			const outcome = await renderAuthLinkConfirmPage(input).then(
				(page) => page,
				(error: unknown) => error,
			);
			// Assert
			expect(getter).not.toHaveBeenCalled();
			if (outcome instanceof Error) expect(outcome.message).toBe("auth_browser_view_invalid_input");
			else
				expect(openPage((outcome as { body: string }).body).body.textContent).not.toContain(
					"sensitive metadata",
				);
		},
	);

	it("redacts hostile proxy errors without invoking property getters", async () => {
		// Arrange
		const get = vi.fn(() => {
			throw new Error("private-get-trap");
		});
		const input = new Proxy(linkInput(), {
			get,
			getOwnPropertyDescriptor: () => {
				throw new Error("private-descriptor-trap");
			},
		});
		// Act
		const promise = renderAuthLinkConfirmPage(input);
		// Assert
		await expect(promise).rejects.toThrow(/^auth_browser_view_invalid_input$/);
		expect(get).not.toHaveBeenCalled();
	});
});

describe("passive notices and response policy", () => {
	it.each(["expired", "unavailable", "signed_out"] as const)(
		"renders fixed %s notice without forms or redirects",
		async (kind) => {
			// Arrange
			const expectedLinks = kind === "signed_out" ? ["/auth/sign-in"] : [];
			const titles = {
				expired: "Link expired",
				unavailable: "Account linking unavailable",
				signed_out: "Signed out",
			};
			// Act
			const page = await renderAuthBrowserNotice(kind);
			const document = openPage(page.body);
			// Assert
			expect(document.querySelectorAll("form")).toHaveLength(0);
			expect([...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(
				expectedLinks,
			);
			expect(document.querySelector("h1")?.textContent).toBe(titles[kind]);
			expect(header(page.headers, "Location")).toBe("");
			assertPassivePage(document);
		},
	);

	it("rejects caller-supplied notice content with a generic error", async () => {
		// Arrange
		const kind = "sensitive-provider-error" as Parameters<typeof renderAuthBrowserNotice>[0];
		// Act
		const promise = renderAuthBrowserNotice(kind);
		// Assert
		await expect(promise).rejects.toThrow(/^auth_browser_view_invalid_input$/);
	});

	it("hashes the exact shared static CSS with native Web Crypto and restrictive CSP", async () => {
		// Arrange
		const input = linkInput();
		// Act
		const pages = await Promise.all([
			renderAuthLinkConfirmPage(input),
			renderCurrentAccountPage(input),
			renderAuthBrowserNotice("expired"),
			renderAuthBrowserNotice("unavailable"),
			renderAuthBrowserNotice("signed_out"),
			renderCurrentAccountPage({
				...input,
				issuer: "https://other.example.test",
				profile: { ...profile, pictureUrl: picture },
			}),
		]);
		// Assert
		const css = openPage(pages[0].body).querySelector("style")?.textContent ?? "";
		expect(css.length).toBeGreaterThan(0);
		const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css));
		const hash = btoa(String.fromCharCode(...new Uint8Array(bytes)));
		for (const [index, page] of pages.entries()) {
			const document = openPage(page.body);
			expect(document.querySelectorAll("style")).toHaveLength(1);
			expect(document.querySelector("style")?.textContent).toBe(css);
			expect(css).not.toMatch(/@import|url\s*\(/i);
			expect(header(page.headers, "Content-Type")).toMatch(/^text\/html;\s*charset=utf-8$/i);
			expect(header(page.headers, "Cache-Control")).toBe("no-store");
			expect(header(page.headers, "Referrer-Policy")).toBe("no-referrer");
			expect(header(page.headers, "X-Content-Type-Options")).toBe("nosniff");
			expect(header(page.headers, "X-Frame-Options")).toBe("DENY");
			const csp = header(page.headers, "Content-Security-Policy");
			const directives = new Map(
				csp
					.split(";")
					.filter((part) => part.trim())
					.map((part) => {
						const [name, ...values] = part.trim().split(/\s+/);
						return [name, values];
					}),
			);
			expect(directives.get("default-src")).toEqual(["'none'"]);
			expect(directives.get("style-src")).toEqual([`'sha256-${hash}'`]);
			for (const name of ["base-uri", "frame-ancestors"])
				expect(directives.get(name)).toEqual(["'none'"]);
			expect(directives.get("form-action")).toEqual(["'self'"]);
			expect(directives.get("img-src")).toEqual(
				index < 2 ? ["https://lh3.googleusercontent.com"] : ["'none'"],
			);
			if (index === 5) expect(document.querySelector("img")).toBeNull();
			expect(csp).not.toMatch(/unsafe-inline|nonce-|data:|\bhttps:\s|\bhttp:/);
			assertPassivePage(document);
		}
	});

	it("keeps the renderer source free of network, database, and script capabilities", async () => {
		// Arrange
		const sourceUrl = new URL("./coordinator-auth-browser-view.ts", import.meta.url);
		// Act
		const source = await readFile(sourceUrl, "utf8");
		// Assert
		expect(source).not.toMatch(
			/\bfetch\s*\(|\bXMLHttpRequest\b|\bimport\s*\(|\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|SET)\b/,
		);
		expect(source).not.toMatch(/from\s+["'][^"']*(?:store|database|node:|http)[^"']*["']/);
		expect(source).not.toMatch(/<script\b|\bonerror\s*=/i);
	});
});
