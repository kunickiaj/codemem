import {
	buildPage,
	type CoordinatorAuthBrowserPage,
	escapeHtml,
} from "./coordinator-auth-browser-view.js";
import { isBrowserCsrfToken } from "./coordinator-browser-csrf.js";

export const HEADLESS_LINK_BROWSER_PATHS = Object.freeze({ code: "/auth/link/device" });

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
