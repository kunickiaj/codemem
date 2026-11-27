/**
 * Invitation bearer tokens at rest.
 *
 * A coordinator looks an invitation up only by the SHA-256 digest of a presented
 * token, never by its stored `token` column. A join request keeps only the
 * digest of the token it was made with, as `sha256:<digest>`.
 */

/** The `token` value of a join request, which keeps only its invitation token's digest. */
export const JOIN_REQUEST_TOKEN_DIGEST_PREFIX = "sha256:";

/** The stored `token` of a join request made with this invitation token digest. */
export function joinRequestStoredToken(tokenDigest: string): string {
	return `${JOIN_REQUEST_TOKEN_DIGEST_PREFIX}${tokenDigest}`;
}

/** The invitation token digest a join request's stored `token` names, or null for a legacy plaintext copy. */
export function joinRequestStoredDigest(stored: string): string | null {
	return stored.startsWith(JOIN_REQUEST_TOKEN_DIGEST_PREFIX)
		? stored.slice(JOIN_REQUEST_TOKEN_DIGEST_PREFIX.length)
		: null;
}

/**
 * The invitation token lookup of this build. 1: a presented token is matched by
 * its digest only, never by the stored `token` column. Workers from version 1 on
 * are the rollback floor that sealing requires.
 */
export const INVITE_TOKEN_LOOKUP_VERSION: number = 1;

/** SQL that is true for a row whose `token` column still holds a bearer token. */
export const PLAINTEXT_TOKEN_SQL = "instr(token, ':') = 0";

/** Whether a stored `token` value is a bearer token, not a placeholder that names its row. */
export function isPlaintextInviteToken(stored: string | null | undefined): stored is string {
	return typeof stored === "string" && stored.length > 0 && !stored.includes(":");
}

/** A request about invitation tokens that the coordinator refuses with a fixed code and status. */
export class InviteTokenRefusal extends Error {
	constructor(
		readonly code: string,
		readonly status: 409 | 500 | 503,
	) {
		super(code);
		this.name = "InviteTokenRefusal";
	}
}

/**
 * Refuses to hand out a stored invitation whose `token` column holds no bearer
 * token, such as one a later Worker sealed. Its link would carry the placeholder.
 */
export function assertBearerInviteToken(stored: string | null | undefined): void {
	if (!isPlaintextInviteToken(stored)) throw new InviteTokenRefusal("invite_link_unavailable", 409);
}

/** A stored invitation returned to a caller that builds its link, once its token is a bearer token. */
export function bearerInvite<T extends { token: string }>(invite: T): T {
	assertBearerInviteToken(invite.token);
	return invite;
}
