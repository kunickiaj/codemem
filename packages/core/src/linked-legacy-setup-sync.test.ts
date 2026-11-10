import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountContextReader } from "../../viewer-server/src/account/context.js";
import { createAccountRebindRunner, reviewDigest } from "../../viewer-server/src/account/rebind.js";
import {
	createRecipientPolicyReconcilerEffects,
	reconcileConfiguredCoordinatorEnrollment,
	syncProtocolRoutes,
} from "../../viewer-server/src/routes/sync.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey, issueBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { createDeviceRebindCeremony } from "./coordinator-device-rebind-ceremony.js";
import { resumeDeviceRebind } from "./coordinator-device-rebind-client.js";
import type { DeviceRebindAttempt } from "./coordinator-device-rebind-proof.js";
import {
	completeCoordinatorDeviceSetup,
	readCoordinatorDeviceSetup,
} from "./coordinator-device-setup-client.js";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import { createCoordinatorOidcClient } from "./coordinator-oidc.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { trustCoordinatorPeersWithSharedManagedScopes } from "./coordinator-runtime.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { connect, type Database } from "./db.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	linkedLegacySetupFixture,
} from "./linked-legacy-setup-test-fixtures.js";
import { readOpenLocalIdentitySwitch } from "./local-identity-switch.js";
import { reconcileRecipientPolicyProject } from "./recipient-policy-reconciler.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import { MemoryStore } from "./store.js";
import { verifySignature } from "./sync-auth.js";
import { LOCAL_SYNC_FEATURES } from "./sync-capability.js";
import { syncOnce } from "./sync-pass.js";

// The peer router imports the maintained Core package. Resolve that package to
// current source so this test exercises the same revision as the binding code.
vi.mock("@codemem/core", async () => import("./index.js"));

const SHARE_SCOPE = "fixture-shared-scope";
const REVIEW_SCOPE = "fixture-reviewed-scope";
const COORDINATOR_ORIGIN = "https://coordinator.example.test";
// Discovery/maintenance keeps its original transport. Claim POST uses j.origin separately.
const DISCOVERY_ORIGIN = "http://coordinator-a";
const ADMIN_SECRET = "synthetic-joined-admin";
const PEER_ORIGIN = "http://fixture-peer.test";
type Key = LinkedLegacySetupFixture["keyA"];
type Machine = { store: MemoryStore; keysDir: string; dbPath: string; key: Key };
type Joined = {
	f: LinkedLegacySetupFixture;
	a: Machine;
	b: Machine;
	directory: string;
	origin: string;
};

function writeKeys(directory: string, key: Key): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "device.key"),
		key.privateKey.export({ type: "pkcs8", format: "pem" }),
		{ mode: 0o600 },
	);
	writeFileSync(join(directory, "device.key.pub"), key.publicKey, { mode: 0o600 });
}

