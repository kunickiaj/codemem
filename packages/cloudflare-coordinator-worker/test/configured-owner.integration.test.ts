import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { oidcFixture } from "../../core/src/coordinator-oidc-test-fixtures.js";
import type { OwnerAttempt } from "../../core/src/coordinator-owner-enrollment-proof.js";
import { ownerEnrollmentFinalMessage } from "../../core/src/coordinator-owner-enrollment-proof.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { ownerEnrollmentStartMessage } from "../../core/src/owner-enrollment-start.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import defaultWorker, { createConfiguredCloudflareCoordinatorWorker } from "../src/index.js";
import {
	config,
	exec,
	NOW,
	ORIGIN,
	pendingKey,
	proof,
	rows,
	snapshot,
} from "./owner-ceremony-test-fixtures.js";

const CAPABILITIES = "/v1/admin/owner-enrollment-capabilities";
const ATTEMPTS = "/v1/auth/owner-attempts";
const GRANTS = "/v1/admin/identity-group-grants";
const bindings = {
	...env,
	CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify({
		enabled: true,
		ownerEnrollmentEnabled: true,
		coordinatorId: config.coordinatorId,
		issuer: config.issuer,
		clientId: config.clientId,
		redirectUri: config.redirectUri,
		revision: config.revision,
	}),
	CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: config.clientSecret,
	CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: "11".repeat(32),
};
type Worker = ReturnType<typeof createConfiguredCloudflareCoordinatorWorker>;
const request = (worker: Worker, path: string | URL, init?: RequestInit) => {
	const headers = new Headers(init?.headers);
	headers.set("CF-Connecting-IP", "127.0.0.1");
	return worker.fetch(new Request(new URL(path, ORIGIN), { ...init, headers }), bindings);
};
function json(worker: Worker, path: string, body: unknown, headers: Record<string, string> = {}) {
	return request(worker, path, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}
const admin = { "X-Codemem-Coordinator-Admin": "test-secret" };
async function signedStart() {
	const key = await pendingKey();
	const start = {
		attemptId: "configured-attempt",
		deviceId: "configured-device",
		publicKey: key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	start.signature = await key.sign(
		ownerEnrollmentStartMessage(start, { ...config, origin: ORIGIN }),
	);
	return { key, start };
}
async function capability(start: Awaited<ReturnType<typeof signedStart>>["start"]) {
	const response = await json(
		createConfiguredCloudflareCoordinatorWorker(),
		CAPABILITIES,
		{ start },
		admin,
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { capability: string }).capability;
}
function cookie(response: Response) {
	return (
		response.headers
			.getSetCookie()
			.find((value) => !value.includes("Max-Age=0"))
			?.split(";")[0] ?? ""
	);
}
async function fields(response: Response) {
	return Object.fromEntries(
		[...(await response.text()).matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((match) => [
			match[1],
			match[2],
		]),
	);
}
function form(worker: Worker, path: string, body: Record<string, string>, binder: string) {
	return request(worker, path, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: binder,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(body),
	});
}

async function clean() {
	// Immutable ownership receipts need table recreation using the official migration only.
	await exec("DROP TABLE IF EXISTS coordinator_device_ownership_bindings");
	await exec("DROP TABLE IF EXISTS coordinator_owner_enrollment_attempts");
	for (const name of [
		"0028_add_device_ownership_bindings.sql",
		"0030_add_owner_enrollment_attempts.sql",
	]) {
		const migration = env.TEST_MIGRATIONS.find((migration) => migration.name === name);
		if (!migration) throw new Error("Missing ownership migration");
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	}
	for (const table of [
		"coordinator_owner_enrollment_audit_log",
		"coordinator_auth_browser_transactions",
		"coordinator_auth_sessions",
		"coordinator_auth_account_profiles",
		"coordinator_auth_account_links",
		"coordinator_identity_group_grants",
		"coordinator_auth_controller_attestations",
		"enrolled_devices",
		"groups",
	])
		await exec(`DELETE FROM ${table}`);
}
beforeEach(async () => {
	await clean();
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await clean();
});

it("exposes the normal default pin without SDK I/O or secret disclosure", async () => {
	// Arrange: the complete migration chain supplies the audit table.
	const before = await snapshot();
	// Act.
	const response = await request(defaultWorker, "/v1/auth/owner-config");
	const invalid = await request(
		createConfiguredCloudflareCoordinatorWorker(),
		"/v1/auth/owner-config?secret=1",
	);
	// Assert.
	expect(env.TEST_MIGRATIONS.map(({ name }) => name)).toContain(
		"0031_add_owner_enrollment_audit_log.sql",
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		coordinatorId: config.coordinatorId,
		origin: ORIGIN,
		issuer: config.issuer,
		revision: config.revision,
	});
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(invalid.status).toBe(400);
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(before);
});

it.each(["missing", "unknown", "forged", "expired", "mismatched"] as const)(
	"rejects %s admission on a cold configured Worker before provider or storage writes",
	async (kind) => {
		// Arrange: issue through the real admin route, never construct a test-only admission key.
		const { start } = await signedStart();
		let token = await capability(start);
		let submitted = start;
		if (kind === "unknown") token = "unknown";
		if (kind === "forged") {
			const separator = token.lastIndexOf(".") + 1;
			const replacement = token[separator] === "A" ? "B" : "A";
			token = token.slice(0, separator) + replacement + token.slice(separator + 1);
		}
		if (kind === "expired") vi.mocked(Date.now).mockReturnValue(NOW + 600_000);
		if (kind === "mismatched") submitted = { ...start, deviceId: "different-device" };
		const before = await snapshot();
		const prepare = vi.spyOn(env.COORDINATOR_DB, "prepare");
		const batch = vi.spyOn(env.COORDINATOR_DB, "batch");
		// Act: this instance has never mounted/discovered an OIDC adapter.
		const response = await json(
			createConfiguredCloudflareCoordinatorWorker(),
			ATTEMPTS,
			submitted,
			kind === "missing" ? {} : { authorization: `Bearer ${token}` },
		);
		// Assert: even D1 reads are unnecessary for rejected admission.
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "enrollment_unavailable" });
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		expect(batch).not.toHaveBeenCalled();
		prepare.mockRestore();
		batch.mockRestore();
		expect(await snapshot()).toEqual(before);
	},
);

