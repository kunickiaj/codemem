import { existsSync, mkdirSync, readFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import Sqlite from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as receiver from "../../core/src/coordinator-account-link-receiver.js";
import { linkCoordinatorAccount } from "../../core/src/coordinator-account-link-runtime.js";
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
import { generateKeypair, loadPublicKey } from "../../core/src/sync-identity.js";
import { initTestSchema } from "../../core/src/test-utils.js";
import { pendingKey, seedOwnerAuthority } from "../test/owner-authority-test-fixture.js";
import { type OwnerProfileTraceStage, profileOwnerD1 } from "../test/owner-profile-d1-profile.js";
import {
	type CloudflareCoordinatorEnv,
	createConfiguredCloudflareCoordinatorWorker,
} from "./index.js";

// Node-only profile/link I/O runs against the configured production handler and
// disposable native D1, not a browser or workerd client. Historical operator tests
// retain their seeded A; the account-mode journey below creates A's link via runtime.
// The first two fixtures are the ordered false/true receipt cases; later cases stay quiet.
let traceCase = 0;
let traceStart = 0;
let traceEvent = 0;
let d1Profile: ReturnType<typeof profileOwnerD1> | undefined;
// CI evidence only; opt in locally with CODEMEM_WORKER_PROFILE_TRACE=1.
// Never accept dynamic labels or values: auth requests contain private credentials.
function traceOwnerProfile(stage: OwnerProfileTraceStage): void {
	d1Profile?.setStage(stage);
	if (process.env.CI !== "true" && process.env.CODEMEM_WORKER_PROFILE_TRACE !== "1") return;
	if (traceCase < 1 || traceCase > 2) return;
	// Write each boundary immediately, including when the reporter hides passing logs.
	writeSync(
		2,
		`[owner-profile-stage] ${JSON.stringify({
			stage,
			elapsedMs: Math.round((performance.now() - traceStart) * 10) / 10,
			lostReply: traceCase === 2,
			event: ++traceEvent,
		})}\n`,
	);
}

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
let nativeDb: D1DatabaseLike;
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
	traceOwnerProfile("browser-page-start");
	const page = await request(url);
	traceOwnerProfile("browser-page-ready");
	traceOwnerProfile("browser-claim-start");
	const claimed = await form("/auth/owner/start", await fields(page), cookie(page));
	traceOwnerProfile("browser-claim-ready");
	expect(claimed.status).toBe(303);
	const binder = cookie(claimed);
	traceOwnerProfile("browser-callback-start");
	const callback = await request(fakeProvider.authorize(claimed.headers.get("location") ?? ""), {
		headers: { cookie: binder },
	});
	traceOwnerProfile("browser-callback-ready");
	traceOwnerProfile("browser-confirm-start");
	const confirmed = await form("/auth/owner/confirm", await fields(callback), binder);
	traceOwnerProfile("browser-confirm-ready");
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
	// Verification reads are not Worker or authority-setup costs.
	const result = await nativeDb
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

async function seedHistoricalAuthority() {
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
}

beforeEach(async () => {
	d1Profile = undefined;
	traceCase += 1;
	traceStart = performance.now();
	traceEvent = 0;
	traceOwnerProfile("fixture-start");
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
	traceOwnerProfile("miniflare-start");
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
	traceOwnerProfile("miniflare-ready");
	if (!db.batch) throw new Error("Native D1 batch unavailable");
	traceOwnerProfile("schema-start");
	const migrations = await readD1Migrations(join(import.meta.dirname, "../migrations"));
	for (const migration of migrations)
		await db.batch(migration.queries.map((sql) => db.prepare(sql)));
	await db.batch(
		AUTH_LINK_AUTHORITY_UPGRADE_SQL.split(";")
			.map((sql) => sql.trim())
			.filter(Boolean)
			.map((sql) => db.prepare(sql)),
	);
	traceOwnerProfile("schema-ready");
	nativeDb = db;
	if (traceCase <= 2 && process.env.CODEMEM_WORKER_D1_PROFILE === "1") {
		// Migrations stay outside the profile. Authority seeding has its own fixed stage.
		d1Profile = profileOwnerD1(db);
		db = d1Profile.db;
	}
	bindings = {
		COORDINATOR_DB: db,
		CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
		CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(config),
		CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: PROVIDER.clientSecret,
		CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: "11".repeat(32),
	};
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
			traceOwnerProfile("client-request-start");
			const response = await request(String(input), init);
			traceOwnerProfile("client-request-end");
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
	traceOwnerProfile("cleanup-start");
	try {
		// Capture pending calls even if native-runtime teardown stalls.
		if (d1Profile) {
			writeSync(
				2,
				`[owner-profile-d1] ${JSON.stringify({ lostReply: traceCase === 2, ...d1Profile.summary() })}\n`,
			);
		}
	} finally {
		d1Profile = undefined;
		await remote?.dispose();
		traceOwnerProfile("cleanup-ready");
	}
});

it.each([false, true])(
	"adopts the configured Worker receipt and reopens B (lost final reply: %s)",
	async (lostReply) => {
		// Arrange: a real existing profile has no Identity assignment, and A is seeded.
		traceOwnerProfile("authority-start");
		await seedHistoricalAuthority();
		traceOwnerProfile("authority-ready");
		const before = facts();
		const keys = ["device.key", "device.key.pub"].map((name) =>
			readFileSync(join(fixture.options.keysDir, name)),
		);
		const device = fixture.db.prepare("SELECT * FROM sync_device").all();
		const originalAuthority = await authority();
		expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
		traceOwnerProfile("prepare-start");
		await prepared();
		traceOwnerProfile("prepare-ready");
		const saved = ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"));
		traceOwnerProfile("admit-start");
		const capability = await admit();
		traceOwnerProfile("admit-ready");
		fixture.options.capability = capability;
		dropFinalReply = lostReply;
		// Act: client-generated signed start/final traverse actual configured production routes.
		if (lostReply) {
			traceOwnerProfile("lost-reply-start");
			await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
				code: "retained_request_incomplete",
			});
			traceOwnerProfile("lost-reply-retained");
			expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
			expect(existsSync(join(fixture.options.stateDir, "receipt.json"))).toBe(false);
			expect(await rows("coordinator_device_ownership_bindings")).toHaveLength(1);
			dropFinalReply = false;
			// A restart needs neither a browser nor another admission; only the exact saved final.
			fixture.options = { ...fixture.options, capability: undefined, onBrowserStart: undefined };
		}
		traceOwnerProfile("adoption-start");
		const result = await enrollOwnerProfile(fixture.options);
		traceOwnerProfile("adoption-ready");
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
		traceOwnerProfile("reopen-start");
		const resumed = await enrollOwnerProfile({
			...fixture.options,
			fetch: offline,
			capability: undefined,
			onBrowserStart: undefined,
		});
		traceOwnerProfile("reopen-ready");
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
		await seedHistoricalAuthority();
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

function providerAuthorization(html: string) {
	const href = html.match(/href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/)?.[1];
	if (!href) throw new Error("Synthetic provider authorization link missing");
	return href.replaceAll("&amp;", "&");
}
function loopbackLink(html: string) {
	const href = html.match(/href="(http:\/\/127\.0\.0\.1:[^"]+)"/)?.[1];
	if (!href) throw new Error("Account link loopback missing");
	return new URL(href.replaceAll("&amp;", "&"));
}

