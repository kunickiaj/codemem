import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import Sqlite from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as receiver from "../../core/src/coordinator-account-link-receiver.js";
import { AUTH_LINK_AUTHORITY_UPGRADE_SQL } from "../../core/src/coordinator-auth-link-authority-upgrade.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { enrollOwnerProfile } from "../../core/src/coordinator-owner-profile-client.js";
import {
	facts,
	fixture,
	prepared,
	read,
	registerOwnerProfileClientMockState,
} from "../../core/src/coordinator-owner-profile-client-test-harness.js";
import { ownerFileSnapshot } from "../../core/src/coordinator-owner-profile-files.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "../../core/src/d1-coordinator-store.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { pendingKey, seedOwnerAuthority } from "../test/owner-authority-test-fixture.js";
import {
	type CloudflareCoordinatorEnv,
	createConfiguredCloudflareCoordinatorWorker,
} from "./index.js";

// Node-only profile I/O cannot run inside workerd. Use the production handler with
// disposable native D1, and share A's authority fixture with configured-owner.integration.
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
const NOW = 1_791_028_800_000;
const ORIGIN = "https://app.example.test";
const ATTEMPTS = "/v1/auth/owner-attempts";
const config = {
	enabled: true,
	ownerEnrollmentEnabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	clientId: PROVIDER.clientId,
	redirectUri: PROVIDER.redirectUri,
	revision: "a".repeat(64),
};
const admin = { "X-Codemem-Coordinator-Admin": "test-secret" };
const provider = () => oidcFixture({ issuer: config.issuer });
let remote: { dispose(): Promise<void>; getD1Database(name: string): Promise<D1DatabaseLike> };
let db: D1DatabaseLike;
let bindings: CloudflareCoordinatorEnv;
let deliver: (value: { completionSecret: string; confirmationHash: string }) => void;
let fakeProvider: ReturnType<typeof provider>;
let calls: Array<{
	path: string;
	body: string | undefined;
	authorization: string | null;
	status: number;
}>;
let receipts: unknown[];
let dropFinalReply: boolean;

registerOwnerProfileClientMockState({
	signing: { corrupt: false },
	databaseOpens: [],
	assertOffline: () => {
		// All global fetch calls must reach the fake discovery/token/JWKS transport.
		expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(fakeProvider.requests.length);
	},
});

const request = (path: string | URL, init?: RequestInit) => {
	const url = new URL(path, ORIGIN);
	expect(url.origin).toBe(ORIGIN);
	const headers = new Headers(init?.headers);
	headers.set("CF-Connecting-IP", "127.0.0.1");
	// Fresh instances also exercise configuration and shared CSRF/admission keys.
	return createConfiguredCloudflareCoordinatorWorker().fetch(
		new Request(url, { ...init, headers }),
		bindings,
	);
};
const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
const cookie = (response: Response) =>
	response.headers
		.getSetCookie()
		.find((value) => !value.includes("Max-Age=0"))
		?.split(";")[0] ?? "";
async function fields(response: Response) {
	expect(response.status, await response.clone().text()).toBe(200);
	return Object.fromEntries(
		[...(await response.text()).matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((match) => [
			match[1],
			match[2],
		]),
	);
}
const form = (path: string, body: Record<string, string>, binder: string) =>
	request(path, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: binder,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(body),
	});
async function browser(url: string) {
	const page = await request(url);
	const claimed = await form("/auth/owner/start", await fields(page), cookie(page));
	expect(claimed.status).toBe(303);
	const binder = cookie(claimed);
	const callback = await request(fakeProvider.authorize(claimed.headers.get("location") ?? ""), {
		headers: { cookie: binder },
	});
	const confirmed = await form("/auth/owner/confirm", await fields(callback), binder);
	expect(confirmed.status).toBe(303);
	const completion = new URL(confirmed.headers.get("location") ?? "");
	expect(`${completion.origin}${completion.pathname}`).toBe(
		read("prepared.json").start.loopbackRedirect,
	);
	expect(completion.searchParams.get("attempt_id")).toBe(read("prepared.json").start.attemptId);
	deliver({
		completionSecret: completion.searchParams.get("completion") ?? "",
		confirmationHash: completion.searchParams.get("confirmation") ?? "",
	});
}
async function rows(table: string) {
	const result = await db
		.prepare(`SELECT * FROM ${table} ORDER BY rowid`)
		.all<Record<string, unknown>>();
	if (!result.results) throw new Error("D1 rows unavailable");
	return result.results;
}
async function authority() {
	return Promise.all(
		[
			"coordinator_auth_account_links",
			"coordinator_identity_group_grants",
			"coordinator_scope_memberships",
		].map(rows),
	);
}
async function admit() {
	const response = await json(
		"/v1/admin/owner-enrollment-capabilities",
		read("capability-request.json"),
		admin,
	);
	expect(response.status, await response.clone().text()).toBe(200);
	return ((await response.json()) as { capability: string }).capability;
}