it("requires explicit admin authority for capabilities and grants, rejecting bad attestations without auto-granting", async () => {
	// Arrange.
	const { start } = await signedStart();
	const before = await snapshot();
	// Act.
	const unauthorized = await json(createConfiguredCloudflareCoordinatorWorker(), CAPABILITIES, {
		start,
	});
	const badSignature = await json(
		createConfiguredCloudflareCoordinatorWorker(),
		CAPABILITIES,
		{ start: { ...start, signature: "A".repeat(86) } },
		admin,
	);
	const grantUnauthorized = await json(createConfiguredCloudflareCoordinatorWorker(), GRANTS, {
		attestation_id: "missing-attestation",
	});
	const badAttestation = await json(
		createConfiguredCloudflareCoordinatorWorker(),
		GRANTS,
		{ attestation_id: "missing-attestation" },
		admin,
	);
	// Assert.
	expect([
		unauthorized.status,
		badSignature.status,
		grantUnauthorized.status,
		badAttestation.status,
	]).toEqual([401, 409, 401, 409]);
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(before);
});

it("completes the normal owner flow with stable cross-instance CSRF and the shared callback while link/sign-in coexist", async () => {
	// Arrange: historical account link alone confers no group authority; grant it explicitly.
	const { key, start } = await signedStart();
	const store = new D1CoordinatorStore(env.COORDINATOR_DB);
	const controller = await pendingKey();
	const review = {
		coordinatorId: config.coordinatorId,
		groupId: "configured-group",
		deviceId: "controller-device",
		identityId: "identity-a",
		attestationId: "configured-attestation",
		reviewReceiptId: "configured-review",
		publicKey: controller.publicKey,
		fingerprint: fingerprintPublicKey(controller.publicKey),
		evidenceDigest: "b".repeat(64),
	};
	await store.createGroup(review.groupId);
	await store.enrollDevice(review.groupId, review);
	await store.createAuthControllerAttestation(review);
	await exec(
		`INSERT INTO coordinator_auth_account_links (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,auth_config_revision,created_at_ms) VALUES (?,'configured-link',?,'fixture-subject','identity-a','historical-attempt',?,?,?)`,
		config.coordinatorId,
		config.issuer,
		review.attestationId,
		config.revision,
		NOW,
	);
	expect(await rows("coordinator_identity_group_grants")).toEqual([]);
	const granted = await json(
		createConfiguredCloudflareCoordinatorWorker(),
		GRANTS,
		{ attestation_id: review.attestationId },
		admin,
	);
	const token = await capability(start);
	const provider = oidcFixture({ issuer: config.issuer });
	vi.mocked(globalThis.fetch).mockImplementation((input, options) => {
		if (typeof input !== "string") throw new Error("Unexpected provider transport");
		return provider.fetch(input, options as Parameters<typeof provider.fetch>[1]);
	});
	const first = defaultWorker;
	const second = createConfiguredCloudflareCoordinatorWorker();
	// Act: GET and POST intentionally hit different cold instances with the same raw key binding.
	const started = await json(first, ATTEMPTS, start, { authorization: `Bearer ${token}` });
	expect(started.status, await started.clone().text()).toBe(200);
	const page = await request(
		first,
		`/auth/owner/start?attempt_id=${start.attemptId}&start_code=${start.browserStartCode}`,
	);
	expect(page.status, await page.clone().text()).toBe(200);
	const body = await fields(page);
	const beforeInvalid = await snapshot();
	const invalidCsrf = await form(
		second,
		"/auth/owner/start",
		{ ...body, csrf: "invalid" },
		cookie(page),
	);
	expect(await snapshot()).toEqual(beforeInvalid);
	const claimed = await form(second, "/auth/owner/start", body, cookie(page));
	expect(claimed.status, await claimed.clone().text()).toBe(303);
	const binder = cookie(claimed);
	const location = claimed.headers.get("location");
	if (!location) throw new Error("Missing owner authorization redirect");
	const callbackUrl = provider.authorize(location);
	const callback = await request(first, callbackUrl, { headers: { cookie: binder } });
	const confirmation = await fields(callback);
	const replayBefore = await snapshot();
	const replay = await request(second, callbackUrl, { headers: { cookie: binder } });
	expect(await snapshot()).toEqual(replayBefore);
	const confirmed = await form(second, "/auth/owner/confirm", confirmation, binder);
	const completion =
		new URL(confirmed.headers.get("location") ?? "").searchParams.get("completion") ?? "";
	const attempt = await env.COORDINATOR_DB.prepare(
		"SELECT * FROM coordinator_owner_enrollment_attempts WHERE attempt_id = ?",
	)
		.bind(start.attemptId)
		.first<OwnerAttempt>();
	if (!attempt) throw new Error("Missing normal owner attempt");
	const finalized = await json(first, `${ATTEMPTS}/finalize`, {
		attemptId: start.attemptId,
		completionSecret: completion,
		signature: await key.sign(ownerEnrollmentFinalMessage(attempt, completion)),
	});
	const signIn = await request(second, "/auth/sign-in");
	const link = await request(
		second,
		"/auth/link/start?attempt_id=unknown-attempt&start_code=" + proof(),
	);
	// Assert: normal SDK verification reached the owner purpose and committed migrated D1 receipts.
	expect(granted.status).toBe(200);
	expect(started.status).toBe(200);
	expect(await started.json()).toMatchObject({ kind: "started" });
	expect(page.status).toBe(200);
	expect(invalidCsrf.status).toBe(400);
	expect(claimed.status).toBe(303);
	expect(callback.status).toBe(200);
	expect(confirmation).toHaveProperty("confirmation_hash");
	expect(replay.status).toBe(403);
	expect(replay.headers.getSetCookie()).toEqual([]);
	expect(confirmed.status).toBe(303);
	expect(finalized.status).toBe(200);
	expect(await finalized.json()).toMatchObject({ kind: "finalized" });
	expect(await rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
	expect(await rows("coordinator_device_ownership_bindings")).toHaveLength(1);
	expect(await rows("coordinator_identity_group_grants")).toHaveLength(1);
	expect(await rows("coordinator_auth_account_profiles")).toEqual([]);
	expect([signIn.status, link.status]).toEqual([200, 200]);
	expect(provider.requests.some(({ url }) => url.endsWith("/token"))).toBe(true);
	expect(provider.requests.some(({ url }) => url.endsWith("/jwks"))).toBe(true);
});