// A is an existing enrolled device. Only its initial local key/device and discovery
// enrollment are fixtures; review, linking, sessions and grants use production APIs.
async function reviewedA() {
	const directory = join(dirname(fixture.options.dbPath), "a");
	const keysDir = join(directory, "keys");
	mkdirSync(keysDir, { recursive: true });
	generateKeypair(join(keysDir, "device.key"), join(keysDir, "device.key.pub"));
	const publicKey = loadPublicKey(keysDir) ?? "";
	const fingerprint = fingerprintPublicKey(publicKey);
	const dbPath = join(directory, "memory.sqlite");
	const local = new Sqlite(dbPath);
	try {
		initTestSchema(local);
		local
			.prepare(
				"INSERT INTO sync_device(device_id,public_key,fingerprint,created_at) VALUES (?,?,?,?)",
			)
			.run("device-a", publicKey, fingerprint, new Date(NOW).toISOString());
	} finally {
		local.close();
	}
	const store = new D1CoordinatorStore(db);
	await store.createGroup("group");
	await store.enrollDevice("group", { deviceId: "device-a", publicKey, fingerprint });
	const review = {
		group_id: "group",
		device_id: "device-a",
		identity_id: "identity-a",
		fingerprint,
	};
	const preview = await json("/v1/admin/auth-controller-reviews", review, admin);
	expect(preview.status, await preview.clone().text()).toBe(200);
	const evidence = (await preview.json()) as { evidence_digest: string };
	const denied = await json(
		"/v1/admin/auth-controller-reviews",
		{
			...review,
			confirm_evidence_digest: "0".repeat(64),
		},
		admin,
	);
	expect(denied.status).toBe(409);
	expect(await rows("coordinator_auth_controller_attestations")).toEqual([]);
	const committed = await json(
		"/v1/admin/auth-controller-reviews",
		{
			...review,
			confirm_evidence_digest: evidence.evidence_digest,
		},
		admin,
	);
	expect(committed.status, await committed.clone().text()).toBe(201);
	const attestation = (await committed.json()) as { attestation_id: string };
	expect(await rows("coordinator_auth_account_links")).toEqual([]);
	expect(await rows("coordinator_identity_group_grants")).toEqual([]);
	return { dbPath, keysDir, publicKey, fingerprint, attestationId: attestation.attestation_id };
}

