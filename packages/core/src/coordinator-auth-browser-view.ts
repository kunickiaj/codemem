import { isCoordinatorAccountIssuer } from "./coordinator-auth-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import { isBrowserCsrfToken } from "./coordinator-browser-csrf.js";

export const AUTH_BROWSER_FORM_ACTIONS = Object.freeze({
	signIn: "/auth/sign-in",
	confirmLink: "/auth/link/confirm",
	cancelLink: "/auth/link/cancel",
	signOut: "/auth/logout",
});

// A conservative client policy, not a provider guarantee about picture hosts.
export const AUTH_BROWSER_AVATAR_HOSTS = Object.freeze({
	"https://accounts.google.com": Object.freeze(["lh3.googleusercontent.com"]),
});

export interface CoordinatorAccountProfileView {
	title: string;
	email?: string;
	emailNote?: string;
	pictureUrl?: string;
	initials: string;
}

export interface CoordinatorAuthBrowserEntity {
	id: string;
	label?: string;
}

export interface CoordinatorAuthLinkConfirmPageInput {
	profile?: unknown;
	issuer: string;
	identity: CoordinatorAuthBrowserEntity;
	device: CoordinatorAuthBrowserEntity;
	group?: CoordinatorAuthBrowserEntity;
	attemptId: string;
	csrfToken: string;
}

export interface CoordinatorAuthCurrentAccountPageInput {
	profile?: unknown;
	issuer: string;
	identity: CoordinatorAuthBrowserEntity;
	csrfToken: string;
}

export interface CoordinatorAuthSigninPageInput {
	csrfToken: string;
}

export interface CoordinatorAuthSigninContinuePageInput {
	authorizationUrl: string;
}

export interface CoordinatorAuthLinkCompletionHopPageInput {
	destination: string;
	attemptId: string;
	completionSecret: string;
}

export interface CoordinatorAuthBrowserPage {
	body: string;
	headers: Record<string, string>;
}

const GOOGLE_ISSUER = "https://accounts.google.com";
const INVALID_INPUT = "auth_browser_view_invalid_input";
const CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const SENSITIVE_AUTHORIZATION_KEYS = new Set([
	"code",
	"code_verifier",
	"client_secret",
	"access_token",
	"refresh_token",
	"id_token",
]);
const STYLE = `
:root{color-scheme:light;font-family:system-ui,-apple-system,sans-serif;color:#202731;background:#f7f5ef}
*{box-sizing:border-box}body{margin:0;padding:2rem 1rem}main{max-width:42rem;margin:0 auto;border-top:4px solid #183b60;padding-top:1.5rem}
h1,h2{font-family:"Iowan Old Style",Palatino,serif;font-weight:600}h1{font-size:2rem;margin:.4rem 0 1.5rem}h2{font-size:1.25rem;margin:0 0 .5rem}
p{line-height:1.6;margin:.5rem 0}section{padding:1.25rem 0;border-bottom:1px solid #c8ccd0}.eyebrow{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#46515d}
.profile{display:flex;align-items:center;gap:1rem}.profile-text{min-width:0;overflow-wrap:anywhere}.avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 3rem;width:3rem;height:3rem;border-radius:50%;background:#e1e6eb;color:#183b60;overflow:hidden}
.initials{font-weight:700}.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:transparent}.note{font-size:.875rem;color:#46515d}
dl{margin:0}dt{font-weight:600;margin-top:1rem}dd{margin:.25rem 0 0}code{font-family:ui-monospace,monospace;font-size:.9rem;overflow-wrap:anywhere;white-space:pre-wrap}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.5rem 0}form{margin:0}button,.link{font:inherit;display:inline-block;padding:.7rem 1rem;border:1px solid #183b60;border-radius:2px;background:#183b60;color:#fff;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:#183b60}a{color:#183b60}button:hover,.link:hover{background:#254d76;color:#fff}:focus-visible{outline:3px solid #986008;outline-offset:4px}
@media(max-width:30rem){body{padding:1rem}h1{font-size:1.75rem}.profile{align-items:flex-start}}
`;

function invalidInput(): never {
	throw new Error(INVALID_INPUT);
}

function record(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	return value as Record<string, unknown>;
}

function ownData(
	value: Record<string, unknown>,
	key: string,
	options: { rejectAccessor?: boolean } = {},
): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) return undefined;
	if (!Object.hasOwn(descriptor, "value")) {
		if (options.rejectAccessor) invalidInput();
		return undefined;
	}
	return descriptor.value;
}

function displayText(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string" || value.length > limit || CONTROLS.test(value)) return undefined;
	if (!value || value !== value.trim()) return undefined;
	return value;
}

