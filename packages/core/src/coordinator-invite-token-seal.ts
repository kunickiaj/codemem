/**
 * Invitation bearer tokens at rest.
 *
 * A coordinator stores an invitation's token only as its SHA-256 digest, which
 * acceptance looks up, and as AES-GCM ciphertext, which it decrypts to rebuild
 * the invitation link. The `token` column then holds `sealed:` and 32 random bytes,
 * which no lookup compares with a presented token. The value is random so that a
 * Worker from before digest-only lookups, which also compared a presented token
 * with that column, cannot be given it from anything an attacker can see, such as
 * the invite ID. Deployments still never roll back below digest-only lookups.
 * The ciphertext binds the invite ID
 * as associated data, so it cannot be moved to another row, and records the ID
 * of the key that sealed it, so a previous key can still open it during rotation.
 *
 * Keys are 32 random bytes, configured as 64 hexadecimal characters or as
 * base64 or base64url, in `CODEMEM_INVITE_TOKEN_KEY` and, while rotating,
 * `CODEMEM_INVITE_TOKEN_KEY_PREVIOUS`.
 */

export const INVITE_TOKEN_KEY_ENV = "CODEMEM_INVITE_TOKEN_KEY";
export const INVITE_TOKEN_PREVIOUS_KEY_ENV = "CODEMEM_INVITE_TOKEN_KEY_PREVIOUS";

/** The prefix of the `token` value of an invitation whose bearer token is sealed. */
export const SEALED_INVITE_TOKEN_PREFIX = "sealed:";