async function linkA(a: Awaited<ReturnType<typeof reviewedA>>, options: { cancel?: boolean } = {}) {
	const cancel = options.cancel === true;
	let deliverLink!: (proof: string) => void;
	let rejectLink!: (error: unknown) => void;
	const completion = new Promise<string>((resolve, reject) => {
		deliverLink = resolve;
		rejectLink = reject;
	});
	vi.spyOn(receiver, "createCoordinatorAccountLinkReceiver").mockResolvedValue({
		destination: "http://127.0.0.1:43128/codemem/auth/complete",
		completion,
		close: vi.fn().mockResolvedValue(undefined),
	});
	let browserWork: Promise<void> | undefined;
	let browserError: unknown;
	let cleanupReply: { status: number; body: unknown } | undefined;
	const driveBrowser = async (url: string) => {
		const page = await request(url);
		const started = await form("/auth/link/start", await fields(page), cookie(page));
		expect(started.status, await started.clone().text()).toBe(200);
		const binder = cookie(started);
		const callback = await request(
			fakeProvider.authorize(providerAuthorization(await started.text())),
			{
				headers: { cookie: binder },
			},
		);
		const body = await fields(callback);
		// A valid provider callback is insufficient without this browser's CSRF proof.
		const bad = await form("/auth/link/confirm", { ...body, csrf: "wrong" }, binder);
		expect(bad.status).toBe(403);
		expect(await rows("coordinator_auth_account_links")).toEqual([]);
		const confirmed = await form(cancel ? "/auth/link/cancel" : "/auth/link/confirm", body, binder);
		expect(confirmed.status, await confirmed.clone().text()).toBe(200);
		if (cancel) return;
		const destination = loopbackLink(await confirmed.text());
		expect(`${destination.origin}${destination.pathname}`).toBe(
			"http://127.0.0.1:43128/codemem/auth/complete",
		);
		// Clearly mocked receiver: forward only the real server-issued completion proof.
		deliverLink(destination.searchParams.get("completion") ?? "");
	};
	const result = linkCoordinatorAccount({
		dbPath: a.dbPath,
		keysDir: a.keysDir,
		coordinatorUrl: ORIGIN,
		groupId: "group",
		expectedIdentityId: "identity-a",
		expectedAuthority: "controller_attestation",
		expectedCoordinatorId: config.coordinatorId,
		fetch: async (input, init) => {
			const response = await request(String(input), init);
			if (String(input).endsWith("/cancel"))
				cleanupReply = { status: response.status, body: await response.clone().json() };
			return response;
		},
		onBrowserStart: (url) => {
			browserWork = driveBrowser(url).catch((error) => {
				browserError = error;
				rejectLink(error);
			});
		},
	});
	const [outcome] = await Promise.allSettled([result]);
	await browserWork;
	if (browserError) throw browserError;
	if (cancel) {
		const attempts = await rows("coordinator_auth_link_attempts");
		expect(attempts).toHaveLength(1);
		expect(cleanupReply).toEqual({
			status: 200,
			body: {
				status: {
					attemptId: attempts[0]?.attempt_id,
					state: "failed",
					expiresAtMs: attempts[0]?.expires_at_ms,
				},
			},
		});
		expect(outcome).toMatchObject({
			status: "rejected",
			reason: { code: "link_stopped" },
		});
	} else {
		expect(outcome).toMatchObject({
			status: "fulfilled",
			value: { identityId: "identity-a", state: "finalized" },
		});
	}
}

