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

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function toBase64Url(base64: string): string {
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	return padded + "=".repeat((4 - (padded.length % 4)) % 4);
}

/** Encode an invite payload as a compact base64url string (no padding). */
export function encodeInvitePayload(payload: InvitePayload): string {
	const json = JSON.stringify(payload);
	const bytes = new TextEncoder().encode(json);
	return toBase64Url(bytesToBase64(bytes));
}

/** Decode a base64url invite payload string back to an InvitePayload. */
export function decodeInvitePayload(value: string): InvitePayload {
	const json = new TextDecoder().decode(base64ToBytes(fromBase64Url(value)));
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
