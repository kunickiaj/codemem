import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { COORDINATOR_AUTH_STYLE } from "./coordinator-auth-browser-style.js";

const RESULT_PATH = "/codemem/auth/result";
const SCRIPT = `
history.replaceState(null, '', location.pathname);
const receipt = document.querySelector('main').dataset.receipt;
(async () => {
  const deadline = Date.now() + 600000;
  try {
    while (Date.now() < deadline) {
      const response = await fetch('/codemem/auth/result', {
        headers: { 'X-Codemem-Receipt': receipt }, cache: 'no-store', credentials: 'omit'
      });
      if (!response.ok) break;
      if ((await response.json()).linked === true) {
        document.querySelector('h1').textContent = 'Google account linked';
        document.querySelector('.receipt-status').textContent = 'Return to Codemem. You can close this window.';
        window.close();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch {}
  document.querySelector('.receipt-status').textContent = 'Return to Codemem and check status. This window could not confirm the result.';
})();`;
const hash = (text: string) => createHash("sha256").update(text).digest("base64");
export type AccountReceiptOutcome =
	| { linked?: boolean }
	| { intent: "refresh" | "disconnect"; completed: boolean };

function receiptPresentation(intent: "link" | "refresh" | "disconnect") {
	let script = SCRIPT;
	let title = "Finishing account link";
	let description = "Your computer received the confirmation and is checking the link.";
	let waiting =
		"This window will close when linking finishes. If it stays open, return to Codemem and check status.";
	if (intent !== "link") {
		const heading =
			intent === "refresh" ? "Google account refreshed" : "Google account disconnected";
		script = SCRIPT.replace(
			"(await response.json()).linked === true",
			`((result) => result.intent === '${intent}' && result.completed === true)(await response.json())`,
		).replace("Google account linked", heading);
		title = intent === "refresh" ? "Finishing account refresh" : "Finishing account disconnect";
		description = "Your computer received the confirmation and is checking the account change.";
		waiting =
			"This window will close when the account change finishes. If it stays open, return to Codemem and check status.";
	}
	return { script, title, description, waiting };
}
function trustedReceiptRequest(
	request: IncomingMessage,
	authority: string,
	token: string,
): boolean {
	const hosts = request.rawHeaders.filter(
		(value, index) => index % 2 === 0 && value.toLowerCase() === "host",
	);
	return (
		request.method === "GET" &&
		hosts.length === 1 &&
		request.headers.host === authority &&
		request.headers["x-codemem-receipt"] === token &&
		request.headers["sec-fetch-site"] === "same-origin" &&
		request.headers["sec-fetch-mode"] === "cors" &&
		request.headers["transfer-encoding"] === undefined &&
		(request.headers["content-length"] === undefined || request.headers["content-length"] === "0")
	);
}

/** The browser may lose its opener across provider COOP isolation. Only the
 * trusted runtime can signal successful finalization to this same-origin receipt.
 */
export function createAccountLinkReceipt(intent: "link" | "refresh" | "disconnect" = "link") {
	const { script, title, description, waiting } = receiptPresentation(intent);
	const token = randomBytes(32).toString("base64url");
	let delivered = false;
	let linked = false;
	let acknowledge = () => {};
	const acknowledged = new Promise<void>((resolve) => {
		acknowledge = resolve;
	});
	const headers = {
		"Content-Security-Policy": `default-src 'none'; style-src 'sha256-${hash(COORDINATOR_AUTH_STYLE)}'; script-src 'sha256-${hash(script)}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
	};
	return {
		headers,
		page: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · Codemem</title><style>${COORDINATOR_AUTH_STYLE}</style></head><body><main data-receipt="${token}"><p class="brand">codemem</p><h1>${title}…</h1><p>${description}</p><p class="receipt-status" role="status">${waiting}</p><p class="note">No more sign-in steps are needed here.</p></main><script>${script}</script></body></html>`,
		delivered() {
			delivered = true;
		},
		handle(request: IncomingMessage, response: ServerResponse, authority: string): boolean {
			if (request.url !== RESULT_PATH) return false;
			const allowed = delivered && trustedReceiptRequest(request, authority, token);
			response.writeHead(allowed ? 200 : 403, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
			});
			if (allowed && linked) response.once("finish", acknowledge);
			const result =
				intent === "link"
					? { linked: allowed && linked }
					: { intent, completed: allowed && linked };
			response.end(JSON.stringify(result));
			return true;
		},
		async finish(options?: AccountReceiptOutcome): Promise<void> {
			const completed =
				options &&
				("intent" in options
					? options.intent === intent && options.completed === true
					: intent === "link" && options.linked === true);
			if (!completed || !delivered) return;
			linked = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					acknowledged,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 1500);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