async function signIn() {
	const page = await request("/auth/sign-in");
	const started = await form("/auth/sign-in", await fields(page), cookie(page));
	expect(started.status, await started.clone().text()).toBe(200);
	const response = await request(
		fakeProvider.authorize(providerAuthorization(await started.text())),
		{
			headers: { cookie: cookie(started) },
		},
	);
	expect(response.status, await response.clone().text()).toBe(303);
	const session = cookie(response);
	expect(session).toContain("__Host-codemem");
	return session;
}

async function uploadB(
	url: string,
	session: string,
	options: { requestFile: string },
	csrfOverride?: string,
) {
	expect(url).toBe(`${ORIGIN}/auth/owner/admit`);
	const page = await request(url, { headers: { cookie: session } });
	const body = new FormData();
	body.append("csrf", csrfOverride ?? (await fields(page)).csrf ?? "");
	body.append(
		"request",
		new File([readFileSync(options.requestFile)], "capability-request.json", {
			type: "application/json",
		}),
	);
	return request(url, { method: "POST", headers: { origin: ORIGIN, cookie: session }, body });
}

async function finishB(admitted: Response, session: string) {
	expect(admitted.status, await admitted.clone().text()).toBe(200);
	const started = await form(
		"/auth/owner/start",
		await fields(admitted),
		`${session}; ${cookie(admitted)}`,
	);
	expect(started.status, await started.clone().text()).toBe(303);
	const binder = cookie(started);
	const callback = await request(fakeProvider.authorize(started.headers.get("location") ?? ""), {
		headers: { cookie: binder },
	});
	const confirmed = await form("/auth/owner/confirm", await fields(callback), binder);
	expect(confirmed.status, await confirmed.clone().text()).toBe(303);
	const destination = new URL(confirmed.headers.get("location") ?? "");
	expect(`${destination.origin}${destination.pathname}`).toBe(
		read("prepared.json").start.loopbackRedirect,
	);
	expect(destination.searchParams.get("attempt_id")).toBe(read("prepared.json").start.attemptId);
	deliver({
		completionSecret: destination.searchParams.get("completion") ?? "",
		confirmationHash: destination.searchParams.get("confirmation") ?? "",
	});
}

async function arrangeReviewedAccountOwner() {
	const a = await reviewedA();
	const aKey = readFileSync(join(a.keysDir, "device.key"));
	return { a, aKey };
}

async function linkAndGrantAccountOwner({
	a,
}: Awaited<ReturnType<typeof arrangeReviewedAccountOwner>>) {
	await linkA(a);
	const links = await rows("coordinator_auth_account_links");
	expect(links).toMatchObject([
		{
			identity_id: "identity-a",
			authority_kind: "controller_attestation",
			revoked_at_ms: null,
			controller_attestation_id: a.attestationId,
		},
	]);
	expect(await rows("coordinator_identity_group_grants")).toEqual([]);
	expect(await rows("coordinator_scope_memberships")).toEqual([]);
	const grant = await json(
		"/v1/admin/identity-group-grants",
		{ attestation_id: a.attestationId },
		admin,
	);
	expect(grant.status, await grant.clone().text()).toBe(200);
	const originalAuthority = await authority();
	return { links, originalAuthority };
}

async function prepareAccountProfile({ session }: { session: string }) {
	const before = facts();
	const configBefore = JSON.parse(readFileSync(fixture.options.configPath, "utf8"));
	const keys = ["device.key", "device.key.pub"].map((name) =>
		readFileSync(join(fixture.options.keysDir, name)),
	);
	const device = fixture.db.prepare("SELECT * FROM sync_device").all();
	fixture.options.admissionMode = "account";
	expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
	await prepared();
	fixture.options.capability = undefined;
	const saved = ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"));
	fixture.options.onBrowserStart = vi.fn(async (url, details) => {
		if (!details) throw new Error("Account admission upload details missing");
		await finishB(await uploadB(url, session, details), session);
	});
	return { before, configBefore, keys, device, saved };
}

