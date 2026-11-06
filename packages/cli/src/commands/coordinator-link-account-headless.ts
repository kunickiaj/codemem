import * as p from "@clack/prompts";
import type { HeadlessLinkApproval, HeadlessLinkCode } from "@codemem/core";

const output = { output: process.stderr };
const STATE_LINES: Readonly<Record<string, string>> = {
	pending: "Waiting for the code…",
	browser_claimed: "Code entered, signing in…",
	oidc_verified: "Reviewing in browser…",
};
const MAX_SHOWN_LENGTH = 200;

/** Account claims come from Google via the coordinator; never let them drive the terminal. */
export function printable(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?").slice(0, MAX_SHOWN_LENGTH);
}

function formatExpiry(expiresAtMs: number): string {
	return new Date(expiresAtMs).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
}

export function showHeadlessCode(code: HeadlessLinkCode): void {
	p.log.step(`On any computer, open ${code.verificationUri} and enter code:  ${code.code}`, output);
	p.log.message(`This device: ${printable(code.deviceId)}  ·  key ${code.fingerprint}`, output);
	p.log.message(`The code expires at ${formatExpiry(code.expiresAtMs)}.`, output);
}

export function showHeadlessState(state: string): void {
	const line = STATE_LINES[state];
	if (line) p.log.info(line, output);
}

/** The y/N or typed confirmation on this device; anything but an explicit yes declines. */
export async function confirmHeadlessApproval(
	identityId: string,
	approval: HeadlessLinkApproval,
	context: { signal: AbortSignal },
): Promise<boolean> {
	const question = `Link Identity ${printable(identityId)} to this Google account?`;
	if (approval.email) {
		const verified =
			approval.emailVerified === true ? "verified by Google" : "email not verified by Google";
		p.log.info(`Approved in the browser by ${printable(approval.email)} (${verified})`, output);
		const answer = await p.confirm({
			message: `${question} (y/N)`,
			initialValue: false,
			signal: context.signal,
			...output,
		});
		return answer === true;
	}
	// Without an email there is little to recognize, so require a deliberate answer.
	const who = approval.displayName ? printable(approval.displayName) : "an account with no email";
	p.log.warn(`Approved in the browser by ${who}`, output);
	const answer = await p.text({
		message: `${question} Type link to confirm.`,
		signal: context.signal,
		...output,
	});
	return !p.isCancel(answer) && answer.trim() === "link";
}
