/**
 * Invite link encoding/decoding for the coordinator join flow.
 *
 * Ported from codemem/coordinator_invites.py.
 */

export interface InvitePayload {
	v: number;
	kind: string;
	coordinator_url: string;
	group_id: string;
	policy: string;
	token: string;
	expires_at: string;
	team_name: string | null;
}

/** Encode an invite payload as a compact base64url string (no padding). */
export function encodeInvitePayload(payload: InvitePayload): string {
	const json = JSON.stringify(payload);
	const bytes = new TextEncoder().encode(json);
	const base64 = Buffer.from(bytes).toString("base64url");
	// base64url from Buffer already omits padding — strip defensively
	return base64.replace(/=+$/, "");
}

/** Decode a base64url invite payload string back to an InvitePayload. */
export function decodeInvitePayload(value: string): InvitePayload {
	// Re-add padding that was stripped
	const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
	const json = Buffer.from(padded, "base64url").toString("utf-8");
	const data: unknown = JSON.parse(json);
	if (typeof data !== "object" || data === null) {
		throw new Error("invalid invite payload");
	}
	return data as InvitePayload;
}

/** Build a `codemem://join?invite=...` link from an encoded payload. */
export function inviteLink(encodedPayload: string): string {
	return `codemem://join?invite=${encodeURIComponent(encodedPayload)}`;
}

/**
 * Extract the raw encoded payload from either a `codemem://` link or a raw value.
 *
 * Throws if a `codemem://` link is provided but has no `invite` query parameter.
 */
export function extractInvitePayload(value: string): string {
	const raw = value.trim();
	if (raw.startsWith("codemem://")) {
		const url = new URL(raw);
		const invite = url.searchParams.get("invite") ?? "";
		if (!invite) {
			throw new Error("invite payload missing from link");
		}
		return invite;
	}
	return raw;
}
