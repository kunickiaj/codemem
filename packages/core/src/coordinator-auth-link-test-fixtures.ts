import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { expect, it } from "vitest";
import { setupV2Store } from "./coordinator-account-schema-sqlite-test-fixtures.js";
import {
	browserProofConfig,
	startBrowserProof,
} from "./coordinator-auth-browser-proof-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export {
	browserProofConfig,
	consumeSigninProof,
	startBrowserProof,
} from "./coordinator-auth-browser-proof-test-fixtures.js";

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
// A real device key: every enrolled codemem device signs with ssh-ed25519, and the
// current account schema derives the canonical key ID from it.
export const deviceKey = {
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
};
/** A second real device key, for a device of another Identity. */
export const otherDeviceKey = realEd25519Key(2);

/** A deterministic real ssh-ed25519 public key and its fingerprint. */
export function realEd25519Key(seed: number): { publicKey: string; fingerprint: string } {
	const der = createPublicKey(
		createPrivateKey({
			key: Buffer.concat([
				Buffer.from("302e020100300506032b657004220420", "hex"),
				Buffer.alloc(32, seed),
			]),
			format: "der",
			type: "pkcs8",
		}),
	).export({ format: "der", type: "spki" });
	const wire = Buffer.concat([
		Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
		der.subarray(-32),
	]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return { publicKey, fingerprint: fingerprintPublicKey(publicKey) };
}
export const signer = {
	groupId: "group-a",
	deviceId: "device-a",
	...deviceKey,
};
export const browserHash = "c".repeat(64);
export const completionHash = "d".repeat(64);
export const device: Requester = { kind: "device", signer };
export const browser: Requester = { kind: "browser", browserTransactionHash: browserHash };

export function attempt(overrides: Partial<CreateInput> = {}): CreateInput {
	// Keep the legacy creation input for tests of direct claims and frozen schemas.
	return {
		authority: { kind: "controller_attestation" },
		attemptId: "attempt-a",
		signer: { ...signer },
		runtimeVerifierHash: "b".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
		...overrides,
	};
}

function fixtureHash(key: string) {
	return createHash("sha256").update(`codemem-test-browser:${key}`).digest("hex");
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

/** A controller review of the fixture's signer: its real device key. */
export function signerReview(
	overrides: Parameters<typeof review>[0] = {},
): ReturnType<typeof review> {
	return review({ ...deviceKey, ...overrides });
}

export async function authorize(f: LinkFixture) {
	await enroll(f.store, signerReview());
	expect(
		await f.store.createAuthControllerAttestation(
			signerReview({ coordinatorId: f.cfg.coordinatorId }),
		),
	).toMatchObject({
		kind: "created",
	});
}

export async function advance(
	f: LinkFixture,
	state: string,
	input = attempt(),
	hash = browserHash,
	options: { subject?: string } = {},
) {
	const creation = { ...input };
	if (state !== "pending" && !Object.hasOwn(input, "browserStartHash")) {
		creation.browserStartHash = fixtureHash(`browser-start:${input.attemptId}`);
	}
	// Later steps assume the attempt exists; a refused creation must fail here, not later.
	expect(await f.store.createAuthLinkAttempt(creation, f.cfg)).toMatchObject({ kind: "created" });
	if (state === "pending") return;
	const materials = await startBrowserProof(f, {
		attemptId: input.attemptId,
		browserTransactionHash: hash,
		...(creation.browserStartHash === undefined
			? {}
			: { browserStartHash: creation.browserStartHash }),
	});
	expect(
		await f.store.consumeAuthBrowserTransaction(materials, browserProofConfig(f)),
	).toMatchObject({
		kind: "consumed",
		purpose: "link",
		attemptId: input.attemptId,
		browserTransactionHash: hash,
	});
	if (state === "browser_claimed") return;
	await f.store.recordAuthLinkOidcVerified(
		{
			attemptId: input.attemptId,
			browserTransactionHash: hash,
			account: { issuer: f.cfg.issuer, subject: options.subject ?? "opaque-subject-a" },
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
	await f.store.finalizeAuthLinkAttempt(
		finalize({ attemptId: input.attemptId, coordinatorId: f.cfg.coordinatorId }),
		f.cfg,
	);
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

/**
 * `accountSchema: "v2"` opens SQLite coordinators as V2 releases left them, for tests whose
 * seeds model rows written before the account extension and then install it. D1 fixtures
 * start on V2 either way.
 */
export function backendTest(backend: Backend, options: { accountSchema?: "current" | "v2" } = {}) {
	return it.extend<{ fixture: LinkFixture }>({
		fixture: async ({ task: _task }, use) => {
			const clock = { now: NOW };
			const base =
				backend === "SQLite" && options.accountSchema === "v2"
					? setupV2Store({ authClock: () => clock.now })
					: setupStore(backend, { authClock: () => clock.now });
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