/** A new `token` value for a sealed invitation: unique, and derived from nothing public. */
export function sealedInviteTokenPlaceholder(): string {
	return `${SEALED_INVITE_TOKEN_PREFIX}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/**
 * The assignments a consume statement adds once sealed token storage exists, so
 * a consumed invitation keeps no ciphertext from the same statement on.
 */
export const CONSUMED_INVITE_TOKEN_CLEAR_SQL = ", token_ciphertext = NULL, token_key_id = NULL";
/** The `token` value of a join request, which keeps only its invitation token's digest. */
export const JOIN_REQUEST_TOKEN_DIGEST_PREFIX = "sha256:";

const CIPHERTEXT_VERSION = "v1";
const KEY_ID_LABEL = "codemem-invite-token-key-v1:";
const AAD_LABEL = "codemem-invite-token-v1:";
const NONCE_BYTES = 12;

export interface InviteTokenKeyInput {
	current?: string | null;
	previous?: string | null;
}

export type InviteTokenSealErrorCode =
	| "invite_token_lookup_floor_unmet"
	| "invite_token_lookup_floor_unset"
	| "invite_token_key_unavailable"
	| "invite_token_key_file_invalid"
	| "invite_token_key_file_unsupported"
	| "invite_token_key_invalid"
	| "invite_token_storage_unavailable"
	| "invite_token_unreadable";

/** A request about invitation tokens that the coordinator refuses with a fixed code and status. */
export class InviteTokenRefusal extends Error {
	constructor(
		readonly code: string,
		readonly status: 409 | 500 | 503,
		message?: string,
	) {
		super(message ?? code);
		this.name = "InviteTokenRefusal";
	}
}

const SEAL_ERROR_STATUS: Readonly<Record<InviteTokenSealErrorCode, 409 | 500 | 503>> = {
	invite_token_lookup_floor_unmet: 503,
	invite_token_lookup_floor_unset: 409,
	invite_token_key_unavailable: 503,
	invite_token_key_invalid: 503,
	invite_token_key_file_invalid: 503,
	invite_token_key_file_unsupported: 503,
	invite_token_storage_unavailable: 503,
	invite_token_unreadable: 500,
};

/**
 * A sealing failure the coordinator routes answer with a fixed code: 503 while
 * the coordinator lacks a key or storage, 409 while no lookup floor is recorded,
 * and 500 for a row it cannot open. `message` can say more for an operator.
 */
export class InviteTokenSealError extends InviteTokenRefusal {
	declare readonly code: InviteTokenSealErrorCode;

	constructor(code: InviteTokenSealErrorCode, message?: string) {
		super(code, SEAL_ERROR_STATUS[code], message);
		this.name = "InviteTokenSealError";
	}
}

export interface SealedInviteToken {
	ciphertext: string;
	keyId: string;
}

type SubtleKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

interface ImportedKey {
	id: string;
	key: SubtleKey;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) return null;
	const standard = value.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/u, "");
	try {
		const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

function hex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The 32 key bytes of a configured value, or null when it is not one. */
export function parseInviteTokenKey(value: string): Uint8Array<ArrayBuffer> | null {
	const text = value.trim();
	if (/^[0-9a-fA-F]{64}$/u.test(text))
		return Uint8Array.from(text.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
	const bytes = base64Decode(text);
	return bytes?.length === 32 ? bytes : null;
}

async function importKey(value: string): Promise<ImportedKey> {
	const raw = parseInviteTokenKey(value);
	if (!raw) throw new InviteTokenSealError("invite_token_key_invalid");
	const idInput = new Uint8Array([...encoder.encode(KEY_ID_LABEL), ...raw]);
	const id = hex(await crypto.subtle.digest("SHA-256", idInput)).slice(0, 16);
	const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
	return { id, key };
}

const associatedData = (inviteId: string) => encoder.encode(`${AAD_LABEL}${inviteId}`);

/** The current key, which seals, and an optional previous key, which only opens. */
export class InviteTokenKeyring {
	private constructor(
		private readonly current: ImportedKey | null,
		private readonly previous: ImportedKey | null,
		/** Set when a configured value was not a key; every use then fails with it. */
		private readonly invalid: boolean,
	) {}

	static async from(input: InviteTokenKeyInput = {}): Promise<InviteTokenKeyring> {
		const configured = (value: string | null | undefined) => {
			const text = String(value ?? "").trim();
			return text ? text : null;
		};
		const current = configured(input.current);
		const previous = configured(input.previous);
		try {
			return new InviteTokenKeyring(
				current ? await importKey(current) : null,
				previous ? await importKey(previous) : null,
				false,
			);
		} catch (error) {
			if (error instanceof InviteTokenSealError) return new InviteTokenKeyring(null, null, true);
			throw error;
		}
	}

	/** The ID that a new ciphertext records, or null when no current key is configured. */
	get currentKeyId(): string | null {
		return this.current?.id ?? null;
	}

	private requireUsable(): void {
		if (this.invalid) throw new InviteTokenSealError("invite_token_key_invalid");
	}

	/** Whether `seal` can succeed: a valid current key is configured. */
	get canSeal(): boolean {
		return !this.invalid && this.current !== null;
	}

	private sealingKey(): ImportedKey {
		this.requireUsable();
		if (!this.current) throw new InviteTokenSealError("invite_token_key_unavailable");
		return this.current;
	}

	/** Throws the reason this keyring cannot seal, if any. */
	assertCanSeal(): void {
		this.sealingKey();
	}

	async seal(token: string, inviteId: string): Promise<SealedInviteToken> {
		const current = this.sealingKey();
		const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
		const sealed = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: associatedData(inviteId) },
			current.key,
			encoder.encode(token),
		);
		return {
			ciphertext: `${CIPHERTEXT_VERSION}.${base64UrlEncode(nonce)}.${base64UrlEncode(new Uint8Array(sealed))}`,
			keyId: current.id,
		};
	}

	async open(sealed: SealedInviteToken, inviteId: string): Promise<string> {
		this.requireUsable();
		const key = [this.current, this.previous].find((candidate) => candidate?.id === sealed.keyId);
		if (!key) throw new InviteTokenSealError("invite_token_key_unavailable");
		const [version, nonceText, bodyText, extra] = sealed.ciphertext.split(".");
		const nonce = base64Decode(nonceText ?? "");
		const body = base64Decode(bodyText ?? "");
		if (
			version !== CIPHERTEXT_VERSION ||
			extra !== undefined ||
			nonce?.length !== NONCE_BYTES ||
			!body
		)
			throw new InviteTokenSealError("invite_token_unreadable");
		try {
			const plain = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: nonce, additionalData: associatedData(inviteId) },
				key.key,
				body,
			);
			return new TextDecoder().decode(plain);
		} catch {
			throw new InviteTokenSealError("invite_token_unreadable");
		}
	}
}

/** Whether a stored `token` value is a bearer token, not a placeholder that names its row. */
export function isPlaintextInviteToken(stored: string | null | undefined): stored is string {
	return typeof stored === "string" && stored.length > 0 && !stored.includes(":");
}

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

export const INVITE_TOKEN_SEAL_MIGRATION_NAME = "0055_seal_invite_tokens.sql";

/** The additive columns of migration 0055. */
export const INVITE_TOKEN_SEAL_COLUMNS: readonly string[] = Object.freeze([
	"token_ciphertext",
	"token_key_id",
]);

/** The exact text of migration 0055, which SQLite initialization also applies. */
export const INVITE_TOKEN_SEAL_MIGRATION_SQL = `-- Invitation bearer tokens at rest: AES-GCM ciphertext and the ID of the key that sealed it.
-- Additive only. D1 SQL cannot hash or encrypt, so once an operator records the lookup floor the
-- Worker fills these columns and replaces each plaintext token with a placeholder: when an admin
-- copies its link, and in batches through POST /v1/admin/invite-tokens/seal. A Worker from before
-- 0055 keeps working with it applied.
${INVITE_TOKEN_SEAL_COLUMNS.map((column) => `ALTER TABLE coordinator_invites ADD COLUMN ${column} TEXT;`).join("\n")}
`;

/** `present` is 1 when migration 0055, or SQLite initialization, has added the sealed token columns. */
export const INVITE_TOKEN_SEAL_STORAGE_PRESENT_SQL = `SELECT (
	${INVITE_TOKEN_SEAL_COLUMNS.map(
		(column) =>
			`EXISTS (SELECT 1 FROM pragma_table_info('coordinator_invites') WHERE name = '${column}')`,
	).join("\n\tAND ")}
) AS present`;

/** Configured keys from an environment such as a Worker binding set or `process.env`. */
export function inviteTokenKeysFromEnv(
	env: Readonly<Record<string, unknown>> | undefined,
): InviteTokenKeyInput {
	const read = (name: string) => (typeof env?.[name] === "string" ? (env[name] as string) : null);
	return { current: read(INVITE_TOKEN_KEY_ENV), previous: read(INVITE_TOKEN_PREVIOUS_KEY_ENV) };
}