function capturePageField(input: unknown, key: string): unknown {
	try {
		const data = record(input);
		if (!data) return invalidInput();
		return ownData(data, key, { rejectAccessor: true });
	} catch {
		return invalidInput();
	}
}

function captureSigninCsrf(input: unknown): string {
	const csrfToken = capturePageField(input, "csrfToken");
	// Shape validation only; the controller verifies the token before starting sign-in.
	if (!isBrowserCsrfToken(csrfToken)) return invalidInput();
	return csrfToken;
}

function captureAuthorizationUrl(input: unknown): string {
	try {
		const text = displayText(capturePageField(input, "authorizationUrl"), 8192);
		if (!text || text.includes("\\") || text.includes("#")) return invalidInput();
		const url = new URL(text);
		if (
			url.href !== text ||
			url.protocol !== "https:" ||
			url.origin !== GOOGLE_ISSUER ||
			url.username ||
			url.password ||
			url.port ||
			url.hash
		)
			return invalidInput();
		for (const name of url.searchParams.keys()) {
			if (SENSITIVE_AUTHORIZATION_KEYS.has(name.toLowerCase())) return invalidInput();
		}
		return text;
	} catch {
		return invalidInput();
	}
}

function pictureUrl(value: unknown, issuer: string): string | undefined {
	const text = displayText(value, 2048);
	if (!text || issuer !== GOOGLE_ISSUER || text.includes("\\") || text.includes("#")) return;
	try {
		const url = new URL(text);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			!AUTH_BROWSER_AVATAR_HOSTS[GOOGLE_ISSUER].includes(url.hostname)
		)
			return;
		return url.href;
	} catch {
		return undefined;
	}
}

function initialsFor(name: string | undefined): string {
	if (!name) return "";
	const words = name.split(/\s+/u);
	const chosen = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
	const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
	const initials: string[] = [];
	for (const word of chosen) {
		if (!word) continue;
		const grapheme = segmenter.segment(word)[Symbol.iterator]().next().value?.segment;
		if (!grapheme || !/^[\p{L}\p{N}]/u.test(grapheme) || [...grapheme].length > 4) continue;
		const upper = grapheme.toUpperCase();
		const segments = [...segmenter.segment(upper)];
		if (segments.length !== 1 || [...upper].length > 4 || CONTROLS.test(upper)) continue;
		initials.push(upper);
	}
	return initials.join("");
}

