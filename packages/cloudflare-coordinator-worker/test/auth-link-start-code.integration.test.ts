import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";

const NOW = 1790899200000;
const TTL = 600000;
const hash = () =>
	crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const attemptTable = "coordinator_auth_link_attempts";
const browserTable = "coordinator_auth_browser_transactions";
async function fixture(protectedRow = true) {
	const cfg = {
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.example.test",
		revision: hash(),
		enabled: true,
		redirectUri: "https://coordinator.example.test/auth/callback",
	};
	const freshStore = () => new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const store = freshStore();
	const review = {
		coordinatorId: cfg.coordinatorId,
		groupId: crypto.randomUUID(),
		deviceId: crypto.randomUUID(),
		identityId: crypto.randomUUID(),
		attestationId: crypto.randomUUID(),
		reviewReceiptId: crypto.randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: hash(),
		evidenceDigest: hash(),
	};
	const signer = {
		groupId: review.groupId,
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	};
	const browserStartHash = hash();
	const create = {
		attemptId: crypto.randomUUID(),
		signer,
		runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
		...(protectedRow ? { browserStartHash } : {}),
	};
	const start = {
		purpose: "link" as const,
		attemptId: create.attemptId,
		browserStartHash,
		stateHash: hash(),
		binderHash: hash(),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...signer, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await store.createAuthLinkAttempt(create, cfg)).toMatchObject({ kind: "created" });
	return { cfg, store, freshStore, create, start, signer };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rows(f: Fixture, table = browserTable) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.cfg.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}
async function grants(f: Fixture) {
	const names = [
		"coordinator_auth_account_links",
		"coordinator_auth_sessions",
		"coordinator_auth_session_receipts",
		"coordinator_auth_link_audit_log",
	];
	return Promise.all(names.map((name) => rows(f, name)));
}

it("native D1 rejects omitted, wrong and malformed proof without orphan SDK rows or legacy claim bypass", async () => {
	// Arrange: trusted store metadata, no provider requests or raw browser codes.
	const f = await fixture();
	const before = await rows(f, attemptTable);
	const { browserStartHash: _hash, ...omitted } = f.start;
	const malformed = { ...f.start, browserStartHash: undefined } as unknown as typeof f.start;
	// Act
	const missing = await f.store.startAuthBrowserTransaction(omitted, f.cfg);
	const wrong = await f.store.startAuthBrowserTransaction(
		{ ...f.start, browserStartHash: hash() },
		f.cfg,
	);
	const invalid = await f.store.startAuthBrowserTransaction(malformed, f.cfg);
	const blind = await f.store.claimAuthLinkAttempt(
		{ attemptId: f.create.attemptId, browserTransactionHash: hash() },
		f.cfg,
	);
	const wrongNamespace = await f.store.startAuthBrowserTransaction(f.start, {
		...f.cfg,
		coordinatorId: crypto.randomUUID(),
	});
	const wrongAttempt = await f.store.startAuthBrowserTransaction(
		{ ...f.start, attemptId: crypto.randomUUID() },
		f.cfg,
	);
	// Assert
	for (const result of [missing, wrong, blind, wrongNamespace, wrongAttempt])
		expect(result).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(invalid).toEqual({ kind: "rejected", error: "invalid_input" });
	expect(await rows(f, attemptTable)).toEqual(before);
	expect(await rows(f)).toEqual([]);
	expect(await grants(f)).toEqual([[], [], [], []]);
});

it("native D1 competing protected starts claim once and preserve only the original binder and SDK material", async () => {
	// Arrange: independent store instances share only the isolated D1 binding.
	const f = await fixture();
	const second = {
		...f.start,
		stateHash: hash(),
		binderHash: hash(),
		nonce: "m".repeat(43),
		pkceVerifier: "q".repeat(43),
	};
	// Act
	const results = await Promise.all([
		f.store.startAuthBrowserTransaction(f.start, f.cfg),
		f.freshStore().startAuthBrowserTransaction(second, f.cfg),
	]);
	const winner = results[0].kind === "started" ? f.start : second;
	const loser = winner === f.start ? second : f.start;
	const stored = await rows(f);
	const bound = await f
		.freshStore()
		.resolveAuthLinkBrowserTransaction(
			{ attemptId: f.create.attemptId, binderHash: winner.binderHash },
			f.cfg,
		);
	const wrong = await f.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: f.create.attemptId, binderHash: loser.binderHash },
		f.cfg,
	);
	const replay = await f.store.startAuthBrowserTransaction(
		{ ...loser, stateHash: hash(), binderHash: hash() },
		f.cfg,
	);
	// Assert
	expect(results.filter((result) => result.kind === "started")).toEqual([
		{ kind: "started", expiresAtMs: NOW + TTL },
	]);
	expect(results.filter((result) => result.kind === "rejected")).toHaveLength(1);
	expect(stored).toEqual([
		expect.objectContaining({
			state: "pending",
			binder_hash: winner.binderHash,
			state_hash: winner.stateHash,
			nonce: winner.nonce,
			pkce_verifier: winner.pkceVerifier,
		}),
	]);
	expect(bound).toEqual({ browserTransactionHash: stored[0].browser_transaction_hash });
	expect(wrong).toBeNull();
	expect(replay.kind).toBe("rejected");
	expect(await rows(f)).toEqual(stored);
	expect(await rows(f, attemptTable)).toEqual([
		expect.objectContaining({
			browser_start_hash: f.start.browserStartHash,
			browser_transaction_hash: stored[0].browser_transaction_hash,
			state: "browser_claimed",
		}),
	]);
	expect(await grants(f)).toEqual([[], [], [], []]);
});

it("native D1 legacy NULL rows accept old trusted paths but never accept supplied code", async () => {
	// Arrange
	const f = await fixture(false);
	const direct = await fixture(false);
	const before = await rows(f, attemptTable);
	const { browserStartHash: _hash, ...legacyStart } = f.start;
	// Act
	const denied = await f.store.startAuthBrowserTransaction(f.start, f.cfg);
	const afterDenied = await rows(f, attemptTable);
	const orphanRows = await rows(f);
	const accepted = await f.store.startAuthBrowserTransaction(legacyStart, f.cfg);
	const claimed = await direct.store.claimAuthLinkAttempt(
		{ attemptId: direct.create.attemptId, browserTransactionHash: hash() },
		direct.cfg,
	);
	// Assert
	expect(denied).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(afterDenied).toEqual(before);
	expect(orphanRows).toEqual([]);
	expect(accepted).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
	expect(claimed).toEqual({
		kind: "applied",
		status: {
			attemptId: direct.create.attemptId,
			state: "browser_claimed",
			expiresAtMs: NOW + TTL,
		},
	});
	expect((await rows(f, attemptTable))[0].browser_start_hash).toBeNull();
	expect(await grants(f)).toEqual([[], [], [], []]);
});
