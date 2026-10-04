import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { afterEach, expect, it } from "vitest";

const db = env.COORDINATOR_DB;
const NOW = 1790899200000;
const tables = [
	"link_attempts",
	"account_links",
	"link_audit_log",
	"browser_transactions",
	"controller_attestations",
	"sessions",
	"session_receipts",
].map((name) => `coordinator_auth_${name}`);
const owned: string[] = [];
afterEach(async () => {
	for (const id of owned.splice(0)) {
		await db.batch([
			...tables.map((table) =>
				db.prepare(`DELETE FROM ${table} WHERE coordinator_id = ?`).bind(id),
			),
			...["enrolled_devices", "groups"].map((table) =>
				db.prepare(`DELETE FROM ${table} WHERE group_id = ?`).bind(id),
			),
		]);
	}
});

async function fixture(destination: string) {
	const id = randomUUID();
	owned.push(id);
	const time = { now: NOW };
	const store = new D1CoordinatorStore(db, { authClock: () => time.now });
	const cfg = {
		coordinatorId: id,
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		enabled: true,
	};
	const signer = { groupId: id, deviceId: id, publicKey: "fixture-key", fingerprint: cfg.revision };
	const review = {
		...signer,
		coordinatorId: id,
		identityId: id,
		attestationId: id,
		reviewReceiptId: id,
		evidenceDigest: cfg.revision,
	};
	await store.createGroup(id, "Fixture group");
	await store.enrollDevice(id, { ...signer, identityId: null });
	const authorized = await store.createAuthControllerAttestation(review);
	expect(authorized.kind).toBe("created");
	await store.createAuthLinkAttempt(
		{ attemptId: id, signer, runtimeVerifierHash: cfg.revision, loopbackRedirect: destination },
		cfg,
	);
	const proof = { attemptId: id, browserTransactionHash: "e".repeat(64) };
	// Trusted legacy claim/account inputs; no HTTP or OIDC verification claim.
	await store.claimAuthLinkAttempt(proof, cfg);
	const account = { issuer: cfg.issuer, subject: "fixture-subject" };
	await store.recordAuthLinkOidcVerified({ ...proof, account }, cfg);
	return { id, time, store, cfg, proof };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(f: Fixture) {
	return Promise.all(
		tables.map(async (table) => {
			const result = await db
				.prepare(`SELECT * FROM ${table} WHERE coordinator_id = ?`)
				.bind(f.id)
				.all();
			return result.results;
		}),
	);
}

it.each(["http://127.0.0.1:80/codemem/auth/complete", "http://[::1]:65535/codemem/auth/complete"])(
	"native D1 preserves %s and rejects wrong proof/time/state",
	async (destination) => {
		// Arrange
		const f = await fixture(destination);
		const before = await snapshot(f);
		const wrongProof = { ...f.proof, browserTransactionHash: "f".repeat(64) };
		// Act
		const valid = await f.store.readAuthLinkCompletionDestination(f.proof, f.cfg);
		const wrong = await f.store.readAuthLinkCompletionDestination(wrongProof, f.cfg);
		f.time.now = NOW - 1;
		const future = await f.store.readAuthLinkCompletionDestination(f.proof, f.cfg);
		f.time.now = NOW + 600000;
		const expired = await f.store.readAuthLinkCompletionDestination(f.proof, f.cfg);
		// Assert: no proof consumption, account links, session authority or nonce changes.
		expect(valid).toEqual({ destination });
		expect([wrong, future, expired]).toEqual([null, null, null]);
		expect(await snapshot(f)).toEqual(before);
		// Arrange: explicit confirmation closes this read window.
		f.time.now = NOW;
		const confirmation = { ...f.proof, completionSecretHash: "f".repeat(64) };
		await f.store.confirmAuthLinkAttempt(confirmation, f.cfg);
		const confirmed = await snapshot(f);
		// Act
		const closed = await f.store.readAuthLinkCompletionDestination(f.proof, f.cfg);
		// Assert
		expect(closed).toBeNull();
		expect(await snapshot(f)).toEqual(confirmed);
	},
);

it("native D1 rejects corrupt saved redirect without mutation", async () => {
	// Arrange: ordinary URL column overwrite does not disable SQL CHECKs.
	const f = await fixture("http://127.0.0.1:65535/codemem/auth/complete");
	const sql =
		"UPDATE coordinator_auth_link_attempts SET loopback_redirect = ? WHERE coordinator_id = ?";
	await db.prepare(sql).bind("http://user@[::1]:80/codemem/auth/complete?x=1", f.id).run();
	const before = await snapshot(f);
	// Act
	const corrupt = await f.store.readAuthLinkCompletionDestination(f.proof, f.cfg);
	// Assert
	expect(corrupt).toBeNull();
	expect(await snapshot(f)).toEqual(before);
});