/** Presentation metadata only; names and email never confer account authority. */
export function projectAccountProfileView(
	profile: unknown,
	issuer: string,
): CoordinatorAccountProfileView {
	const fallback = issuer === GOOGLE_ISSUER ? "Google account" : "Linked account";
	try {
		const data = record(profile);
		if (!data) return { title: fallback, initials: "" };
		const name = displayText(ownData(data, "displayName"), 256);
		const email = displayText(ownData(data, "email"), 320);
		const view: CoordinatorAccountProfileView = {
			title: name ?? email ?? fallback,
			initials: initialsFor(name),
		};
		if (email) {
			view.email = email;
			if (ownData(data, "emailVerified") !== true)
				view.emailNote = "Email not verified by provider";
		}
		const picture = pictureUrl(ownData(data, "pictureUrl"), issuer);
		if (picture) view.pictureUrl = picture;
		return view;
	} catch {
		return { title: fallback, initials: "" };
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function entity(value: unknown, fallback: string): CoordinatorAuthBrowserEntity {
	const data = record(value);
	if (!data) return invalidInput();
	const id = ownData(data, "id", { rejectAccessor: true });
	if (!isAuthControllerId(id)) return invalidInput();
	return {
		id,
		label: displayText(ownData(data, "label", { rejectAccessor: true }), 256) ?? fallback,
	};
}

function capture(input: unknown): {
	data: Record<string, unknown>;
	issuer: string;
	identity: CoordinatorAuthBrowserEntity;
	csrfToken: string;
	profile: CoordinatorAccountProfileView;
} {
	try {
		const data = record(input);
		if (!data) return invalidInput();
		const issuer = ownData(data, "issuer", { rejectAccessor: true });
		const csrfToken = ownData(data, "csrfToken", { rejectAccessor: true });
		if (!isCoordinatorAccountIssuer(issuer) || !isBrowserCsrfToken(csrfToken))
			return invalidInput();
		return {
			data,
			issuer,
			csrfToken,
			identity: entity(ownData(data, "identity", { rejectAccessor: true }), "Identity"),
			profile: projectAccountProfileView(
				ownData(data, "profile", { rejectAccessor: true }),
				issuer,
			),
		};
	} catch {
		return invalidInput();
	}
}

function profileMarkup(profile: CoordinatorAccountProfileView): string {
	let image = "";
	if (profile.pictureUrl)
		image = `<img src="${escapeHtml(profile.pictureUrl)}" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async">`;
	let details = "";
	if (profile.email) details += `<p>${escapeHtml(profile.email)}</p>`;
	if (profile.emailNote) details += `<p class="note">${escapeHtml(profile.emailNote)}</p>`;
	return `<section class="profile" aria-label="Account profile"><span class="avatar"><span class="initials" aria-hidden="true">${escapeHtml(profile.initials)}</span>${image}</span><div class="profile-text"><h2>${escapeHtml(profile.title)}</h2>${details}</div></section>`;
}

function entityMarkup(value: CoordinatorAuthBrowserEntity, heading: string): string {
	return `<dt>${escapeHtml(heading)}</dt><dd>${escapeHtml(value.label ?? heading)}<br><code>${escapeHtml(value.id)}</code></dd>`;
}

function form(
	action: string,
	csrf: string,
	label: string,
	options: { attemptId?: string; secondary?: boolean } = {},
): string {
	let fields = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
	if (options.attemptId)
		fields += `<input type="hidden" name="attempt_id" value="${escapeHtml(options.attemptId)}">`;
	const className = options.secondary ? ' class="secondary"' : "";
	return `<form method="post" action="${escapeHtml(action)}">${fields}<button type="submit"${className}>${escapeHtml(label)}</button></form>`;
}

async function buildPage(
	title: string,
	content: string,
	issuer?: string,
	options: { referrerPolicy?: "no-referrer" | "same-origin" } = {},
): Promise<CoordinatorAuthBrowserPage> {
	try {
		const digest = await globalThis.crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(STYLE),
		);
		const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
		let images = "'none'";
		if (issuer === GOOGLE_ISSUER)
			images = AUTH_BROWSER_AVATAR_HOSTS[GOOGLE_ISSUER].map((host) => `https://${host}`).join(" ");
		return {
			body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${content}</main></body></html>`,
			headers: {
				"Content-Type": "text/html;charset=utf-8",
				"Cache-Control": "no-store",
				"Referrer-Policy": options.referrerPolicy ?? "no-referrer",
				"X-Content-Type-Options": "nosniff",
				"X-Frame-Options": "DENY",
				"Content-Security-Policy": `default-src 'none'; style-src 'sha256-${hash}'; img-src ${images}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
			},
		};
	} catch {
		throw new Error("auth_browser_view_render_failed");
	}
}

/** Caller releases this secret-bearing page only after confirmation commits. */
export async function renderAuthLinkCompletionHopPage(
	input: CoordinatorAuthLinkCompletionHopPageInput,
): Promise<CoordinatorAuthBrowserPage> {
	let href: string;
	try {
		const data = record(input);
		if (!data) return invalidInput();
		const destination = ownData(data, "destination", { rejectAccessor: true });
		const attemptId = ownData(data, "attemptId", { rejectAccessor: true });
		const completionSecret = ownData(data, "completionSecret", { rejectAccessor: true });
		const parsed = parseCoordinatorAuthLoopback(destination);
		if (
			!parsed.ok ||
			!isAuthControllerId(attemptId) ||
			typeof completionSecret !== "string" ||
			completionSecret.length !== 43 ||
			!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(completionSecret)
		)
			return invalidInput();
		// Concatenation preserves the saved literal, including an explicit :80.
		href = `${parsed.destination}?attempt_id=${encodeURIComponent(attemptId)}&completion=${completionSecret}`;
	} catch {
		return invalidInput();
	}
	return buildPage(
		"Continue on this computer",
		`<h1>Continue on this computer</h1><p>Return to the computer where you started linking to finish.</p><p><strong>Do not share this link.</strong> It lets your computer finish linking.</p><div class="actions"><a class="link" href="${escapeHtml(href)}" referrerpolicy="no-referrer" rel="noreferrer">Continue on this computer</a></div>`,
	);
}

export async function renderAuthSigninPage(
	input: CoordinatorAuthSigninPageInput,
): Promise<CoordinatorAuthBrowserPage> {
	const csrfToken = captureSigninCsrf(input);
	return buildPage(
		"Sign in",
		`<h1>Sign in</h1><p>Sign in to manage your coordinator account.</p><p>Signing in does not enroll a device or change project access.</p><div class="actions">${form(AUTH_BROWSER_FORM_ACTIONS.signIn, csrfToken, "Sign in with Google")}</div>`,
		undefined,
		{ referrerPolicy: "same-origin" },
	);
}

/**
 * Only pass a trusted SDK-produced URL, never a request-nominated URL.
 * The origin and known-key checks protect the anchor, not the OAuth protocol;
 * the denylist cannot detect arbitrary secret values in other parameters.
 */
