import {
	AUTH_BROWSER_FORM_ACTIONS,
	buildPage,
	type CoordinatorAuthBrowserPage,
	entityMarkup,
	escapeHtml,
	form,
	profileMarkup,
	projectAccountProfileView,
} from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { formatShortKeyFingerprint } from "./coordinator-auth-key-fingerprint.js";
import { isBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { normalizeDeviceDisplayName } from "./project-invite-identity.js";

export const HEADLESS_LINK_BROWSER_PATHS = Object.freeze({
	code: "/auth/link/device",
	confirm: "/auth/link/device/confirm",
});

export interface HeadlessConsentPageInput {
	profile?: unknown;
	issuer: string;
	identityId: string;
	groupId: string;
	deviceId: string;
	/** enrolled_devices.display_name; the device ID is shown either way. */
	deviceName: string | null;
	/** Stored 64-character hex fingerprint of the device key. */
	fingerprint: string;
	attemptId: string;
	csrfToken: string;
}

// A formatted code is 9 characters; the extra room absorbs stray spaces without truncating.
const CODE_INPUT_MAX_LENGTH = 16;

/**
 * The code is typed, never prefilled: the page takes no query, and a rejected
 * entry renders the same empty form whatever the reason.
 */
export async function renderHeadlessCodePage(input: {
	csrfToken: string;
	rejected?: boolean;
}): Promise<CoordinatorAuthBrowserPage> {
	if (!isBrowserCsrfToken(input.csrfToken)) throw new Error("auth_browser_view_invalid_input");
	const notice = input.rejected
		? '<p role="alert"><strong>Code not recognized or expired.</strong></p>'
		: "";
	return buildPage(
		"Link a device",
		`<h1>Link a device</h1><p>Enter the code shown on your device.</p>${notice}<form method="post" action="${HEADLESS_LINK_BROWSER_PATHS.code}"><input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}"><label for="user_code">Code</label><input id="user_code" name="user_code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="${CODE_INPUT_MAX_LENGTH}" required autofocus><div class="actions"><button type="submit">Continue with Google</button></div></form><p class="note">Only enter a code from a device you are setting up yourself.</p>`,
		undefined,
		{ referrerPolicy: "same-origin" },
	);
}

export async function renderHeadlessCodeLimitedPage(): Promise<CoordinatorAuthBrowserPage> {
	return buildPage(
		"Too many attempts",
		"<h1>Too many attempts</h1><p>Too many codes were entered. Wait a few minutes, then try again.</p>",
	);
}

/**
 * Consent for a headless attempt. The person approving cannot see the device,
 * so the page names its key fingerprint in the short form the terminal prints.
 */
// Device names come from the device being linked, so they must not imitate the fingerprint.
const FINGERPRINT_LIKE = /sha-?256|[0-9a-f]{8,}/iu;

/**
 * The device's own name, or null when it fails the device display-name rules
 * (no control, format or bidi characters, no machine-shaped names) or looks
 * like a fingerprint.
 */
function consentDeviceName(value: string | null): string | null {
	if (value === null) return null;
	try {
		const name = normalizeDeviceDisplayName(value, "device_display_name");
		return FINGERPRINT_LIKE.test(name) ? null : name;
	} catch {
		return null;
	}
}

export async function renderHeadlessConsentPage(
	input: HeadlessConsentPageInput,
): Promise<CoordinatorAuthBrowserPage> {
	const ids = [input.identityId, input.groupId, input.deviceId, input.attemptId];
	if (!ids.every(isAuthControllerId) || !isBrowserCsrfToken(input.csrfToken))
		throw new Error("auth_browser_view_invalid_input");
	const fingerprint = formatShortKeyFingerprint(input.fingerprint);
	const name = consentDeviceName(input.deviceName) ?? "Device";
	// <bdi> keeps the name's text direction from reordering the ID beside it.
	const details =
		entityMarkup({ id: input.identityId }, "Identity") +
		entityMarkup({ id: input.groupId }, "Group") +
		`<dt>Device</dt><dd><bdi>${escapeHtml(name)}</bdi><br><code>${escapeHtml(input.deviceId)}</code></dd>`;
	const keyCheck = `<section aria-label="Device key"><h2>Device key fingerprint</h2><p><code>${escapeHtml(fingerprint)}</code></p></section>`;
	const options = { attemptId: input.attemptId };
	const actions =
		form(HEADLESS_LINK_BROWSER_PATHS.confirm, input.csrfToken, "Approve", options) +
		form(AUTH_BROWSER_FORM_ACTIONS.cancelLink, input.csrfToken, "Cancel", {
			...options,
			secondary: true,
		});
	return buildPage(
		"Link account to a device",
		`<h1>Link account to a device</h1>${profileMarkup(projectAccountProfileView(input.profile, input.issuer))}<section aria-label="Link details"><h2>Link details</h2><dl>${details}</dl></section>${keyCheck}<p role="alert"><strong>Only continue if you ran <code>codemem coordinator link-account --headless</code> on this device yourself in the last 10 minutes and the key fingerprint matches its terminal.</strong></p><div class="actions">${actions}</div>`,
		input.issuer,
		{ referrerPolicy: "same-origin" },
	);
}

/** Shown after approval. The browser gets no session: it never proved it holds the device key. */
export async function renderHeadlessReturnPage(): Promise<CoordinatorAuthBrowserPage> {
	return buildPage(
		"Return to your device",
		"<h1>Account link approved</h1><p>Return to your device's terminal to finish.</p>",
	);
}

/** The desktop confirm route refuses a headless attempt with this page. */
export async function renderHeadlessConfirmElsewherePage(): Promise<CoordinatorAuthBrowserPage> {
	return buildPage(
		"Approve on the device page",
		"<h1>Approve on the device page</h1><p>This account link was started with a code from a device. Approve it on the page that shows the device's key fingerprint.</p>",
	);
}