beforeEach(async () => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	// Only loopback delivery is substituted; the actual Worker supplies its proofs.
	const completion = new Promise<{ completionSecret: string; confirmationHash: string }>(
		(resolve) => {
			deliver = resolve;
		},
	);
	vi.spyOn(receiver, "createCoordinatorOwnerEnrollmentReceiver").mockResolvedValue({
		destination: "http://127.0.0.1:43127/codemem/auth/complete",
		completion,
		close: vi.fn().mockResolvedValue(undefined),
	});
	remote = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch() { return new Response(null, {status:404}); } };",
			compatibilityDate: "2026-03-28",
			compatibilityFlags: ["nodejs_compat"],
			d1Databases: { DB: "synthetic-owner-profile" },
			cf: false,
			host: "127.0.0.1",
			port: 0,
			outboundService: () => {
				throw new Error("External network forbidden");
			},
		}),
	);
	db = await remote.getD1Database("DB");
	if (!db.batch) throw new Error("Native D1 batch unavailable");
	const migrations = await readD1Migrations(join(import.meta.dirname, "../migrations"));
	for (const migration of migrations)
		await db.batch(migration.queries.map((sql) => db.prepare(sql)));
	await db.batch(
		AUTH_LINK_AUTHORITY_UPGRADE_SQL.split(";")
			.map((sql) => sql.trim())
			.filter(Boolean)
			.map((sql) => db.prepare(sql)),
	);
	bindings = {
		COORDINATOR_DB: db,
		CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
		CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(config),
		CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: PROVIDER.clientSecret,
		CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: "11".repeat(32),
	};
	const store = new D1CoordinatorStore(db);
	const controller = await pendingKey();
	const review = {
		coordinatorId: config.coordinatorId,
		groupId: "group",
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
	await seedOwnerAuthority(db, {
		...review,
		issuer: config.issuer,
		revision: config.revision,
		linkId: "configured-link",
		subject: "fixture-subject",
		attemptId: "historical-attempt",
		controllerAttestationId: review.attestationId,
		controllerReviewReceiptId: review.reviewReceiptId,
		redirectUri: config.redirectUri,
		createdAtMs: NOW,
	});
	expect(
		(await json("/v1/admin/identity-group-grants", { attestation_id: review.attestationId }, admin))
			.status,
	).toBe(200);
	fakeProvider = provider();
	vi.mocked(globalThis.fetch).mockImplementation((input, options) => {
		if (typeof input !== "string") throw new Error("Unexpected provider transport");
		return fakeProvider.fetch(input, options as Parameters<typeof fakeProvider.fetch>[1]);
	});
	calls = [];
	receipts = [];
	dropFinalReply = false;
	fixture.options = {
		...fixture.options,
		coordinatorUrl: ORIGIN,
		onBrowserStart: vi.fn(browser),
		fetch: async (input, init) => {
			const response = await request(String(input), init);
			const path = new URL(String(input)).pathname;
			calls.push({
				path,
				body: init?.body as string | undefined,
				authorization: new Headers(init?.headers).get("authorization"),
				status: response.status,
			});
			if (path.endsWith("/finalize")) {
				receipts.push(await response.clone().json());
				if (dropFinalReply) throw new Error("Synthetic lost final reply");
			}
			return response;
		},
	};
});
afterEach(async () => {
	await remote?.dispose();
});

