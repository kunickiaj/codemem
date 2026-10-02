import { expect, it } from "vitest";
import type {
	CoordinatorAuthLinkConfig as Config,
	CoordinatorAuthLinkCreateInput as CreateInput,
	CoordinatorAuthLinkFinalizeInput as FinalizeInput,
	CoordinatorAuthLinkRequester as Requester,
} from "./coordinator-auth-link-contract.js";
import {
	type Backend,
	enroll,
	type Fixture,
	review,
	setupStore,
} from "./coordinator-auth-store-test-fixtures.js";

// Persistence only: no OIDC verification, route authentication, or .3.3 sessions.
export const PURPOSE = "coordinator-account-link-v1" as const;
export const TTL = 600_000;
export const NOW = 1_791_028_800_000;
export const TABLES = [
	"coordinator_auth_link_attempts",
	"coordinator_auth_account_links",
	"coordinator_auth_link_audit_log",
] as const;
export type LinkFixture = Fixture & { now: number; cfg: Config };
export type Test = ReturnType<typeof backendTest>;
export const cfg: Config = {
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.example.test",
	revision: "a".repeat(64),
	enabled: true,
};
export const signer = {
	groupId: "group-a",
	deviceId: "device-a",
	publicKey: review().publicKey,
	fingerprint: review().fingerprint,
};
export const browserHash = "c".repeat(64);
export const completionHash = "d".repeat(64);
export const device: Requester = { kind: "device", signer };
export const browser: Requester = { kind: "browser", browserTransactionHash: browserHash };

export function attempt(overrides: Partial<CreateInput> = {}): CreateInput {
	return {
		attemptId: "attempt-a",
		signer: { ...signer },
		runtimeVerifierHash: "b".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
		...overrides,
	};
}

export function finalize(overrides: Partial<FinalizeInput> = {}): FinalizeInput {
	return {
		purpose: PURPOSE,
		coordinatorId: cfg.coordinatorId,
		attemptId: "attempt-a",
		groupId: signer.groupId,
		identityId: "identity-a",
		deviceId: signer.deviceId,
		fingerprint: signer.fingerprint,
		runtimeVerifierHash: attempt().runtimeVerifierHash,
		completionSecretHash: completionHash,
		signer: { ...signer },
		...overrides,
	};
}

export function status(state: string, attemptId = "attempt-a") {
	return { attemptId, state, expiresAtMs: NOW + TTL };
}

export function rows(f: Fixture, table: (typeof TABLES)[number]) {
	return f.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

export function snapshot(f: Fixture) {
	return TABLES.map((table) => rows(f, table));
}

export function setIdentity(f: Fixture, identity: string | null) {
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?")
		.run(identity, signer.groupId, signer.deviceId);
}

export async function authorize(f: LinkFixture) {
	await enroll(f.store);
	expect(await f.store.createAuthControllerAttestation(review())).toMatchObject({
		kind: "created",
	});
}

export async function advance(
	f: LinkFixture,
	state: string,
	input = attempt(),
	hash = browserHash,
) {
	await f.store.createAuthLinkAttempt(input, f.cfg);
	if (state === "pending") return;
	await f.store.claimAuthLinkAttempt(
		{ attemptId: input.attemptId, browserTransactionHash: hash },
		f.cfg,
	);
	if (state === "browser_claimed") return;
	await f.store.recordAuthLinkOidcVerified(
		{
			attemptId: input.attemptId,
			browserTransactionHash: hash,
			account: { issuer: f.cfg.issuer, subject: "opaque-subject-a" },
		},
		f.cfg,
	);
	if (state === "oidc_verified") return;
	await f.store.confirmAuthLinkAttempt(
		{
			attemptId: input.attemptId,
			browserTransactionHash: hash,
			completionSecretHash: completionHash,
		},
		f.cfg,
	);
	if (state === "confirmed") return;
	await f.store.finalizeAuthLinkAttempt(finalize({ attemptId: input.attemptId }), f.cfg);
}

export function expectRejected(result: unknown, error: string) {
	expect(result).toEqual({ kind: "rejected", error });
}

export const stages = ["claim", "oidc", "confirm", "finalize", "fail"] as const;
export type Stage = (typeof stages)[number];
export const previousState: Record<Stage, string> = {
	claim: "pending",
	oidc: "browser_claimed",
	confirm: "oidc_verified",
	finalize: "confirmed",
	fail: "confirmed",
};
export async function transition(f: LinkFixture, stage: Stage, config = f.cfg) {
	const input = { attemptId: "attempt-a", browserTransactionHash: browserHash };
	if (stage === "claim") return f.store.claimAuthLinkAttempt(input, config);
	if (stage === "oidc")
		return f.store.recordAuthLinkOidcVerified(
			{ ...input, account: { issuer: config.issuer, subject: "opaque-subject-a" } },
			config,
		);
	if (stage === "confirm")
		return f.store.confirmAuthLinkAttempt(
			{ ...input, completionSecretHash: completionHash },
			config,
		);
	if (stage === "finalize") return f.store.finalizeAuthLinkAttempt(finalize(), config);
	return f.store.failAuthLinkAttempt(
		{ attemptId: "attempt-a", requester: device, reason: "cancelled" },
		config,
	);
}

export function backendTest(backend: Backend) {
	return it.extend<{ fixture: LinkFixture }>({
		fixture: async ({ task: _task }, use) => {
			const clock = { now: NOW };
			const base = setupStore(backend, { authClock: () => clock.now });
			const f: LinkFixture = {
				...base,
				cfg: { ...cfg },
				get now() {
					return clock.now;
				},
				set now(value: number) {
					clock.now = value;
				},
			};
			try {
				await use(f);
			} finally {
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		},
	});
}