async function retainAccountFinalForRetry({ lostReply }: { lostReply: boolean }) {
	dropFinalReply = lostReply;
	if (!lostReply) return;
	await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
		code: "retained_request_incomplete",
	});
	expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
	expect(await rows("coordinator_device_ownership_bindings")).toHaveLength(1);
	dropFinalReply = false;
	fixture.options.onBrowserStart = undefined;
}

async function adoptAccountProfile() {
	const result = await enrollOwnerProfile(fixture.options);
	const receipt = read("receipt.json").receipt;
	return { result, receipt };
}

async function verifyAccountAuthority({
	result,
	receipt,
	lostReply,
	links,
	originalAuthority,
}: Awaited<ReturnType<typeof adoptAccountProfile>> &
	Awaited<ReturnType<typeof linkAndGrantAccountOwner>> & { lostReply: boolean }) {
	expect(result).toEqual({ ...receipt, kind: "adopted" });
	expect(receipt).toMatchObject({
		identityId: "identity-a",
		groups: ["group"],
		kind: lostReply ? "prior_commit" : "finalized",
	});
	expect(await authority()).toEqual(originalAuthority);
	expect(await rows("coordinator_auth_account_links")).toEqual(links);
	expect(await rows("coordinator_scope_memberships")).toEqual([]);
	expect(await rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
	expect(await rows("coordinator_device_ownership_bindings")).toMatchObject([
		{ identity_id: "identity-a", device_id: "device", binding_id: receipt.bindingId },
	]);
	expect((await rows("enrolled_devices")).find((row) => row.device_id === "device")).toMatchObject({
		identity_id: "identity-a",
		public_key: fixture.publicKey,
		group_id: "group",
	});
	const attempts = await rows("coordinator_owner_enrollment_attempts");
	expect(attempts).toMatchObject([
		{ admission_owner_hash: expect.stringMatching(/^[a-f0-9]{64}$/), identity_id: "identity-a" },
	]);
}

function verifyAccountFinalTransport({ lostReply }: { lostReply: boolean }) {
	expect(calls.some(({ path }) => path === ATTEMPTS)).toBe(false);
	const finals = calls.filter(({ path }) => path.endsWith("/finalize"));
	expect(finals).toHaveLength(lostReply ? 2 : 1);
	for (const final of finals)
		expect(final).toMatchObject({
			body: read("final.json").body,
			authorization: null,
			status: 200,
		});
}

function verifyAccountProfilePreserved({
	receipt,
	before,
	configBefore,
	keys,
	device,
	saved,
	a,
	aKey,
}: Pick<Awaited<ReturnType<typeof adoptAccountProfile>>, "receipt"> &
	Awaited<ReturnType<typeof prepareAccountProfile>> &
	Awaited<ReturnType<typeof arrangeReviewedAccountOwner>>) {
	expect(facts()).toEqual(before);
	expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8"))).toEqual({
		...configBefore,
		actor_id: receipt.identityId,
		sync_coordinator_url: ORIGIN,
		sync_coordinator_group: "group",
	});
	expect(fixture.db.prepare("SELECT * FROM sync_device").all()).toEqual(device);
	expect(
		["device.key", "device.key.pub"].map((name) =>
			readFileSync(join(fixture.options.keysDir, name)),
		),
	).toEqual(keys);
	expect(readFileSync(join(a.keysDir, "device.key"))).toEqual(aKey);
	expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(saved);
}

async function verifyAccountReceiptReopensOffline({
	result,
}: Pick<Awaited<ReturnType<typeof adoptAccountProfile>>, "result">) {
	const reopened = new Sqlite(fixture.options.dbPath, { readonly: true, fileMustExist: true });
	try {
		expect(reopened.prepare("SELECT identity_id,device_id FROM identity_devices").all()).toEqual([
			{ identity_id: "identity-a", device_id: "device" },
		]);
	} finally {
		reopened.close();
	}
	const offline = vi.fn().mockRejectedValue(new Error("No coordinator on receipt-backed reopen"));
	expect(
		await enrollOwnerProfile({ ...fixture.options, fetch: offline, onBrowserStart: undefined }),
	).toEqual(result);
	expect(offline).not.toHaveBeenCalled();
	expect(fakeProvider.requests.filter(({ url }) => url.endsWith("/token"))).toHaveLength(3);
	expect(fakeProvider.requests.some(({ url }) => url.endsWith("/jwks"))).toBe(true);
}

