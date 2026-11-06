import { expect } from "vitest";
import { browserConfig, materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import type { CoordinatorAuthLinkCreateInput } from "./coordinator-auth-link-contract.js";
import {
	type CoordinatorAuthLinkHeadlessCreateInput,
	type CoordinatorAuthLinkHeadlessFinalizeInput,
	hashHeadlessUserCode,
} from "./coordinator-auth-link-headless.js";
import {
	attempt,
	authorize,
	completionHash,
	finalize,
	type LinkFixture,
	signer,
} from "./coordinator-auth-link-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";

// Trusted persistence metadata only; no provider token, route, or signature verification.
export type Authority = "controller_attestation" | "device_claim";
export const AUTHORITIES: Authority[] = ["controller_attestation", "device_claim"];
export const USER_CODE = "BCDFGHJK";
export const HEADLESS_ID = "headless-a";
export const DESKTOP_ID = "attempt-a";
export const HEADLESS_VERIFIER = "7".repeat(64);
export const DESKTOP_START = "6".repeat(64);
export const SUBJECT = "opaque-subject-a";
export const PROFILE = {
	displayName: "Ada Example",
	email: "ada@example.test",
	emailVerified: true,
};

// An unowned enrolled device: eligible to claim Identity identity-a without a controller review.
const claimInput = {
	identityId: "identity-a",
	signer: {
		groupId: "group-a",
		deviceId: "device-a",
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
	},
};
const seedEnrollmentSql = `INSERT INTO groups (group_id,created_at) VALUES ('group-a','2026-10-01T00:00:00.000Z');
INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,created_at)
 VALUES ('group-a','device-a','${CANONICAL_PUBLIC_KEY}','${"a".repeat(64)}',NULL,'created');`;

export function signerFor(kind: Authority) {
	return kind === "device_claim" ? { ...claimInput.signer } : { ...signer };
}

function authorityFor(kind: Authority): CoordinatorAuthLinkCreateInput["authority"] {
	if (kind === "device_claim") return { kind, identityId: claimInput.identityId };
	return { kind };
}

export async function authorizeFor(f: LinkFixture, kind: Authority) {
	if (kind === "device_claim") f.db.exec(seedEnrollmentSql);
	else await authorize(f);
}

export async function headlessCreate(
	kind: Authority = "controller_attestation",
	overrides: Partial<CoordinatorAuthLinkHeadlessCreateInput> = {},
): Promise<CoordinatorAuthLinkHeadlessCreateInput> {
	return {
		authority: authorityFor(kind),
		attemptId: HEADLESS_ID,
		signer: signerFor(kind),
		runtimeVerifierHash: HEADLESS_VERIFIER,
		userCodeHash: await hashHeadlessUserCode(USER_CODE),
		...overrides,
	};
}

export function desktopCreate(kind: Authority = "controller_attestation") {
	return attempt({
		authority: authorityFor(kind),
		attemptId: DESKTOP_ID,
		signer: signerFor(kind),
		browserStartHash: DESKTOP_START,
	});
}

export function headlessStart(userCodeHash: string, value = 1) {
	const { purpose: _purpose, ...rest } = materials(value);
	return { ...rest, userCodeHash };
}

export function desktopStart(attemptId: string, browserStartHash: string, value = 2) {
	return { ...materials(value), purpose: "link" as const, attemptId, browserStartHash };
}

export function attemptRow(f: LinkFixture, attemptId: string) {
	return f.db
		.prepare("SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id = ?")
		.get(attemptId) as Record<string, unknown>;
}

/** Advances through the shared browser and OIDC stages; returns the browser proof. */
export async function verifyAccount(
	f: LinkFixture,
	start: { stateHash: string; binderHash: string },
	attemptId: string,
	subject = SUBJECT,
) {
	const consumed = await f.store.consumeAuthBrowserTransaction(start, browserConfig);
	if (consumed.kind !== "consumed") throw new Error("fixture_not_consumed");
	const browser = { attemptId, browserTransactionHash: consumed.browserTransactionHash };
	const account = { issuer: f.cfg.issuer, subject };
	expect(
		await f.store.recordAuthLinkOidcVerified({ ...browser, account, profile: PROFILE }, f.cfg),
	).toMatchObject({ kind: "applied" });
	return { ...browser, binderHash: start.binderHash };
}

export async function headlessVerified(f: LinkFixture, kind: Authority = "controller_attestation") {
	await authorizeFor(f, kind);
	const create = await headlessCreate(kind);
	expect(await f.store.createHeadlessAuthLinkAttempt(create, f.cfg)).toMatchObject({
		kind: "created",
	});
	const start = headlessStart(create.userCodeHash);
	expect(await f.store.startHeadlessAuthLinkBrowserTransaction(start, browserConfig)).toMatchObject(
		{ kind: "started", attemptId: HEADLESS_ID },
	);
	return verifyAccount(f, start, HEADLESS_ID);
}

export async function headlessConfirmed(
	f: LinkFixture,
	kind: Authority = "controller_attestation",
) {
	const browser = await headlessVerified(f, kind);
	const { binderHash: _binder, ...proof } = browser;
	expect(await f.store.confirmHeadlessAuthLinkAttempt(proof, f.cfg)).toMatchObject({
		kind: "applied",
	});
	return browser;
}

export async function desktopVerified(
	f: LinkFixture,
	kind: Authority = "controller_attestation",
	options: { authorized?: boolean } = {},
) {
	if (!options.authorized) await authorizeFor(f, kind);
	expect(await f.store.createAuthLinkAttempt(desktopCreate(kind), f.cfg)).toMatchObject({
		kind: "created",
	});
	const start = desktopStart(DESKTOP_ID, DESKTOP_START);
	expect(await f.store.startAuthBrowserTransaction(start, browserConfig)).toMatchObject({
		kind: "started",
	});
	return verifyAccount(f, start, DESKTOP_ID);
}

export async function desktopConfirmed(f: LinkFixture, kind: Authority = "controller_attestation") {
	const browser = await desktopVerified(f, kind);
	const { binderHash: _binder, ...proof } = browser;
	expect(
		await f.store.confirmAuthLinkAttempt({ ...proof, completionSecretHash: completionHash }, f.cfg),
	).toMatchObject({ kind: "applied" });
	return browser;
}

export function headlessFinalize(
	f: LinkFixture,
	kind: Authority = "controller_attestation",
	subject = SUBJECT,
): CoordinatorAuthLinkHeadlessFinalizeInput {
	const s = signerFor(kind);
	return {
		...finalize({
			attemptId: HEADLESS_ID,
			coordinatorId: f.cfg.coordinatorId,
			runtimeVerifierHash: HEADLESS_VERIFIER,
			completionSecretHash: HEADLESS_VERIFIER,
			signer: s,
			fingerprint: s.fingerprint,
		}),
		approvedAccount: { issuer: f.cfg.issuer, subject },
	};
}

export function desktopFinalize(f: LinkFixture, kind: Authority = "controller_attestation") {
	const s = signerFor(kind);
	return finalize({
		attemptId: DESKTOP_ID,
		coordinatorId: f.cfg.coordinatorId,
		signer: s,
		fingerprint: s.fingerprint,
	});
}

/** Link effects without per-attempt identifiers, so desktop and headless can be compared. */
export function linkEffects(f: LinkFixture) {
	const strip = ({
		link_id: _l,
		attempt_id: _a,
		device_claim_id: _d,
		...rest
	}: Record<string, unknown>) => rest;
	const all = (table: string) =>
		(f.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).map(strip);
	return {
		links: all("coordinator_auth_account_links"),
		audit: all("coordinator_auth_link_audit_log"),
		profiles: f.db
			.prepare(
				"SELECT display_name, email, email_verified, link_id IS NOT NULL AS published FROM coordinator_auth_link_profiles",
			)
			.all() as Record<string, unknown>[],
		claims: all("coordinator_auth_device_claims").map(({ claim_id: _c, ...rest }) => rest),
	};
}