function copyIntent(source: Database, target: Database): void {
	for (const table of [
		"actors",
		"identity_devices",
		"policy_teams",
		"policy_team_memberships",
		"policy_team_device_decisions",
		"project_recipients",
	]) {
		for (const row of source.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
			const columns = Object.keys(row);
			target
				.prepare(
					`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
				)
				.run(...Object.values(row));
		}
	}
}

function openMachine(dbPath: string, keysDir: string, key: Key): Machine {
	writeKeys(keysDir, key);
	const store = new MemoryStore(dbPath, { keysDir });
	return { store, keysDir, dbPath, key };
}

async function joinedFixture(
	backend: "SQLite" | "D1",
	directory: string,
	accountAuthority: "device_claim" | "controller_attestation" = "device_claim",
): Promise<Joined> {
	const origin =
		accountAuthority === "controller_attestation"
			? new URL(PROVIDER.redirectUri).origin
			: COORDINATOR_ORIGIN;
	const config = join(directory, "config.json");
	writeFileSync(
		config,
		JSON.stringify({
			actor_id: LEGACY_SETUP.identityId,
			sync_coordinator_url: origin,
			sync_coordinator_groups: [LEGACY_SETUP.groupId],
		}),
	);
	vi.stubEnv("CODEMEM_ACTOR_ID", undefined);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", undefined);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", undefined);
	for (const [name, value] of Object.entries({
		CODEMEM_CONFIG: config,
		CODEMEM_DEVICE_ID: "",
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_SYNC_KEY_STORE: "file",
	}))
		vi.stubEnv(name, value);
	const aPath = join(directory, "a.sqlite");
	const bPath = join(directory, "b.sqlite");
	const f = await linkedLegacySetupFixture(backend, {
		authConfigured: true,
		adminSecret: ADMIN_SECRET,
		accountAuthority,
		authRedirectUri: `${origin}/auth/callback`,
		localDatabasePath: aPath,
		coordinatorDatabasePath: join(directory, "coordinator.sqlite"),
	});
	const bDb = connect(bPath);
	copyIntent(f.local, bDb);
	bDb
		.prepare(
			"INSERT INTO sync_device(device_id,public_key,fingerprint,created_at) VALUES (?,?,?,?)",
		)
		.run(f.keyB.deviceId, f.keyB.publicKey, f.keyB.fingerprint, LEGACY_SETUP.now);
	bDb.close();
	return {
		f,
		directory,
		origin,
		a: openMachine(aPath, join(directory, "a-keys"), f.keyA),
		b: openMachine(bPath, join(directory, "b-keys"), f.keyB),
	};
}

function setupClient(j: Joined) {
	return {
		dbPath: j.a.dbPath,
		keysDir: j.a.keysDir,
		coordinatorUrl: j.origin,
		groupId: LEGACY_SETUP.groupId,
		currentIdentityId: LEGACY_SETUP.identityId,
		fetch: (async (input, init) => j.f.app.request(new Request(input, init))) as typeof fetch,
	};
}

async function reconcileBoth(j: Joined): Promise<void> {
	const enrollments = await j.f.coordinator.store.listEnrolledDevices(LEGACY_SETUP.groupId);
	for (const machine of [j.a, j.b]) {
		const result = await reconcileCoordinatorEnrollmentSnapshot(machine.store.db, {
			coordinatorId: DISCOVERY_ORIGIN,
			groupId: LEGACY_SETUP.groupId,
			localDeviceId: machine.key.deviceId,
			now: LEGACY_SETUP.now,
			consumedTeamInvites: [],
			enrollments,
		});
		expect(result.issues).toEqual([]);
	}
}

async function refreshBoth(j: Joined): Promise<void> {
	for (const machine of [j.a, j.b]) {
		const result = await refreshScopeMembershipCache(machine.store.db, {
			coordinatorId: DISCOVERY_ORIGIN,
			groupIds: [LEGACY_SETUP.groupId],
			now: new Date(),
			fetchers: {
				listScopes: async () => ({
					version: 1,
					items: await j.f.coordinator.store.listScopes({ groupId: LEGACY_SETUP.groupId }),
				}),
				getScopeSnapshot: async (groupId, scopeId) => {
					const auth = await j.f.coordinator.store.getScopeAuthorization({ groupId, scopeId });
					if (auth.kind !== "authorized") throw new Error(`Fixture scope denied: ${auth.error}`);
					return {
						authorization_version: 1,
						scope: auth.scope,
						items: auth.members.map((member) => ({
							membership: member.membership,
							enrollment: member.enrollment,
							key_id: member.keyId,
						})),
					};
				},
			},
		});
		expect(result.status).toBe("refreshed");
	}
}

async function createBoundary(j: Joined, project: string, scopeId: string): Promise<void> {
	await j.f.coordinator.store.createScope({
		scopeId,
		label: scopeId,
		kind: "managed_project",
		authorityType: "coordinator",
		coordinatorId: DISCOVERY_ORIGIN,
		groupId: LEGACY_SETUP.groupId,
	});
	await refreshBoth(j);
	for (const machine of [j.a, j.b]) {
		machine.store.db
			.prepare(`INSERT INTO project_scope_mappings(workspace_identity,project_pattern,scope_id,priority,source,created_at,updated_at)
			VALUES (?,?,?,1000,'fixture',?,?)`)
			.run(project, project, scopeId, LEGACY_SETUP.now, LEGACY_SETUP.now);
	}
}

async function publish(j: Joined, project: string): Promise<void> {
	vi.stubEnv("CODEMEM_KEYS_DIR", j.a.keysDir);
	const effects = createRecipientPolicyReconcilerEffects(j.a.store, {
		config: {
			...readCoordinatorSyncConfig(),
			syncCoordinatorUrl: DISCOVERY_ORIGIN,
			syncCoordinatorAdminSecret: ADMIN_SECRET,
			syncCoordinatorGroups: [LEGACY_SETUP.groupId],
		},
		now: () => new Date().toISOString(),
	});
	let result = await reconcileRecipientPolicyProject(
		j.a.store.db,
		{ canonicalProjectIdentity: project, leaseOwner: "fixture-publisher" },
		effects,
	);
	if (result.status === "parity_pending") {
		vi.setSystemTime(Date.now() + 5000);
		result = await reconcileRecipientPolicyProject(
			j.a.store.db,
			{ canonicalProjectIdentity: project, leaseOwner: "fixture-publisher" },
			effects,
		);
	}
	expect(result, JSON.stringify(result)).toMatchObject({ status: "active" });
	await refreshBoth(j);
}

function pinBoth(j: Joined) {
	return [j.a, j.b].map((machine, index) => {
		const peer = index === 0 ? j.b.key : j.a.key;
		return trustCoordinatorPeersWithSharedManagedScopes(machine.store.db, machine.key.deviceId, [
			{
				device_id: peer.deviceId,
				public_key: peer.publicKey,
				fingerprint: peer.fingerprint,
				coordinator_id: DISCOVERY_ORIGIN,
				groups: [LEGACY_SETUP.groupId],
				addresses: [PEER_ORIGIN],
			},
		]);
	});
}

function memory(machine: Machine, title: string, scopeId: string): void {
	const project =
		scopeId === SHARE_SCOPE ? LEGACY_SETUP.excludedProject : LEGACY_SETUP.reviewedProject;
	const session = machine.store.startSession({ cwd: "", project, gitRemote: project });
	const id = machine.store.remember(
		session,
		"discovery",
		title,
		"Synthetic joined recovery memory.",
		0.8,
		[],
		{ visibility: "shared" },
	);
	expect(
		machine.store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").get(id),
	).toEqual({ scope_id: scopeId });
}

async function registerPeerCapabilities(j: Joined): Promise<void> {
	for (const key of [j.a.key, j.b.key]) {
		const response = await j.f.signed(key, "POST", "/v1/presence", {
			group_id: LEGACY_SETUP.groupId,
			addresses: [PEER_ORIGIN],
			ttl_s: 600,
			capabilities: { sync_capability: "scoped", sync_features: LOCAL_SYNC_FEATURES },
		});
		expect(response.status).toBe(200);
	}
}

async function exchange(j: Joined) {
	const app = syncProtocolRoutes(() => j.b.store);
	const requests: { path: string; status: number }[] = [];
	return {
		requests,
		result: await syncOnce(j.a.store.db, j.b.key.deviceId, [PEER_ORIGIN], {
			keysDir: j.a.keysDir,
			dbPath: j.a.dbPath,
			scanner: j.a.store.scanner,
			refreshAuthorization: false,
			requestExecutor: async (method, url, options) => {
				vi.stubEnv("CODEMEM_KEYS_DIR", j.b.keysDir);
				const response = await app.request(url, {
					method,
					headers: options?.headers,
					...(method === "GET"
						? {}
						: { body: options?.bodyBytes ?? JSON.stringify(options?.body) }),
				});
				requests.push({ path: new URL(url).pathname, status: response.status });
				return [response.status, await response.json()];
			},
		}),
	};
}

async function useControllerFixture(previous: Joined, backend: "SQLite" | "D1") {
	const directory = join(previous.directory, "controller");
	mkdirSync(directory);
	const next = await joinedFixture(backend, directory, "controller_attestation");
	previous.a.store.close();
	previous.b.store.close();
	await previous.f.close();
	return next;
}

function runnerContext(j: Joined) {
	const configPath = join(j.directory, "config.json");
	const read = createAccountContextReader({
		configPath,
		keysDir: j.a.keysDir,
		getProfile: () => ({
			dbPath: j.a.dbPath,
			deviceId: j.a.store.deviceId,
			identityId: j.a.store.actorId,
		}),
		readConfig: () => JSON.parse(readFileSync(configPath, "utf8")),
	});
	const result = read(LEGACY_SETUP.groupId);
	if (!("context" in result) || !result.context) throw new Error(JSON.stringify(result));
	return result.context;
}

async function createControllerBrowser(j: Joined, subject: string) {
	const backend = await j.f.coordinator.store.readDeviceRebindBackend();
	if (!backend) throw new Error("Controller fixture backend unavailable");
	const config = { ...j.f.account.config, ...PROVIDER, issuer: j.f.account.config.issuer };
	const provider = oidcFixture({ issuer: config.issuer });
	provider.claims.sub = subject;
	provider.userInfo.sub = subject;
	const oidc = await createCoordinatorOidcClient(config, { fetch: provider.fetch });
	if (!oidc.ok) throw new Error(oidc.error);
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(41));
	const create = () =>
		createDeviceRebindCeremony({
			backend,
			config,
			publicOrigin: j.origin,
			csrfKey,
			client: oidc.client,
			now: () => Date.now(),
			limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		});
	return { config, provider, csrfKey, create };
}

async function controllerCeremony(j: Joined, subject: string) {
	const browser = await createControllerBrowser(j, subject);
	const code = Buffer.alloc(32, 43).toString("base64url");
	const input = {
		attemptId: "joined-controller-connect",
		signer: j.f.account.signer,
		currentIdentityId: LEGACY_SETUP.identityId,
		reviewDigest: reviewDigest(j.a.store, runnerContext(j)),
		browserStartHash: createHash("sha256").update(Buffer.from(code, "base64url")).digest("hex"),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const ceremony = browser.create();
	const started = await ceremony.start(input, "fixture-browser");
	expect(started).toMatchObject({ kind: "started" });
	return { input, ...(await verifyControllerBrowser(j, browser, input.attemptId, code)) };
}

async function verifyControllerBrowser(
	j: Joined,
	browser: Awaited<ReturnType<typeof createControllerBrowser>>,
	attemptId: string,
	code: string,
) {
	const { config, csrfKey, provider } = browser;
	const ceremony = browser.create();
	const startCookie = await issueBrowserCookie("start");
	const csrf = await issueBrowserCsrfToken(csrfKey, startCookie.secret, "start", {
		publicOrigin: j.origin,
		store: config,
	});
	const form = (cookie: string, fields: Record<string, string>) =>
		new Request(`${j.origin}/auth/rebind`, {
			method: "POST",
			headers: { origin: j.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields),
		});
	const claimed = await ceremony.claimBrowser(
		form(startCookie.setCookie.split(";")[0] ?? "", {
			csrf,
			attempt_id: attemptId,
			start_code: code,
		}),
		"fixture-browser",
	);
	if (claimed?.kind !== "browser_claimed") throw new Error(JSON.stringify(claimed));
	const cookie = claimed.setCookies[0]?.split(";")[0] ?? "";
	const verified = await ceremony.verifyCallback(
		new Request(provider.authorize(claimed.authorizationUrl), { headers: { cookie } }),
	);
	return { ...browser, ceremony, form, cookie, verified };
}

async function confirmRunnerBrowser(
	j: Joined,
	browser: Awaited<ReturnType<typeof createControllerBrowser>>,
	startUrl: string,
) {
	const start = new URL(startUrl);
	const attemptId = start.searchParams.get("attempt_id") ?? "";
	const flow = await verifyControllerBrowser(
		j,
		browser,
		attemptId,
		start.searchParams.get("start_code") ?? "",
	);
	if (flow.verified?.kind !== "verified") throw new Error(JSON.stringify(flow.verified));
	expect(flow.verified.confirmation).toMatchObject({
		currentIdentityId: LEGACY_SETUP.identityId,
		targetIdentityId: LEGACY_SETUP.identityId,
	});
	const confirmed = await flow.ceremony.confirm(
		flow.form(flow.cookie, {
			csrf: flow.verified.csrf,
			attempt_id: attemptId,
		}),
		"fixture-browser",
		flow.verified.confirmation.confirmationHash,
	);
	if (confirmed?.kind !== "confirmed") throw new Error(JSON.stringify(confirmed));
	const query = new URLSearchParams({
		attempt_id: attemptId,
		completion: confirmed.completionSecret,
		confirmation: flow.verified.confirmation.confirmationHash,
	});
	expect(await navigateLoopback(`${confirmed.loopbackRedirect}?${query}`)).toBe(200);
}

function navigateLoopback(url: string): Promise<number> {
	if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error("Non-local callback forbidden");
	return new Promise((resolve, reject) => {
		const request = httpRequest(url, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
		request.on("error", reject);
		request.end();
	});
}

async function connectWithViewerRunner(j: Joined) {
	const browser = await createControllerBrowser(j, "fixture-subject");
	const app = createCoordinatorApp({
		storeFactory: () => j.f.coordinator.store,
		runtime: { adminSecret: () => ADMIN_SECRET, now: () => new Date().toISOString() },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: {
			kind: "ready",
			auth: { storeConfig: browser.config, register: () => {} },
			storeFactory: () => j.f.coordinator.store,
			clientKey: () => "fixture-browser",
		},
	});
	const fallback = globalThis.fetch;
	const paths: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).origin !== j.origin) return fallback(input, init);
			paths.push(`${request.method} ${new URL(request.url).pathname}`);
			return app.request(request);
		}),
	);
	expect(Object.hasOwn(process.env, "CODEMEM_ACTOR_ID")).toBe(false);
	const context = runnerContext(j);
	let browserStarts = 0;
	const outcome = await createAccountRebindRunner(j.a.store)({
		context,
		signal: new AbortController().signal,
		onBrowserStart: async (url) => {
			browserStarts++;
			await confirmRunnerBrowser(j, browser, url);
		},
		isCurrent: () => runnerContext(j).contextId === context.contextId,
	});
	expect(
		outcome,
		`Actual Viewer runner result: ${JSON.stringify(outcome)}; HTTP: ${JSON.stringify(paths)}`,
	).toEqual({ kind: "bound" });
	const row = j.f.coordinator.db
		.prepare("SELECT * FROM coordinator_device_rebind_attempts WHERE device_id = ?")
		.get(j.a.key.deviceId) as DeviceRebindAttempt;
	expect(row.review_digest).toBe(reviewDigest(j.a.store, context));
	const pending = {
		attemptId: row.attempt_id,
		coordinatorOrigin: j.origin,
		groupId: context.groupId,
		deviceId: row.device_id,
		previousIdentityId: row.current_identity_id,
		targetIdentityId: row.target_identity_id ?? "",
		reviewDigest: row.review_digest,
		expiresAtMs: row.expires_at_ms,
	};
	return { outcome, provider: browser.provider, paths, pending, browserStarts };
}

async function maintainBoth(j: Joined) {
	const config = {
		...readCoordinatorSyncConfig(),
		syncEnabled: true,
		syncCoordinatorUrl: DISCOVERY_ORIGIN,
		syncCoordinatorAdminSecret: ADMIN_SECRET,
		syncCoordinatorGroups: [LEGACY_SETUP.groupId],
	};
	const completion = vi.fn(() => {
		throw new Error("An authoritatively bound device must not repeat connection");
	});
	for (const machine of [j.a, j.b]) {
		vi.stubEnv("CODEMEM_KEYS_DIR", machine.keysDir);
		const result = await reconcileConfiguredCoordinatorEnrollment(machine.store, {
			config,
			completeDeviceSetup: completion,
		});
		expect(result, JSON.stringify(result)).toMatchObject({ failedGroups: 0, issues: 0 });
		expect(machine.store.actorId).toBe(LEGACY_SETUP.identityId);
	}
	expect(completion).not.toHaveBeenCalled();
}

function registerControllerJoinedTests(
	backend: "SQLite" | "D1",
	current: () => Joined,
	replace: (j: Joined) => void,
) {
	it("runs the real Viewer connection runner through signed HTTP, browser consent and loopback before actual memory sync", async () => {
		// Arrange: retain the full historical controller genesis, with no own claim/binding/peer pin.
		const j = await useControllerFixture(current(), backend);
		replace(j);
		const links = j.f.coordinator.db.prepare("SELECT * FROM coordinator_auth_account_links").all();
		const grants = j.f.coordinator.db
			.prepare("SELECT * FROM coordinator_identity_group_grants")
			.all();
		const history = j.a.store.db.prepare("SELECT * FROM memory_items WHERE id=1").get();
		const decisions = j.a.store.db
			.prepare("SELECT * FROM policy_team_device_decisions ORDER BY 1,2")
			.all();
		// Act: use the same fresh OIDC/confirmation/key-signature ceremony as the normal connection UI.
		const readiness = await readCoordinatorDeviceSetup(setupClient(j));
		const connected = await connectWithViewerRunner(j);
		await registerPeerCapabilities(j);
		await maintainBoth(j);
		await createBoundary(j, LEGACY_SETUP.reviewedProject, REVIEW_SCOPE);
		await publish(j, LEGACY_SETUP.reviewedProject);
		const reviewedPins = pinBoth(j);
		memory(j.a, "Controller reviewed-only memory", REVIEW_SCOPE);
		const denied = await exchange(j);
		await createBoundary(j, LEGACY_SETUP.excludedProject, SHARE_SCOPE);
		await publish(j, LEGACY_SETUP.excludedProject);
		pinBoth(j);
		memory(j.b, "Controller connected B memory", SHARE_SCOPE);
		const transferred = await exchange(j);
		const providerCalls = connected.provider.fetch.mock.calls.length;
		j.a.store.close();
		j.a.store = new MemoryStore(j.a.dbPath, { keysDir: j.a.keysDir });
		const resume = () =>
			resumeDeviceRebind({
				dbPath: j.a.dbPath,
				keysDir: j.a.keysDir,
				coordinatorUrl: j.origin,
				groupId: LEGACY_SETUP.groupId,
				pending: connected.pending,
			});
		const resumed = await resume();
		const replay = await resume();
		await maintainBoth(j);
		// Assert: connection binds the unchanged Identity, without relinking or granting reviewed-only access.
		expect(readiness).toEqual({ kind: "connect_required" });
		expect(connected.outcome).toEqual({ kind: "bound" });
		expect(connected.browserStarts).toBe(1);
		expect(connected.paths).toEqual(
			expect.arrayContaining([
				"POST /v1/auth/rebind-attempts",
				`GET /v1/auth/rebind-attempts/${connected.pending.attemptId}`,
				`POST /v1/auth/rebind-attempts/${connected.pending.attemptId}/finalize`,
			]),
		);
		expect(connected.paths.filter((path) => path.endsWith("/finalize"))).toHaveLength(1);
		expect(reviewedPins).toEqual([0, 0]);
		expect(denied.result.ok).toBe(false);
		expect(transferred.result, JSON.stringify(transferred)).toMatchObject({ ok: true });
		expect(
			j.a.store.db
				.prepare("SELECT title FROM memory_items WHERE title='Controller connected B memory'")
				.get(),
		).toEqual({ title: "Controller connected B memory" });
		expect(
			j.b.store.db
				.prepare("SELECT title FROM memory_items WHERE title='Controller reviewed-only memory'")
				.get(),
		).toBeUndefined();
		expect(resumed).toMatchObject({
			kind: "finalized",
			receipt: {
				previousIdentityId: LEGACY_SETUP.identityId,
				targetIdentityId: LEGACY_SETUP.identityId,
			},
		});
		expect(replay).toEqual(resumed);
		expect(connected.provider.fetch.mock.calls.length).toBe(providerCalls);
		expect(readOpenLocalIdentitySwitch(j.a.store.db)).toBeNull();
		expect(
			j.f.coordinator.db.prepare("SELECT * FROM coordinator_auth_account_links").all(),
		).toEqual(links);
		expect(
			j.f.coordinator.db.prepare("SELECT * FROM coordinator_identity_group_grants").all(),
		).toEqual(grants);
		expect(
			j.f.coordinator.db.prepare("SELECT count(*) AS n FROM coordinator_auth_device_claims").get(),
		).toEqual({ n: 0 });
		expect(
			j.f.coordinator.db
				.prepare("SELECT count(*) AS n FROM coordinator_device_rebind_audit_log")
				.get(),
		).toEqual({ n: 1 });
		expect(j.a.store.db.prepare("SELECT * FROM memory_items WHERE id=1").get()).toEqual(history);
		expect(
			j.a.store.db.prepare("SELECT * FROM policy_team_device_decisions ORDER BY 1,2").all(),
		).toEqual(decisions);
	});

	registerWrongAccountJoinedTest(backend, current, replace);
}

function registerWrongAccountJoinedTest(
	backend: "SQLite" | "D1",
	current: () => Joined,
	replace: (j: Joined) => void,
) {
	it("leaves controller-only ownership and sync incomplete for fresh proof of the wrong account", async () => {
		// Arrange: Google verifies a different real synthetic subject, not the linked account.
		const j = await useControllerFixture(current(), backend);
		replace(j);
		const before = j.f.coordinator.db
			.prepare("SELECT * FROM coordinator_device_ownership_bindings")
			.all();
		// Act
		const flow = await controllerCeremony(j, "different-fixture-subject");
		const exchangeResult = await exchange(j);
		// Assert: browser authentication alone cannot finish this connection or create transport trust.
		expect(flow.verified).toMatchObject({ kind: "refused" });
		expect(exchangeResult.result.ok).toBe(false);
		expect(
			j.f.coordinator.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all(),
		).toEqual(before);
		expect(
			j.f.coordinator.db
				.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id='device-a'")
				.get(),
		).toEqual({ identity_id: null });
		expect(
			j.f.coordinator.db
				.prepare("SELECT count(*) AS n FROM coordinator_device_rebind_audit_log")
				.get(),
		).toEqual({ n: 0 });
		expect(j.a.store.db.prepare("SELECT count(*) AS n FROM sync_peers").get()).toEqual({ n: 0 });
		expect(j.a.store.actorId).toBe(LEGACY_SETUP.identityId);
	});
}

describe.each(["SQLite", "D1"] as const)("%s linked legacy setup joined sync", (backend) => {
	let j: Joined;
	let directory: string;
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(LEGACY_SETUP.now);
		directory = mkdtempSync(join(tmpdir(), "linked-legacy-sync-"));
		j = await joinedFixture(backend, directory);
		expect(j.a.store.actorId).toBe(LEGACY_SETUP.identityId);
		expect(j.b.store.actorId).toBe(LEGACY_SETUP.identityId);
		expect(j.a.store.hasCurrentIdentity()).toBe(true);
		expect(j.b.store.hasCurrentIdentity()).toBe(true);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) => {
				const request = new Request(input, init);
				const origin = new URL(request.url).origin;
				if ([DISCOVERY_ORIGIN, j.origin].includes(origin)) return j.f.app.request(request);
				if (origin === PEER_ORIGIN) {
					const previous = process.env.CODEMEM_KEYS_DIR ?? "";
					vi.stubEnv("CODEMEM_KEYS_DIR", j.b.keysDir);
					try {
						return await syncProtocolRoutes(() => j.b.store).request(request);
					} finally {
						vi.stubEnv("CODEMEM_KEYS_DIR", previous);
					}
				}
				throw new Error("External network forbidden");
			}),
		);
	});
	afterEach(async () => {
		j?.a.store.close();
		j?.b.store.close();
		await j?.f.close();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
		rmSync(directory, { recursive: true, force: true });
	});
	registerControllerJoinedTests(
		backend,
		() => j,
		(next) => {
			j = next;
		},
	);

	it("completes, publishes, derives policy pins and transfers real memory without admitting unresolved reviewed recipients", async () => {
		// Arrange: the exact historical NULL/no-binding/no-peer-pin state is still present.
		const history = j.a.store.db.prepare("SELECT * FROM memory_items WHERE id = 1").get();
		const decisions = j.a.store.db
			.prepare("SELECT * FROM policy_team_device_decisions ORDER BY 1,2")
			.all();
		// Act
		const completed = await completeCoordinatorDeviceSetup(setupClient(j));
		await registerPeerCapabilities(j);
		await reconcileBoth(j);
		await createBoundary(j, LEGACY_SETUP.reviewedProject, REVIEW_SCOPE);
		await publish(j, LEGACY_SETUP.reviewedProject);
		const reviewedPins = pinBoth(j);
		memory(j.a, "Unresolved reviewed Team memory", REVIEW_SCOPE);
		const denied = await exchange(j);
		await createBoundary(j, LEGACY_SETUP.excludedProject, SHARE_SCOPE);
		await publish(j, LEGACY_SETUP.excludedProject);
		const sharedPins = pinBoth(j);
		memory(j.b, "Recovered B memory", SHARE_SCOPE);
		const transferred = await exchange(j);
		const durable = () =>
			["coordinator_device_ownership_bindings", "coordinator_device_rebind_audit_log"].map(
				(table) => j.f.coordinator.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
			);
		const retained = durable();
		const keyBefore = readFileSync(join(j.a.keysDir, "device.key"));
		j.a.store.close();
		j.a.store = new MemoryStore(j.a.dbPath, { keysDir: j.a.keysDir });
		const restarted = await readCoordinatorDeviceSetup(setupClient(j));
		const retry = await completeCoordinatorDeviceSetup(setupClient(j));
		// Assert: real router and sync pass move authorized content, but no reviewed-only content.
		expect(completed).toEqual({ kind: "complete" });
		expect(restarted).toEqual(completed);
		expect(retry).toEqual(completed);
		expect(durable()).toEqual(retained);
		expect(readFileSync(join(j.a.keysDir, "device.key"))).toEqual(keyBefore);
		expect(
			(await j.f.coordinator.store.listEnrolledDevices(LEGACY_SETUP.groupId)).find(
				(row) => row.device_id === j.a.key.deviceId,
			),
		).toMatchObject({
			identity_id: LEGACY_SETUP.identityId,
			ownership_identity_id: LEGACY_SETUP.identityId,
		});
		expect(reviewedPins).toEqual([0, 0]);
		expect(denied.result.ok).toBe(false);
		expect(sharedPins).toEqual([1, 1]);
		expect(transferred.result, JSON.stringify(transferred)).toMatchObject({ ok: true });
		expect(
			j.a.store.db
				.prepare("SELECT title FROM memory_items WHERE title = 'Recovered B memory'")
				.get(),
		).toEqual({ title: "Recovered B memory" });
		expect(
			j.b.store.db
				.prepare("SELECT title FROM memory_items WHERE title = 'Unresolved reviewed Team memory'")
				.get(),
		).toBeUndefined();
		expect(j.a.store.db.prepare("SELECT * FROM memory_items WHERE id = 1").get()).toEqual(history);
		expect(
			j.a.store.db.prepare("SELECT * FROM policy_team_device_decisions ORDER BY 1,2").all(),
		).toEqual(decisions);
		expect(await j.f.coordinator.store.listScopeMemberships(SHARE_SCOPE)).toHaveLength(2);
	});
});
