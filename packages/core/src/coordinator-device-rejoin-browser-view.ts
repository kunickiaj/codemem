import { buildPage, escapeHtml } from "./coordinator-auth-browser-view.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";

export const DEVICE_REJOIN_BROWSER_PATHS = Object.freeze({
	start: "/auth/rejoin/start",
	confirm: "/auth/rejoin/confirm",
});

function form(action: string, fields: Record<string, string>, label: string) {
	const hidden = Object.entries(fields)
		.map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
		.join("");
	return `<form method="post" action="${action}">${hidden}<button type="submit">${label}</button></form>`;
}

export function renderRejoinStartPage(input: {
	attemptId: string;
	startCode: string;
	csrf: string;
}) {
	return buildPage(
		"Sign in to rejoin",
		`<h1>Sign in to rejoin</h1><p>Choose your Google account, then review where this device will sync.</p><div class="actions">${form(
			DEVICE_REJOIN_BROWSER_PATHS.start,
			{ attempt_id: input.attemptId, start_code: input.startCode, csrf: input.csrf },
			"Continue with Google",
		)}</div>`,
		undefined,
		{ autoSubmit: true, referrerPolicy: "same-origin" },
	);
}

const EXCLUSION: ReadonlyMap<string, string> = new Map([
	["archived", "Archived"],
	["grant_revoked", "Access revoked"],
	["excluded", "Device excluded"],
	["identity_changed", "Removed under a different Identity or no Identity"],
]);

function detail(label: string, value: string) {
	return `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`;
}

type ReturnTarget = { attemptId: string; loopbackRedirect: string };
type BrowserRefusal =
	| "retry"
	| "account_not_linked"
	| "wrong_account"
	| "removal_changed"
	| "no_destination";

const REFUSAL: Record<BrowserRefusal, string> = {
	retry: "Codemem couldn’t verify this sign-in. Start again on this device.",
	account_not_linked: "This Google account doesn’t have a live link to Codemem.",
	wrong_account:
		"This Google account belongs to another Codemem Identity. Sign in with the account linked to this device’s Identity.",
	removal_changed: "The device or its access changed. Start again on this device.",
	no_destination: "This device cannot rejoin any of its former groups.",
};

function refusalUrl(input: ReturnTarget, reason: BrowserRefusal) {
	const parsed = parseCoordinatorAuthLoopback(input.loopbackRedirect);
	if (!parsed.ok) throw new Error("device_rejoin_return_invalid");
	return `${parsed.destination}?attempt_id=${encodeURIComponent(input.attemptId)}&refused=${reason}`;
}

function returnLink(href: string) {
	return `<a class="link" href="${escapeHtml(href)}" referrerpolicy="no-referrer" rel="noreferrer">Return to Codemem</a>`;
}

export function renderRejoinRefusal(input: ReturnTarget, reason: BrowserRefusal) {
	const href = refusalUrl(input, reason);
	return buildPage(
		"Could not rejoin",
		`<h1>Could not rejoin</h1><p>${REFUSAL[reason]}</p><div class="actions">${returnLink(href)}</div>`,
		undefined,
		{ refreshUrl: href },
	);
}

export function renderRejoinReview(
	input: ReturnTarget & {
		deviceId: string;
		identityId: string;
		fingerprint: string;
		account: string;
		destinationsJson: string;
		nonDestinationsJson: string;
		confirmation: string;
		csrf: string;
	},
) {
	const destinations = JSON.parse(input.destinationsJson) as [string, number | null][];
	const excluded = JSON.parse(input.nonDestinationsJson) as [string, string][];
	const groups = destinations.map(([id]) => `<li>${escapeHtml(id)}</li>`).join("");
	const unchanged = excluded
		.map(([id, why]) => `<li>${escapeHtml(id)}: ${escapeHtml(EXCLUSION.get(why) ?? why)}</li>`)
		.join("");
	const action = groups
		? form(
				DEVICE_REJOIN_BROWSER_PATHS.confirm,
				{
					attempt_id: input.attemptId,
					confirmation_hash: input.confirmation,
					csrf: input.csrf,
				},
				"Rejoin groups",
			)
		: returnLink(refusalUrl(input, "no_destination"));
	return buildPage(
		"Review device rejoin",
		`<h1>Review device rejoin</h1><dl>${detail("Google account", input.account)}${detail("Identity", input.identityId)}${detail("Device", input.deviceId)}${detail("Key fingerprint", input.fingerprint)}</dl>
<h2>Groups this device will rejoin</h2>${groups ? `<ul>${groups}</ul>` : `<p>${REFUSAL.no_destination}</p>`}
<h2>Groups this device won’t rejoin</h2>${unchanged ? `<ul>${unchanged}</ul>` : "<p>None</p>"}
<p>Team and Project access follow current sharing.</p><div class="actions">${action}</div>`,
		undefined,
		{ referrerPolicy: "same-origin" },
	);
}

export function renderRejoinNotice({ unknown }: { unknown: boolean }) {
	const title = unknown ? "Rejoin result unknown" : "Could not continue rejoin";
	const next = unknown
		? "Return to Codemem on this device to check the result."
		: "Start again from Codemem on this device.";
	return buildPage(title, `<h1>${title}</h1><p>${next}</p>`);
}