export async function renderAuthSigninContinuePage(
	input: CoordinatorAuthSigninContinuePageInput,
): Promise<CoordinatorAuthBrowserPage> {
	const authorizationUrl = captureAuthorizationUrl(input);
	return buildPage(
		"Continue sign-in",
		`<h1>Continue sign-in</h1><div class="actions"><a class="link" href="${escapeHtml(authorizationUrl)}" referrerpolicy="no-referrer" rel="noreferrer">Continue to Google</a></div>`,
	);
}

export async function renderAuthLinkConfirmPage(
	input: CoordinatorAuthLinkConfirmPageInput,
): Promise<CoordinatorAuthBrowserPage> {
	const captured = capture(input);
	let device: CoordinatorAuthBrowserEntity;
	let group: CoordinatorAuthBrowserEntity | undefined;
	let attemptId: string;
	try {
		device = entity(ownData(captured.data, "device", { rejectAccessor: true }), "Device");
		const groupValue = ownData(captured.data, "group", { rejectAccessor: true });
		if (groupValue !== undefined) group = entity(groupValue, "Group");
		const attempt = ownData(captured.data, "attemptId", { rejectAccessor: true });
		if (!isAuthControllerId(attempt)) return invalidInput();
		attemptId = attempt;
	} catch {
		return invalidInput();
	}
	let entities = entityMarkup(captured.identity, "Identity") + entityMarkup(device, "Device");
	if (group) entities += entityMarkup(group, "Group");
	const actions =
		form(AUTH_BROWSER_FORM_ACTIONS.confirmLink, captured.csrfToken, "Link account", { attemptId }) +
		form(AUTH_BROWSER_FORM_ACTIONS.cancelLink, captured.csrfToken, "Cancel linking", {
			attemptId,
			secondary: true,
		});
	return buildPage(
		"Link account",
		`<h1>Link account</h1>${profileMarkup(captured.profile)}<section aria-label="Link details"><h2>Link details</h2><dl>${entities}</dl><p>Linking this account does not change project sharing, memories, or device keys.</p></section><p>Only confirm if you started linking on this computer. Do not share the link used to start this request.</p><div class="actions">${actions}</div>`,
		captured.issuer,
		{ referrerPolicy: "same-origin" },
	);
}

export async function renderCurrentAccountPage(
	input: CoordinatorAuthCurrentAccountPageInput,
): Promise<CoordinatorAuthBrowserPage> {
	const captured = capture(input);
	return buildPage(
		"Account",
		`<p class="eyebrow">Signed in</p><h1>Account</h1>${profileMarkup(captured.profile)}<section aria-label="Identity"><h2>Identity</h2><dl>${entityMarkup(captured.identity, "Identity")}</dl></section><div class="actions">${form(AUTH_BROWSER_FORM_ACTIONS.signOut, captured.csrfToken, "Sign out")}</div>`,
		captured.issuer,
		{ referrerPolicy: "same-origin" },
	);
}

export async function renderAuthBrowserNotice(
	kind:
		| "expired"
		| "unavailable"
		| "signed_out"
		| "link_cancelled"
		| "signin_in_progress"
		| "signin_unavailable"
		| "auth_unavailable",
): Promise<CoordinatorAuthBrowserPage> {
	let title: string;
	let content: string;
	switch (kind) {
		case "link_cancelled":
			title = "Linking cancelled";
			content =
				"<p>No account was linked in this attempt. Return to your terminal to start again.</p>";
			break;
		case "auth_unavailable":
			title = "Sign-in or linking unavailable";
			content = "<p>Return to the flow you started and try again.</p>";
			break;
		case "signin_in_progress":
			title = "Sign-in already in progress";
			content = "<p>Finish the open sign-in or account-link flow before starting another.</p>";
			break;
		case "signin_unavailable":
			title = "Sign-in unavailable";
			content =
				'<p>Sign-in is unavailable. Try again.</p><div class="actions"><a class="link" href="/auth/sign-in">Sign in</a></div>';
			break;
		case "expired":
			title = "Link expired";
			content =
				"<p>This account link has expired. Return to your terminal and start linking again.</p>";
			break;
		case "unavailable":
			title = "Account linking unavailable";
			content =
				"<p>Account linking is unavailable. Return to your terminal and start linking again.</p>";
			break;
		case "signed_out":
			title = "Signed out";
			content =
				'<p>You are signed out.</p><div class="actions"><a class="link" href="/auth/sign-in">Sign in</a></div>';
			break;
		default:
			return invalidInput();
	}
	return buildPage(title, `<h1>${escapeHtml(title)}</h1>${content}`);
}
