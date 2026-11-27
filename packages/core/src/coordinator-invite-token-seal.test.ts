import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	INVITE_TOKEN_SEAL_COLUMNS,
	INVITE_TOKEN_SEAL_MIGRATION_NAME,
	INVITE_TOKEN_SEAL_MIGRATION_SQL,
	InviteTokenKeyring,
	InviteTokenSealError,
	inviteTokenKeysFromEnv,
	parseInviteTokenKey,
} from "./coordinator-invite-token-seal.js";

const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
const key = () => randomBytes(32).toString("hex");

async function sealError(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(InviteTokenSealError);
	return (error as InviteTokenSealError).code;
}

describe("InviteTokenKeyring", () => {
	it("opens what it seals, with a fresh nonce for each seal", async () => {
		// Arrange
		const keyring = await InviteTokenKeyring.from({ current: key() });
		// Act
		const first = await keyring.seal("bearer-token", "invite-a");
		const second = await keyring.seal("bearer-token", "invite-a");
		// Assert
		expect(first.ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u);
		expect(first.ciphertext).not.toContain("bearer-token");
		expect(first.ciphertext).not.toBe(second.ciphertext);
		expect(first.keyId).toBe(keyring.currentKeyId);
		expect(await keyring.open(first, "invite-a")).toBe("bearer-token");
		expect(await keyring.open(second, "invite-a")).toBe("bearer-token");
	});

	it("refuses a ciphertext moved to another invitation or changed in any part", async () => {
		// Arrange
		const keyring = await InviteTokenKeyring.from({ current: key() });
		const sealed = await keyring.seal("bearer-token", "invite-a");
		const [version, nonce, body] = sealed.ciphertext.split(".");
		const flip = (text: string) =>
			`${text.slice(0, -2)}${text.at(-2) === "A" ? "B" : "A"}${text.at(-1)}`;
		// Act and assert
		expect(await sealError(keyring.open(sealed, "invite-b"))).toBe("invite_token_unreadable");
		for (const ciphertext of [
			`${version}.${flip(String(nonce))}.${body}`,
			`${version}.${nonce}.${flip(String(body))}`,
			`v2.${nonce}.${body}`,
			`${sealed.ciphertext}.extra`,
			"not-a-ciphertext",
		]) {
			expect(await sealError(keyring.open({ ...sealed, ciphertext }, "invite-a"))).toBe(
				"invite_token_unreadable",
			);
		}
	});

	it("opens ciphertext of the previous key after a rotation, and seals with the new one", async () => {
		// Arrange
		const oldKey = key();
		const newKey = key();
		const before = await InviteTokenKeyring.from({ current: oldKey });
		const sealed = await before.seal("bearer-token", "invite-a");
		// Act
		const rotating = await InviteTokenKeyring.from({ current: newKey, previous: oldKey });
		const resealed = await rotating.seal("bearer-token", "invite-a");
		const after = await InviteTokenKeyring.from({ current: newKey });
		// Assert
		expect(rotating.currentKeyId).not.toBe(before.currentKeyId);
		expect(resealed.keyId).toBe(rotating.currentKeyId);
		expect(await rotating.open(sealed, "invite-a")).toBe("bearer-token");
		expect(await after.open(resealed, "invite-a")).toBe("bearer-token");
		expect(await sealError(after.open(sealed, "invite-a"))).toBe("invite_token_key_unavailable");
	});

	it("reports a missing key and an invalid key as different refusals", async () => {
		// Arrange
		const missing = await InviteTokenKeyring.from({ current: " " });
		const invalid = await InviteTokenKeyring.from({ current: "too-short" });
		const sealed = await (await InviteTokenKeyring.from({ current: key() })).seal("t", "i");
		// Assert
		expect(missing.canSeal).toBe(false);
		expect(await sealError(missing.seal("t", "i"))).toBe("invite_token_key_unavailable");
		expect(invalid.canSeal).toBe(false);
		expect(await sealError(invalid.seal("t", "i"))).toBe("invite_token_key_invalid");
		expect(await sealError(invalid.open(sealed, "i"))).toBe("invite_token_key_invalid");
		expect(new InviteTokenSealError("invite_token_key_unavailable").status).toBe(503);
		expect(new InviteTokenSealError("invite_token_unreadable").status).toBe(500);
	});

	it("accepts 32 bytes as hexadecimal, base64 or base64url, and nothing else", () => {
		const bytes = randomBytes(32);
		for (const text of [
			bytes.toString("hex"),
			bytes.toString("base64"),
			bytes.toString("base64url"),
			` ${bytes.toString("hex").toUpperCase()}\n`,
		]) {
			expect(Buffer.from(parseInviteTokenKey(text) ?? [])).toEqual(bytes);
		}
		for (const text of [
			"",
			randomBytes(16).toString("hex"),
			randomBytes(31).toString("base64"),
			"z".repeat(64),
		]) {
			expect(parseInviteTokenKey(text)).toBeNull();
		}
	});

	it("reads both keys from an environment under their documented names", () => {
		expect(
			inviteTokenKeysFromEnv({
				CODEMEM_INVITE_TOKEN_KEY: "current",
				CODEMEM_INVITE_TOKEN_KEY_PREVIOUS: "previous",
			}),
		).toEqual({ current: "current", previous: "previous" });
		expect(inviteTokenKeysFromEnv({ CODEMEM_INVITE_TOKEN_KEY: 1 })).toEqual({
			current: null,
			previous: null,
		});
	});
});

it("ships the same additive SQL in SQLite initialization, migration 0055 and the Worker schema", () => {
	const migration = readFileSync(
		new URL(`migrations/${INVITE_TOKEN_SEAL_MIGRATION_NAME}`, worker),
		"utf8",
	);
	expect(migration).toBe(INVITE_TOKEN_SEAL_MIGRATION_SQL);
	expect(migration.match(/^ALTER TABLE coordinator_invites ADD COLUMN \w+ TEXT;$/gmu)).toHaveLength(
		INVITE_TOKEN_SEAL_COLUMNS.length,
	);
	const statements = migration
		.replace(/^--.*$/gmu, "")
		.trim()
		.split(";")
		.filter((part) => part.trim());
	expect(statements.every((statement) => statement.trim().startsWith("ALTER TABLE"))).toBe(true);
	const schema = readFileSync(new URL("schema.sql", worker), "utf8");
	for (const column of INVITE_TOKEN_SEAL_COLUMNS) expect(schema).toContain(`  ${column} TEXT`);
});
