/** Browser pages for ADR 0005 Section 8 rebinding. Presentation only; the ceremony decides. */
import {
	buildPage,
	type CoordinatorAuthBrowserPage,
	escapeHtml,
} from "./coordinator-auth-browser-view.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import type {
	DeviceRebindConfirmation,
	DeviceRebindRefusal,
} from "./coordinator-device-rebind-ceremony.js";

export const DEVICE_REBIND_BROWSER_PATHS = Object.freeze({
	start: "/auth/rebind/start",
	confirm: "/auth/rebind/confirm",
});

function hidden(fields: Record<string, string>): string {
	return Object.entries(fields)
		.map(
			([name, value]) =>
				`<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
		)
		.join("");
}

function form(action: string, fields: Record<string, string>, label: string): string {
	return `<form method="post" action="${action}">${hidden(fields)}<button type="submit">${escapeHtml(label)}</button></form>`;
}

/** Private start code stays in hidden form data; the page submits itself. */
export function renderDeviceRebindStartPage(input: {
	attemptId: string;
	startCode: string;
	csrf: string;
}): Promise<CoordinatorAuthBrowserPage> {
	const fields = { csrf: input.csrf, attempt_id: input.attemptId, start_code: input.startCode };
	return buildPage(
		"Sign in on this device",
		`<h1>Connecting to Google…</h1><p>You’ll choose an account and confirm before this device changes.</p><p class="note">If nothing happens, continue below. Do not share this page.</p><div class="actions">${form(DEVICE_REBIND_BROWSER_PATHS.start, fields, "Continue with Google")}</div>`,
		undefined,
		{ referrerPolicy: "same-origin", autoSubmit: true },
	);
}

function detail(label: string, value: string): string {
	return `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code></dd>`;
}

/** Self-bind: the account already belongs to this device's Identity. */
function renderSelfBindConfirmPage(input: {
	confirmation: DeviceRebindConfirmation;
	csrf: string;
}): Promise<CoordinatorAuthBrowserPage> {
	const c = input.confirmation;
	const details =
		detail("Device", c.deviceId) +
		detail("Key fingerprint", c.fingerprint) +
		detail("Identity", c.currentIdentityId);
	const fields = {
		csrf: input.csrf,
		attempt_id: c.attemptId,
		confirmation_hash: c.confirmationHash,
	};
	return buildPage(
		"Use this account on this device",
		`<h1>Use this account on this device</h1><p>This Google account already belongs to this device’s Identity. Confirming lets this device refresh and unlink it too.</p><section aria-label="Device"><dl>${details}</dl></section><p>A device can do this only once.</p><div class="actions">${form(DEVICE_REBIND_BROWSER_PATHS.confirm, fields, "Confirm")}</div>`,
		undefined,
		{ referrerPolicy: "same-origin" },
	);
}

export function renderDeviceRebindConfirmPage(input: {
	confirmation: DeviceRebindConfirmation;
	csrf: string;
}): Promise<CoordinatorAuthBrowserPage> {
	const c = input.confirmation;
	if (c.targetIdentityId === c.currentIdentityId) return renderSelfBindConfirmPage(input);
	const teams = c.groupsWithoutAccess.length ? c.groupsWithoutAccess.join(", ") : "None";
	const details =
		detail("Device", c.deviceId) +
		detail("Key fingerprint", c.fingerprint) +
		detail("Current Identity", c.currentIdentityId) +
		detail("New Identity", c.targetIdentityId) +
		detail("Teams without access yet", teams);
	const fields = {
		csrf: input.csrf,
		attempt_id: c.attemptId,
		confirmation_hash: c.confirmationHash,
	};
	return buildPage(
		"Sign in on this device",
		`<h1>Sign in on this device</h1><p>This device will use the Identity of the Google account you chose. Its existing memories keep their author.</p><section aria-label="Change"><dl>${details}</dl></section><p>Teams the new Identity isn’t in won’t sync on this device until a Team admin adds it. A device can switch only once.</p><div class="actions">${form(DEVICE_REBIND_BROWSER_PATHS.confirm, fields, "Switch this device")}</div>`,
		undefined,
		{ referrerPolicy: "same-origin" },
	);
}

/** Caller releases this secret-bearing page only after confirmation commits. */
export function renderDeviceRebindHopPage(input: {
	loopbackRedirect: string;
	attemptId: string;
	completionSecret: string;
	confirmationHash: string;
}): Promise<CoordinatorAuthBrowserPage> {
	const parsed = parseCoordinatorAuthLoopback(input.loopbackRedirect);
	if (
		!parsed.ok ||
		!/^[A-Za-z0-9_-]{43}$/.test(input.completionSecret) ||
		!/^[a-f0-9]{64}$/.test(input.confirmationHash)
	)
		throw new Error("device_rebind_view_invalid_input");
	// Concatenation preserves the saved literal, including an explicit :80.
	const href = `${parsed.destination}?attempt_id=${encodeURIComponent(input.attemptId)}&completion=${input.completionSecret}&confirmation=${input.confirmationHash}`;
	return buildPage(
		"Finishing sign-in",
		`<h1>Finishing sign-in…</h1><p>Returning to Codemem on this computer. If nothing happens, continue below.</p><p class="note">Do not share this link.</p><div class="actions"><a class="link" href="${escapeHtml(href)}" referrerpolicy="no-referrer" rel="noreferrer">Continue on this computer</a></div>`,
		undefined,
		{ refreshUrl: href },
	);
}

/** Browser-only states on top of the ceremony's refusals. */
export type DeviceRebindNotice = DeviceRebindRefusal | "unknown" | "rate_limited" | "busy";

const REFUSAL_COPY: Record<DeviceRebindNotice, [string, string]> = {
	rate_limited: ["Too many tries", "Wait a minute, then start again from Codemem on this device."],
	busy: [
		"Another sign-in is open",
		"Finish or close the other sign-in, then start again from Codemem on this device.",
	],
	unavailable: ["Sign-in can’t continue", "Start again from Codemem on this device."],
	unknown: [
		"Sign-in result unknown",
		"Return to Codemem on this device. It will check whether the change finished.",
	],
	retry: ["Something changed", "Start again from Codemem on this device."],
	current_identity_linked: [
		"This device already has an account",
		"Its Identity is linked to a Google account. Unlink that account first.",
	],
	device_already_bound: ["This device already switched", "A device can switch accounts only once."],
	account_not_linked: [
		"This Google account isn’t set up",
		"Link this Google account from a device that uses the Identity you want, then try again.",
	],
	already_this_identity: [
		"Already using this account",
		"This device already uses that Google account’s Identity.",
	],
	daily_limit: [
		"Too many switches today",
		"This account’s Identity reached today’s limit for switching devices. Try again tomorrow.",
	],
};

/**
 * A refusal at the Google callback: explain it here and send the browser back
 * to the device, which stops waiting and shows the next step.
 */
export function renderDeviceRebindReturnPage(input: {
	reason: DeviceRebindRefusal;
	loopbackRedirect: string;
	attemptId: string;
}): Promise<CoordinatorAuthBrowserPage> {
	const parsed = parseCoordinatorAuthLoopback(input.loopbackRedirect);
	if (!parsed.ok) throw new Error("device_rebind_view_invalid_input");
	const [title, body] = REFUSAL_COPY[input.reason];
	const href = `${parsed.destination}?attempt_id=${encodeURIComponent(input.attemptId)}&refused=${input.reason}`;
	return buildPage(
		title,
		`<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p>Returning to Codemem on this computer.</p><div class="actions"><a class="link" href="${escapeHtml(href)}" referrerpolicy="no-referrer" rel="noreferrer">Return to Codemem</a></div>`,
		undefined,
		{ refreshUrl: href },
	);
}

export function renderDeviceRebindNotice(
	reason: DeviceRebindNotice,
): Promise<CoordinatorAuthBrowserPage> {
	const [title, body] = REFUSAL_COPY[reason];
	return buildPage(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`);
}