// Real D1/OIDC account-link journeys take ~3s uncontended; they are correctness
// checks, not five-second performance requirements on shared CI runners.
const ACCOUNT_JOURNEY_TIMEOUT_MS = 15_000;

it.each([false, true])(
	"links reviewed A then account-enrolls B without changing keys or grants (lost reply: %s)",
	async (lostReply) => {
		// Arrange: neither an account link nor B's Identity exists before the maintained runtime runs.
		const owner = await arrangeReviewedAccountOwner();
		const linked = await linkAndGrantAccountOwner(owner);
		const session = await signIn();
		const profile = await prepareAccountProfile({ session });
		// Act: the fixed browser URL uploads the client's exact signed request, not an admin capability.
		await retainAccountFinalForRetry({ lostReply });
		const adopted = await adoptAccountProfile();
		// Assert: adoption comes solely from the configured Worker's receipt, preserving both device keys.
		await verifyAccountAuthority({ ...adopted, ...linked, lostReply });
		verifyAccountFinalTransport({ lostReply });
		verifyAccountProfilePreserved({ ...adopted, ...profile, ...owner });
		await verifyAccountReceiptReopensOffline(adopted);
	},
	ACCOUNT_JOURNEY_TIMEOUT_MS,
);

it(
	"browser cancellation of A creates no authority and runtime confirms the stopped link",
	async () => {
		// Arrange
		const a = await reviewedA();
		const before = await authority();
		// Act
		await linkA(a, { cancel: true });
		// Assert
		expect(await authority()).toEqual(before);
		expect(await rows("coordinator_auth_sessions")).toEqual([]);
		expect(await rows("coordinator_device_ownership_bindings")).toEqual([]);
		expect(await rows("coordinator_auth_link_attempts")).toMatchObject([
			{ state: "failed", failure_reason: "browser_cancelled" },
		]);
	},
	ACCOUNT_JOURNEY_TIMEOUT_MS,
);

it.each(["wrong CSRF", "missing trusted grant", "missing session"] as const)(
	"rejects B's %s account admission before creating an attempt or changing the profile",
	async (failure) => {
		// Arrange
		const a = await reviewedA();
		await linkA(a);
		if (failure !== "missing trusted grant")
			expect(
				(await json("/v1/admin/identity-group-grants", { attestation_id: a.attestationId }, admin))
					.status,
			).toBe(200);
		const session = await signIn();
		const before = facts();
		const originalAuthority = await authority();
		fixture.options.admissionMode = "account";
		await prepared();
		fixture.options.capability = undefined;
		const configBefore = ownerFileSnapshot(fixture.options.configPath);
		const deviceBefore = fixture.db.prepare("SELECT * FROM sync_device").all();
		const keyBefore = ownerFileSnapshot(join(fixture.options.keysDir, "device.key"));
		let denied: Response | undefined;
		fixture.options.onBrowserStart = async (url, details) => {
			if (!details) throw new Error("Account upload details missing");
			if (failure === "wrong CSRF") {
				denied = await uploadB(url, session, details, "wrong");
			} else {
				const cookie = failure === "missing session" ? "" : session;
				denied = await request(url, { headers: { cookie } });
			}
			throw new Error("Synthetic browser stopped after rejected upload");
		};
		// Act
		await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
			code: "fresh_prepare_required",
		});
		// Assert
		expect(denied?.status).toBe(failure === "wrong CSRF" ? 400 : 403);
		expect(await rows("coordinator_owner_enrollment_attempts")).toEqual([]);
		expect(await rows("coordinator_device_ownership_bindings")).toEqual([]);
		expect(await authority()).toEqual(originalAuthority);
		expect(facts()).toEqual(before);
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(configBefore);
		expect(fixture.db.prepare("SELECT * FROM sync_device").all()).toEqual(deviceBefore);
		expect(ownerFileSnapshot(join(fixture.options.keysDir, "device.key"))).toEqual(keyBefore);
		expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
		expect(existsSync(join(fixture.options.stateDir, "receipt.json"))).toBe(false);
	},
	ACCOUNT_JOURNEY_TIMEOUT_MS,
);
