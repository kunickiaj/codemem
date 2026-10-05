import { env, exports } from "cloudflare:workers";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";

const NOW = 1791028800000;
const ROOT = "/v1/auth/link-attempts";
const runtimeProof = Buffer.alloc(32, 17).toString("base64url");
const completion = Buffer.alloc(32, 29).toString("base64url");
const hash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
type Fixture = Awaited<ReturnType<typeof setup>>;
const fixtures: Fixture[] = [];
function identity() {
	const { publicKey: pub, privateKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(pub.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(4 + kind.length + 4 + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return {
		deviceId: randomUUID(),
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		privateKey,
	};
}
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(async () => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	for (const f of fixtures.splice(0)) {
		await env.COORDINATOR_DB.batch([
			...[
				"link_audit_log",
				"account_links",
				"browser_transactions",
				"link_attempts",
				"controller_attestations",
			].map((name) =>
				env.COORDINATOR_DB.prepare(
					`DELETE FROM coordinator_auth_${name} WHERE coordinator_id = ?`,
				).bind(f.config.coordinatorId),
			),
			env.COORDINATOR_DB.prepare(
				"DELETE FROM request_nonces WHERE device_id IN (SELECT device_id FROM enrolled_devices WHERE group_id = ?)",
			).bind(f.review.groupId),
			env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(
				f.review.groupId,
			),
			env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(f.review.groupId),
		]);
	}
});
async function setup(options: { reviewed?: boolean } = {}) {
	const key = identity();
	const coordinatorId = randomUUID();
	const groupId = randomUUID();
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const config = {
		coordinatorId,
		enabled: true,
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		redirectUri: "https://coordinator.example.test/auth/callback",
	};
	const review = {
		...key,
		coordinatorId,
		groupId,
		identityId: randomUUID(),
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
		evidenceDigest: "b".repeat(64),
	};
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, key);
	if (options.reviewed !== false)
		expect((await store.createAuthControllerAttestation(review)).kind).toBe("created");
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: verifyCloudflareCoordinatorRequest,
		authLink: { config, storeFactory: () => store },
	});
	const f = { key, store, config, review, app, attemptId: randomUUID() };
	fixtures.push(f);
	return f;
}
function createBody(f: Fixture) {
	return {
		group_id: f.review.groupId,
		attempt_id: f.attemptId,
		runtime_verifier_hash: hash(runtimeProof),
		browser_start_hash: "c".repeat(64),
		loopback_redirect: "http://[::1]:80/codemem/auth/complete",
	};
}
function finalBody(f: Fixture) {
	return {
		purpose: "coordinator-account-link-v1",
		coordinator_id: f.config.coordinatorId,
		group_id: f.review.groupId,
		attempt_id: f.attemptId,
		identity_id: f.review.identityId,
		device_id: f.key.deviceId,
		fingerprint: f.key.fingerprint,
		runtime_verifier: runtimeProof,
		completion,
	};
}
function init(f: Fixture, path: string, value: unknown, method = "POST") {
	const body = method === "GET" ? "" : JSON.stringify(value);
	const timestamp = String(NOW / 1000);
	const nonce = randomBytes(16).toString("hex");
	const signature = sign(
		null,
		buildCanonicalRequest(method, path, timestamp, nonce, Buffer.from(body)),
		f.key.privateKey,
	);
	return {
		method,
		headers: {
			"content-type": "application/json",
			"X-Opencode-Device": f.key.deviceId,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": nonce,
			"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
		},
		...(method === "GET" ? {} : { body }),
	};
}
function request(f: Fixture, path = ROOT, value: unknown = createBody(f), method = "POST") {
	return f.app.request(`https://coordinator.example.test${path}`, init(f, path, value, method));
}
async function rows(f: Fixture, name: string) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM coordinator_auth_${name} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.config.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}
async function protectedData() {
	const tables = [
		"groups",
		"enrolled_devices",
		"coordinator_scopes",
		"coordinator_scope_memberships",
		"coordinator_bootstrap_grants",
		"coordinator_auth_sessions",
		"coordinator_auth_session_receipts",
		"coordinator_auth_account_profiles",
	];
	return Promise.all(
		tables.map(async (name) => [
			name,
			(await env.COORDINATOR_DB.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results,
		]),
	);
}
function privateResponse(text: string) {
	for (const secret of [
		runtimeProof,
		completion,
		hash(runtimeProof),
		hash(completion),
		"c".repeat(64),
		"subject-private",
		"public_key",
		"pkce_verifier",
		"browser_start",
	])
		expect(text).not.toContain(secret);
}
function browserInput(f: Fixture, value = 1) {
	return {
		purpose: "link" as const,
		attemptId: f.attemptId,
		browserStartHash: "c".repeat(64),
		stateHash: value.toString(16).padStart(64, "0"),
		binderHash: (value + 1).toString(16).padStart(64, "0"),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
}
async function confirm(f: Fixture) {
	const input = browserInput(f);
	expect((await f.store.startAuthBrowserTransaction(input, f.config)).kind).toBe("started");
	const consumed = await f.store.consumeAuthBrowserTransaction(input, f.config);
	if (consumed.kind !== "consumed") throw new Error("fixture consume failed");
	const browser = {
		attemptId: f.attemptId,
		browserTransactionHash: consumed.browserTransactionHash,
	};
	expect(
		(
			await f.store.recordAuthLinkOidcVerified(
				{ ...browser, account: { issuer: f.config.issuer, subject: "subject-private" } },
				f.config,
			)
		).kind,
	).toBe("applied");
	expect(
		(
			await f.store.confirmAuthLinkAttempt(
				{ ...browser, completionSecretHash: hash(completion) },
				f.config,
			)
		).kind,
	).toBe("applied");
}

it("native D1 signed create, protected browser proof, finalize and retry preserve access", async () => {
	// Arrange: browser metadata operations are trusted setup, not fake Google exchange.
	const f = await setup();
	const before = await protectedData();
	// Act
	const created = await request(f);
	await confirm(f);
	const path = `${ROOT}/${f.attemptId}/finalize`;
	const signed = init(f, path, finalBody(f));
	const finalized = await f.app.request(path, signed);
	const replay = await f.app.request(path, signed);
	const retry = await request(f, path, finalBody(f));
	const status = await request(
		f,
		`${ROOT}/${f.attemptId}?group_id=${f.review.groupId}`,
		undefined,
		"GET",
	);
	// Assert
	expect(created.status).toBe(201);
	expect(await created.json()).toEqual({
		status: { attemptId: f.attemptId, state: "pending", expiresAtMs: NOW + 600000 },
		identity_id: f.review.identityId,
		coordinator_id: f.config.coordinatorId,
	});
	expect(finalized.status).toBe(200);
	expect(replay.status).toBe(401);
	expect(retry.status).toBe(200);
	expect(status.status).toBe(200);
	for (const response of [finalized, retry, status]) {
		expect(response.headers.get("set-cookie")).toBeNull();
		privateResponse(await response.text());
	}
	expect(await rows(f, "account_links")).toHaveLength(1);
	expect(await rows(f, "link_audit_log")).toHaveLength(1);
	expect(await protectedData()).toEqual(before);
});
it("native verifier rejects tampered nonce and unreviewed key possession without policy grant", async () => {
	// Arrange
	const blind = await setup({ reviewed: false });
	const reviewed = await setup();
	const before = await protectedData();
	const signed = init(reviewed, ROOT, createBody(reviewed));
	signed.headers["X-Opencode-Nonce"] = randomBytes(16).toString("hex");
	// Act
	const tampered = await reviewed.app.request(ROOT, signed);
	const noController = await request(blind);
	// Assert
	expect(tampered.status).toBe(401);
	expect(noController.status).toBe(403);
	for (const f of [blind, reviewed]) {
		expect(await rows(f, "link_attempts")).toEqual([]);
		expect(await rows(f, "account_links")).toEqual([]);
	}
	privateResponse(await tampered.text());
	privateResponse(await noController.text());
	expect(await protectedData()).toEqual(before);
});
it("native signed cancel retires only its attempt and cannot cancel a different signer", async () => {
	// Arrange
	const f = await setup();
	expect((await request(f)).status).toBe(201);
	expect((await f.store.startAuthBrowserTransaction(browserInput(f), f.config)).kind).toBe(
		"started",
	);
	const signin = {
		purpose: "signin" as const,
		stateHash: "e".repeat(64),
		binderHash: "f".repeat(64),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect((await f.store.startAuthBrowserTransaction(signin, f.config)).kind).toBe("started");
	const other = identity();
	await f.store.enrollDevice(f.review.groupId, other);
	const spoof = { ...f, key: other };
	const before = await protectedData();
	const pending = await rows(f, "browser_transactions");
	// Act
	const denied = await request(spoof, `${ROOT}/${f.attemptId}/cancel`, {
		group_id: f.review.groupId,
	});
	const afterDenied = await rows(f, "browser_transactions");
	const cancelled = await request(f, `${ROOT}/${f.attemptId}/cancel`, {
		group_id: f.review.groupId,
	});
	// Assert
	expect(denied.status).toBe(403);
	expect(afterDenied).toEqual(pending);
	expect(cancelled.status).toBe(200);
	privateResponse(await cancelled.text());
	const after = await rows(f, "browser_transactions");
	expect(after.find((r) => r.attempt_id === f.attemptId)).toMatchObject({
		state: "expired",
		nonce: null,
		pkce_verifier: null,
	});
	expect(after.find((r) => r.purpose === "signin")).toEqual(
		pending.find((r) => r.purpose === "signin"),
	);
	expect(await protectedData()).toEqual(before);
	expect(await rows(f, "account_links")).toEqual([]);
});
it("default Worker leaves every signed-device link route disabled", async () => {
	// Arrange
	const f = await setup();
	const before = await protectedData();
	const cases: [string, unknown, string][] = [
		[ROOT, createBody(f), "POST"],
		[`${ROOT}/${f.attemptId}?group_id=${f.review.groupId}`, undefined, "GET"],
		[`${ROOT}/${f.attemptId}/finalize`, finalBody(f), "POST"],
		[`${ROOT}/${f.attemptId}/cancel`, { group_id: f.review.groupId }, "POST"],
	];
	// Act: the local Worker export is not an external fetch.
	const responses = await Promise.all(
		cases.map(([path, body, method]) =>
			exports.default.fetch(`https://coordinator.example.test${path}`, init(f, path, body, method)),
		),
	);
	// Assert
	expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
	expect(await protectedData()).toEqual(before);
	expect(await rows(f, "link_attempts")).toEqual([]);
});