it.each([false, true])(
	"adopts the configured Worker receipt and reopens B (lost final reply: %s)",
	async (lostReply) => {
		// Arrange: a real existing profile has no Identity assignment, and A is seeded.
		const before = facts();
		const keys = ["device.key", "device.key.pub"].map((name) =>
			readFileSync(join(fixture.options.keysDir, name)),
		);
		const device = fixture.db.prepare("SELECT * FROM sync_device").all();
		const originalAuthority = await authority();
		expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
		await prepared();
		const saved = ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"));
		const capability = await admit();
		fixture.options.capability = capability;
		dropFinalReply = lostReply;
		// Act: client-generated signed start/final traverse actual configured production routes.
		if (lostReply) {
			await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
				code: "retained_request_incomplete",
			});
			expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
			expect(existsSync(join(fixture.options.stateDir, "receipt.json"))).toBe(false);
			expect(await rows("coordinator_device_ownership_bindings")).toHaveLength(1);
			dropFinalReply = false;
			// A restart needs neither a browser nor another admission; only the exact saved final.
			fixture.options = { ...fixture.options, capability: undefined, onBrowserStart: undefined };
		}
		const result = await enrollOwnerProfile(fixture.options);
		const reopened = new Sqlite(fixture.options.dbPath, { readonly: true, fileMustExist: true });
		try {
			// Assert: receipt-derived adoption, never fixture-written B identity or rotated key.
			const receipt = read("receipt.json").receipt;
			expect(result).toEqual({ ...receipt, kind: "adopted" });
			expect(receipt.identityId).toBe("identity-a");
			expect(receipt.kind).toBe(lostReply ? "prior_commit" : "finalized");
			expect(reopened.prepare("SELECT identity_id,device_id FROM identity_devices").all()).toEqual([
				{ identity_id: receipt.identityId, device_id: "device" },
			]);
			expect(reopened.prepare("SELECT * FROM sync_device").all()).toEqual(device);
			expect(
				["device.key", "device.key.pub"].map((name) =>
					readFileSync(join(fixture.options.keysDir, name)),
				),
			).toEqual(keys);
			expect(facts()).toEqual(before);
			expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(saved);
			expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8"))).toMatchObject({
				actor_id: receipt.identityId,
				unrelated: { nested: [1, { keep: true }] },
			});
			expect(await rows("coordinator_device_ownership_bindings")).toMatchObject([
				{ binding_id: receipt.bindingId, identity_id: receipt.identityId, device_id: "device" },
			]);
			expect(await rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
			expect(await authority()).toEqual(originalAuthority);
			expect(
				(await rows("enrolled_devices")).find((row) => row.device_id === "device"),
			).toMatchObject({
				public_key: fixture.publicKey,
				identity_id: receipt.identityId,
				group_id: "group",
			});
			const starts = calls.filter((call) => call.path === ATTEMPTS);
			expect(starts).toHaveLength(1);
			expect(starts[0]).toMatchObject({
				body: JSON.stringify(read("capability-request.json").start),
				authorization: `Bearer ${capability}`,
				status: 200,
			});
			const finals = calls.filter((call) => call.path.endsWith("/finalize"));
			expect(finals).toHaveLength(lostReply ? 2 : 1);
			for (const final of finals)
				expect(final).toMatchObject({
					body: read("final.json").body,
					authorization: null,
					status: 200,
				});
			expect(receipts).toEqual(
				lostReply
					? [expect.objectContaining({ ...receipt, kind: "finalized" }), receipt]
					: [receipt],
			);
			expect(fakeProvider.requests.some(({ url }) => url.endsWith("/token"))).toBe(true);
			expect(fakeProvider.requests.some(({ url }) => url.endsWith("/jwks"))).toBe(true);
		} finally {
			reopened.close();
		}
		// Act: reopening the client after adoption uses its retained receipt offline.
		const offline = vi.fn().mockRejectedValue(new Error("Reopen must not use transport"));
		const resumed = await enrollOwnerProfile({
			...fixture.options,
			fetch: offline,
			capability: undefined,
			onBrowserStart: undefined,
		});
		// Assert: no second ceremony or duplicate assignment is needed after reopen.
		expect(resumed).toEqual(result);
		expect(offline).not.toHaveBeenCalled();
		expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(1);
	},
);

it.each(["missing", "wrong", "expired"] as const)(
	"keeps B unchanged on %s production admission",
	async (kind) => {
		// Arrange: retain exactly the client's reviewed start and profile.
		const before = facts();
		const configBefore = ownerFileSnapshot(fixture.options.configPath);
		const keyBefore = ownerFileSnapshot(join(fixture.options.keysDir, "device.key"));
		await prepared();
		fixture.options.capability = await admit();
		if (kind === "missing") fixture.options.capability = undefined;
		if (kind === "wrong") fixture.options.capability = "wrong-capability";
		if (kind === "expired") vi.mocked(Date.now).mockReturnValue(NOW + 600_000);
		const remoteBefore = await authority();
		calls = [];
		// Act: missing admission is refused locally; bad/expired bearer reaches production denial.
		await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
			code: kind === "missing" ? "review_required" : "fresh_prepare_required",
		});
		// Assert: a sent start is uncertain and must not be retried as a fresh browser ceremony.
		expect(calls.map(({ path, status }) => ({ path, status }))).toEqual(
			kind === "missing"
				? [{ path: "/v1/auth/owner-config", status: 200 }]
				: [
						{ path: "/v1/auth/owner-config", status: 200 },
						{ path: ATTEMPTS, status: 403 },
					],
		);
		expect(fixture.options.onBrowserStart).not.toHaveBeenCalled();
		expect(fakeProvider.requests).toEqual([]);
		expect(await rows("coordinator_owner_enrollment_attempts")).toEqual([]);
		expect(await rows("coordinator_device_ownership_bindings")).toEqual([]);
		expect(await rows("coordinator_owner_enrollment_audit_log")).toEqual([]);
		expect(await authority()).toEqual(remoteBefore);
		expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
		expect(facts()).toEqual(before);
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(configBefore);
		expect(ownerFileSnapshot(join(fixture.options.keysDir, "device.key"))).toEqual(keyBefore);
		expect(existsSync(join(fixture.options.stateDir, "final.json"))).toBe(false);
		if (kind !== "missing") {
			calls = [];
			await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
				code: "fresh_prepare_required",
			});
			expect(calls).toEqual([]);
		}
	},
);
