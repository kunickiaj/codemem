import { expect } from "vitest";
import {
	config,
	input,
	NOW,
	seedEnrollmentSql,
} from "./device-claim-eligibility-fixture.js";
import { AccountChangeOperations } from "../../core/src/coordinator-account-change.js";
import { applyAccountConnectionSchema } from '../../core/src/coordinator-account-connection-schema.js';
import type { AuthLinkBackend } from "../../core/src/coordinator-auth-link.js";
import { authDeviceClaimProvenanceSql } from "../../core/src/coordinator-auth-link-provenance.js";
import type { CoordinatorAuthControllerStore } from "../../core/src/coordinator-auth-controller.js";
import type { CoordinatorAuthLinkStore } from "../../core/src/coordinator-auth-link-contract.js";
import type { CoordinatorAuthBrowserTransactionStore } from "../../core/src/coordinator-auth-browser-transaction-contract.js";
import type { CoordinatorAuthSessionStore } from "../../core/src/coordinator-auth-session-contract.js";

type Store = CoordinatorAuthControllerStore & CoordinatorAuthLinkStore & CoordinatorAuthBrowserTransactionStore & CoordinatorAuthSessionStore;

export { config, input, NOW };
export const hash = (n: number) => n.toString(16).padStart(64, "0");
export const changeTable = "coordinator_account_change_attempts";
export const protectedTables = [
	"coordinator_auth_account_links",
	"coordinator_auth_device_claims",
	"coordinator_auth_sessions",
	"coordinator_identity_group_grants",
	"enrolled_devices",
	"coordinator_device_ownership_bindings",
	"coordinator_auth_account_connection_history",
];

/** Actual V2 creation/finalization and session issuance before installing the fence.
 * Provider claims are trusted fixtures, not live Google verification. */
async function enrollFirst(
	store: Store,
	backend: AuthLinkBackend,
	authority: "device_claim" | "controller_attestation" = "device_claim",
) {
	const exec = (sql: string, ...values: (string | number | null)[]) => backend.run({ sql, values });
	for (const sql of seedEnrollmentSql.split(";").filter((s) => s.trim())) await exec(sql);
	if (authority === "controller_attestation") {
		expect(
			await store.createAuthControllerAttestation({
				attestationId: "controller",
				coordinatorId: config.coordinatorId,
				identityId: input.identityId,
				...input.signer,
				reviewReceiptId: "review",
				evidenceDigest: hash(900),
			}),
		).toMatchObject({ kind: "created" });
	}
	return exec;
}
async function verifyBirth(store: Store, authority: "device_claim" | "controller_attestation") {
	const birth = {
		attemptId: "birth",
		authority:
			authority === "device_claim"
				? { kind: authority, identityId: input.identityId }
				: { kind: authority },
		signer: input.signer,
		runtimeVerifierHash: hash(901),
		browserStartHash: hash(902),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const bc = { ...config, redirectUri: "https://coordinator.example.test/auth/callback" };
	const browser = {
		purpose: "link" as const,
		attemptId: birth.attemptId,
		browserStartHash: birth.browserStartHash,
		stateHash: hash(903),
		binderHash: hash(904),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect(await store.createAuthLinkAttempt(birth, config)).toMatchObject({ kind: "created" });
	expect(await store.startAuthBrowserTransaction(browser, bc)).toMatchObject({ kind: "started" });
	const bound = await store.resolveAuthLinkBrowserTransaction(
		{ attemptId: birth.attemptId, binderHash: browser.binderHash },
		bc,
	);
	if (!bound) throw new Error("fixture browser unavailable");
	expect(await store.consumeAuthBrowserTransaction(browser, bc)).toMatchObject({
		kind: "consumed",
	});
	const pins = { attemptId: birth.attemptId, ...bound };
	expect(
		await store.recordAuthLinkOidcVerified(
			{
				...pins,
				account: { issuer: config.issuer, subject: "account-A" },
				profile: { displayName: "Birth" },
			},
			config,
		),
	).toMatchObject({ kind: "applied" });
	return { birth, bc, browser, pins };
}
async function produceBirth(
	store: Store,
	backend: AuthLinkBackend,
	authority: "device_claim" | "controller_attestation",
) {
	const { birth, bc, browser, pins } = await verifyBirth(store, authority);
	expect(
		await store.confirmAuthLinkAttempt({ ...pins, completionSecretHash: hash(905) }, config),
	).toMatchObject({ kind: "applied" });
	expect(
		await store.finalizeAuthLinkAttempt(
			{
				...birth,
				purpose: "coordinator-account-link-v1",
				coordinatorId: config.coordinatorId,
				groupId: input.signer.groupId,
				identityId: input.identityId,
				deviceId: input.signer.deviceId,
				fingerprint: input.signer.fingerprint,
				completionSecretHash: hash(905),
			},
			config,
		),
	).toMatchObject({ kind: "applied" });
	if (authority === "device_claim")
		expect(
			await backend.first({
				sql: `SELECT ${authDeviceClaimProvenanceSql({ link: "l" })} AS valid FROM coordinator_auth_account_links l`,
				values: [],
			}),
		).toEqual({ valid: 1 });
	expect(
		await store.redeemAuthLinkSessionWithBrowserTransaction(
			{ ...pins, binderHash: browser.binderHash, credentialHash: hash(906) },
			bc,
		),
	).toMatchObject({ kind: "issued" });
}
export async function changeFixture(
	store: Store,
	backend: AuthLinkBackend,
	authority: "device_claim" | "controller_attestation" = "device_claim",
	beforeConnectionInstall?: () => Promise<void>,
) {
	const exec = await enrollFirst(store, backend, authority);
	await produceBirth(store, backend, authority);
	await beforeConnectionInstall?.();
	await applyAccountConnectionSchema(backend);
	const clock = { now: NOW + 100 };
	const operations = new AccountChangeOperations(backend, () => clock.now);
	async function prepare(
		n = 1,
		intent: "refresh" | "disconnect" = "disconnect",
		profile?: unknown,
	) {
		expect(await operations.create(request(n, intent), config)).toBe(true);
		expect(await operations.claimBrowser(materials(n), config)).toBe(true);
		expect(await operations.consumeCallback(materials(n), config)).toMatchObject({
			attemptId: `change-${n}`,
		});
		expect(await operations.recordVerifiedCallback(verified(n, profile), config)).toBe(true);
		if (intent === "disconnect")
			expect(
				await operations.confirmDisconnect(
					{ ...materials(n), completionSecretHash: hash(n * 10 + 4) },
					config,
				),
			).toBe(true);
	}
	return { operations, clock, request, materials, proof, verified, prepare, exec };
}
const request = (n = 1, intent: "refresh" | "disconnect" = "disconnect") => ({
	attemptId: `change-${n}`,
		intent,
		expectedIdentityId: input.identityId,
	signer: input.signer,
	runtimeVerifierHash: hash(n * 10),
	browserStartHash: hash(n * 10 + 1),
	loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
});
const materials = (n = 1) => ({
	attemptId: `change-${n}`,
	browserStartHash: hash(n * 10 + 1),
	stateHash: hash(n * 10 + 2),
	binderHash: hash(n * 10 + 3),
	nonce: "n".repeat(43),
	pkceVerifier: "p".repeat(43),
});
const proof = (n = 1) => ({ ...request(n), completionSecretHash: hash(n * 10 + 4) });
const verified = (
	n = 1,
	profile: unknown = { displayName: "Fresh", email: "person@example.test", emailVerified: true },
) => ({
	...materials(n),
	issuer: config.issuer,
	subject: "account-A",
	profile,
	completionSecretHash: hash(n * 10 + 4),
});
