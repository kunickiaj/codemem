import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CoordinatorEnrollment,
	completeCoordinatorDeviceSetup,
	ensureDeviceIdentity,
	initTestSchema,
	MemoryStore,
	readAccountLinkDevice,
	readCoordinatorSyncConfig,
	resolveKeyPaths,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceKey } from "../../core/src/coordinator-device-headless-link-test-fixtures.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	linkedLegacySetupFixture,
} from "../../core/src/linked-legacy-setup-test-fixtures.js";
import { reconcileConfiguredCoordinatorEnrollment, syncRoutes } from "./routes/sync.js";

type Options = NonNullable<Parameters<typeof reconcileConfiguredCoordinatorEnrollment>[1]>;
const now = "2026-07-29T00:00:00.000Z";
let directory: string;
let store: MemoryStore;
let keysDir: string;
let own: CoordinatorEnrollment;
let options: Options;
let calls: string[];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "device-setup-maintenance-"));
	keysDir = join(directory, "keys");
	const dbPath = join(directory, "memory.sqlite");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_ACTOR_ID", "identity-local");
	vi.stubEnv("CODEMEM_DEVICE_ID", "device-local");
	writeFileSync(join(directory, "config.json"), JSON.stringify({ actor_id: "identity-local" }));
	const db = new Database(dbPath);
	initTestSchema(db);
	ensureDeviceIdentity(db, { keysDir });
	db.prepare("UPDATE sync_device SET device_id='device-local'").run();
	db.exec(
		"CREATE TABLE local_identity_generation(id INTEGER PRIMARY KEY,generation INTEGER,actor_id TEXT); INSERT INTO local_identity_generation VALUES(1,1,'identity-local')",
	);
	store = Object.assign(Object.create(MemoryStore.prototype), {
		db,
		dbPath,
		deviceId: "device-local",
		actorId: "identity-local",
	});
	const device = readAccountLinkDevice(dbPath);
	own = {
		group_id: "group-a",
		device_id: device.deviceId,
		public_key: device.publicKey,
		fingerprint: device.fingerprint,
		identity_id: store.actorId,
		ownership_identity_id: store.actorId,
		enabled: 1,
		display_name: null,
		created_at: now,
	};
	calls = [];
	options = {
		config: {
			...readCoordinatorSyncConfig(),
			syncEnabled: true,
			syncCoordinatorUrl: "https://coord.example.test",
			syncCoordinatorAdminSecret: "synthetic-admin",
			syncCoordinatorGroups: ["group-a"],
		},
		listDevices: vi.fn(async () => {
			calls.push("devices");
			return [own];
		}),
		listConsumedTeamInvites: vi.fn(async () => {
			calls.push("invites");
			return [];
		}),
		reconcileSnapshot: vi.fn(() => {
			calls.push("reconcile");
			return { devicesAdded: 0, membershipsAdded: 0, identitiesAdded: 0, unchanged: 1, issues: [] };
		}),
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request");
		}),
	);
});
afterEach(() => {
	store.db.close();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function requireCompletion() {
	options.listDevices = vi
		.fn()
		.mockImplementationOnce(async () => {
			calls.push("devices");
			return [{ ...own, identity_id: null, ownership_identity_id: undefined }];
		})
		.mockImplementation(async () => {
			calls.push("devices");
			return [own];
		});
}
function expectFailure(
	result: Awaited<ReturnType<typeof reconcileConfiguredCoordinatorEnrollment>>,
	code: string,
) {
	expect(result).toMatchObject({ groupsProcessed: 0, failedGroups: 1 });
	expect(result.failures).toEqual([{ groupId: "group-a", stage: "complete_device_setup", code }]);
	expect(options.reconcileSnapshot).not.toHaveBeenCalled();
}

function configureActualProfile(f: LinkedLegacySetupFixture) {
	const [privatePath, publicPath] = resolveKeyPaths(keysDir);
	writeFileSync(privatePath, f.keyA.privateKey.export({ type: "pkcs8", format: "pem" }), {
		mode: 0o600,
	});
	writeFileSync(publicPath, f.keyA.publicKey, { mode: 0o600 });
	vi.stubEnv("CODEMEM_ACTOR_ID", LEGACY_SETUP.identityId);
	vi.stubEnv("CODEMEM_DEVICE_ID", f.keyA.deviceId);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "synthetic-maintenance-admin");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "https://coordinator.example.test");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", LEGACY_SETUP.groupId);
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({
			actor_id: LEGACY_SETUP.identityId,
			sync_enabled: true,
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_admin_secret: "synthetic-maintenance-admin",
			sync_coordinator_groups: [LEGACY_SETUP.groupId],
		}),
	);
	const actual: MemoryStore = Object.assign(Object.create(MemoryStore.prototype), {
		db: f.local,
		dbPath: f.local.name,
		deviceId: f.keyA.deviceId,
		actorId: LEGACY_SETUP.identityId,
	});
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			expect(new URL(request.url).origin).toBe("https://coordinator.example.test");
			requests.push(`${request.method} ${new URL(request.url).pathname}`);
			return f.app.request(request);
		}),
	);
	return { actual, requests };
}

it.each([null, LEGACY_SETUP.identityId])(
	"binds an actual historical claim with initial Identity %j through normal maintenance",
	async (identity) => {
		// Arrange: explicit Identity metadata without canonical ownership must not permanently skip completion.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(LEGACY_SETUP.now);
		const f = await linkedLegacySetupFixture("SQLite", {
			authConfigured: true,
			adminSecret: "synthetic-maintenance-admin",
			localDatabasePath: join(directory, "legacy.sqlite"),
		});
		try {
			f.coordinator.db
				.prepare("UPDATE enrolled_devices SET identity_id=? WHERE device_id=?")
				.run(identity, f.keyA.deviceId);
			const peer = f.coordinator.db
				.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id=?")
				.get(f.keyB.deviceId);
			const { actual, requests } = configureActualProfile(f);
			// Act: API signing, claim completion, fresh listing and snapshot reconciliation are real.
			const first = await reconcileConfiguredCoordinatorEnrollment(actual);
			const second = await reconcileConfiguredCoordinatorEnrollment(actual);
			// Assert: the second pass trusts canonical ownership and never repeats claim completion.
			expect(first).toMatchObject({ groupsProcessed: 1, failedGroups: 0, issues: 0 });
			expect(second).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
			expect(requests).toEqual([
				"GET /v1/admin/devices",
				"POST /v1/auth/device-binding",
				"GET /v1/admin/devices",
				"GET /v1/admin/invites",
				"GET /v1/admin/devices",
				"GET /v1/admin/invites",
			]);
			expect(
				(await f.coordinator.store.listEnrolledDevices(LEGACY_SETUP.groupId)).find(
					(e) => e.device_id === f.keyA.deviceId,
				),
			).toMatchObject({
				identity_id: LEGACY_SETUP.identityId,
				ownership_identity_id: LEGACY_SETUP.identityId,
			});
			expect(
				f.coordinator.db
					.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id=?")
					.get(f.keyB.deviceId),
			).toEqual(peer);
			expect(f.local.prepare("SELECT count(*) AS n FROM sync_peers").get()).toEqual({ n: 0 });
		} finally {
			await f.close();
		}
	},
);

describe("maintenance origins without a completion write", () => {
	it.each([
		{ url: "https://host:443", ownRow: true },
		{ url: "https://host:443", ownRow: false },
		{ url: "http://localhost:7347", ownRow: true },
		{ url: "http://localhost:7347", ownRow: false },
	])(
		"does not apply the account-link origin gate to read-only maintenance at $url (own=$ownRow)",
		async ({ url, ownRow }) => {
			// Arrange: these coordinator addresses remain usable for baseline listing/reconciliation.
			if (!options.config) throw new Error("Missing fixture config");
			options.config.syncCoordinatorUrl = url;
			options.listDevices = vi.fn(async () => {
				calls.push("devices");
				return ownRow ? [own] : [];
			});
			options.completeDeviceSetup = vi.fn(async () => ({ kind: "requires_review" }));
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
			// Assert
			expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
			expect(options.completeDeviceSetup).not.toHaveBeenCalled();
			expect(options.listConsumedTeamInvites).toHaveBeenCalledOnce();
			expect(options.reconcileSnapshot).toHaveBeenCalledOnce();
			expect(calls).toEqual(["devices", "invites", "reconcile"]);
		},
	);

	it("keeps reconciling a NULL own row when the coordinator URL cannot carry completion", async () => {
		// Arrange: an operator-enrolled device on a plain-HTTP coordinator, as in the Project sharing E2E.
		if (!options.config) throw new Error("Missing fixture config");
		options.config.syncCoordinatorUrl = "http://localhost:7347";
		own = { ...own, identity_id: null, ownership_identity_id: undefined };
		options.completeDeviceSetup = vi.fn(completeCoordinatorDeviceSetup);
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert
		expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(options.listConsumedTeamInvites).toHaveBeenCalledOnce();
		expect(options.reconcileSnapshot).toHaveBeenCalledOnce();
	});
});

describe("explicit-Identity baseline and initial refusal", () => {
	it.each(["http://localhost:7347", "https://host:443"])(
		"keeps reconciling an explicit-Identity row when %s cannot carry the completion request",
		async (url) => {
			// Arrange: the real client refuses this URL before dispatch.
			if (!options.config) throw new Error("Missing fixture config");
			options.config.syncCoordinatorUrl = url;
			own = { ...own, ownership_identity_id: undefined };
			options.completeDeviceSetup = vi.fn(completeCoordinatorDeviceSetup);
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
			// Assert
			expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(options.reconcileSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({ enrollments: [own] }),
			);
		},
	);

	it("preserves exact explicit-Identity rows when claim completion requires review", async () => {
		// Arrange: absence of canonical ownership must not erase pre-existing enrollment admission.
		own = { ...own, ownership_identity_id: undefined };
		options.completeDeviceSetup = vi.fn(async () => ({ kind: "requires_review" }));
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert
		expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
		expect(options.listDevices).toHaveBeenCalledOnce();
		expect(options.completeDeviceSetup).toHaveBeenCalledOnce();
		expect(options.listConsumedTeamInvites).toHaveBeenCalledOnce();
		expect(options.reconcileSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ enrollments: [own] }),
		);
	});

	it("does not hide a definitive refusal for explicit Identity metadata without ownership", async () => {
		// Arrange
		own = { ...own, ownership_identity_id: undefined };
		options.completeDeviceSetup = vi.fn(async () => ({
			kind: "unavailable",
			cause: "rate_limited",
		}));
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert
		expectFailure(result, "rate_limited");
		expect(options.listDevices).toHaveBeenCalledOnce();
		expect(options.listConsumedTeamInvites).not.toHaveBeenCalled();
	});

	it.each([
		{ identity_id: "foreign-identity" },
		{ ownership_identity_id: "foreign-identity" },
		{ public_key: "wrong-key" },
		{ fingerprint: "wrong-fingerprint" },
		{ enabled: 0 },
	])("refuses contradictory initial own metadata %j before POST", async (change) => {
		// Arrange
		own = { ...own, ...change };
		options.completeDeviceSetup = vi.fn(async () => ({ kind: "complete" }));
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert
		expectFailure(result, "device_setup_enrollment_incomplete");
		expect(options.completeDeviceSetup).not.toHaveBeenCalled();
		expect(options.listConsumedTeamInvites).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe("canonical ownership and compatibility", () => {
	it("skips claim-only completion only for a fresh exact canonical own binding", async () => {
		// Arrange
		options.completeDeviceSetup = vi.fn(async () => ({ kind: "requires_review" }));
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert
		expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
		expect(options.completeDeviceSetup).not.toHaveBeenCalled();
		expect(calls).toEqual(["devices", "invites", "reconcile"]);
	});

	it.each([null, "identity-local"])(
		"limits old-coordinator fallback for initial Identity %j",
		async (identity) => {
			// Arrange
			own = { ...own, identity_id: identity, ownership_identity_id: undefined };
			options.completeDeviceSetup = vi.fn(async () => {
				calls.push("POST");
				return { kind: "unsupported", cause: "coordinator_upgrade_required" };
			});
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
			// Assert
			expect(options.completeDeviceSetup).toHaveBeenCalledOnce();
			if (identity === null) {
				expectFailure(result, "coordinator_upgrade_required");
				expect(calls).toEqual(["devices", "POST"]);
			} else {
				expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
				expect(calls).toEqual(["devices", "POST", "invites", "reconcile"]);
			}
		},
	);

	it.each([
		{ label: "missing", row: null },
		{ label: "disabled", row: { enabled: 0 } },
		{ label: "wrong Identity", row: { identity_id: "other" } },
		{ label: "wrong key", row: { public_key: "other" } },
		{ label: "wrong fingerprint", row: { fingerprint: "other" } },
		{ label: "no canonical owner", row: { ownership_identity_id: undefined } },
		{ label: "conflicting canonical owner", row: { ownership_identity_id: "other" } },
	])("cannot confirm a completed POST when the fresh row has $label", async ({ row }) => {
		// Arrange
		requireCompletion();
		options.listDevices = vi
			.fn()
			.mockResolvedValueOnce([{ ...own, identity_id: null, ownership_identity_id: undefined }])
			.mockResolvedValueOnce(row === null ? [] : [{ ...own, ...row }]);
		options.completeDeviceSetup = vi.fn(async () => ({ kind: "complete" }));
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert
		expectFailure(result, "device_setup_enrollment_incomplete");
		expect(options.completeDeviceSetup).toHaveBeenCalledOnce();
		expect(options.listDevices).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ kind: "requires_review", code: "device_setup_requires_review" },
		{ kind: "unavailable", cause: "coordinator_rejected", code: "coordinator_rejected" },
		{ kind: "unavailable", cause: "rate_limited", code: "rate_limited" },
		{
			kind: "unavailable",
			cause: "coordinator_auth_schema_upgrade_required",
			code: "coordinator_auth_schema_upgrade_required",
		},
	] as const)(
		"does not turn definitive $code refusal into a healthy relist",
		async ({ code, ...outcome }) => {
			// Arrange: even a subsequently available canonical row cannot override a definitive refusal.
			requireCompletion();
			options.completeDeviceSetup = vi.fn(async () => outcome);
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
			// Assert
			expectFailure(result, code);
			expect(options.listDevices).toHaveBeenCalledOnce();
			expect(options.listConsumedTeamInvites).not.toHaveBeenCalled();
		},
	);
});

it.each([
	{ owner: "identity-local", confirmed: true },
	{ owner: undefined, confirmed: false },
])(
	"resolves an uncertain real POST only with fresh canonical ownership $owner",
	async ({ owner, confirmed }) => {
		// Arrange: a lost response causes one client GET, then maintenance reads fresh server ownership.
		requireCompletion();
		options.listDevices = vi
			.fn()
			.mockResolvedValueOnce([{ ...own, identity_id: null, ownership_identity_id: undefined }])
			.mockResolvedValueOnce([{ ...own, ownership_identity_id: owner }]);
		const transport = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error("lost write response"))
			.mockResolvedValueOnce(Response.json({ kind: "ready" }));
		vi.stubGlobal("fetch", transport);
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert: no second POST is sent in this pass, even when no owner is available.
		if (confirmed) expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
		else expectFailure(result, "completion_outcome_unknown");
		expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
		expect(options.listDevices).toHaveBeenCalledTimes(2);
	},
);

it.each([
	{ identity: "identity-foreign", local: 0, issues: 0 },
	{ identity: "identity-local", local: 1, issues: 1 },
])(
	"retains real operator reconciliation without an own row for $identity",
	async ({ identity, local, issues }) => {
		// Arrange: no local enrollment must not manufacture local-Identity admission for a peer.
		const key = deviceKey("operator-peer");
		store.db
			.prepare(
				"INSERT INTO actors(actor_id,display_name,is_local,status,created_at,updated_at) VALUES (?,'Operator',?,'active',?,?)",
			)
			.run(identity, local, now, now);
		const peer = {
			...own,
			device_id: key.deviceId,
			public_key: key.publicKey,
			fingerprint: key.fingerprint,
			identity_id: identity,
			ownership_identity_id: identity,
		};
		if (!local)
			store.db
				.prepare(
					"INSERT INTO identity_devices(device_id,identity_id,display_name,status,provenance,revision,migration_state,idempotency_key,created_at,updated_at) VALUES (?,?,'Operator','active','coordinator_enrollment','1','native','operator',?,?)",
				)
				.run(key.deviceId, identity, now, now);
		const before = store.db.prepare("SELECT * FROM identity_devices").all();
		options.listDevices = vi.fn(async () => [peer]);
		options.reconcileSnapshot = undefined;
		options.completeDeviceSetup = vi.fn(async () => ({ kind: "requires_review" }));
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert
		expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0, issues });
		expect(options.completeDeviceSetup).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(store.db.prepare("SELECT * FROM identity_devices").all()).toEqual(before);
		if (local)
			expect(
				store.db
					.prepare(
						"SELECT code FROM coordinator_enrollment_reconciliation_issues WHERE reference_id=?",
					)
					.get(key.deviceId),
			).toEqual({ code: "identity_not_active" });
	},
);

function drift(kind: string) {
	if (kind === "Identity") vi.stubEnv("CODEMEM_ACTOR_ID", "identity-other");
	if (kind === "key") writeFileSync(resolveKeyPaths(keysDir)[0], "invalid key");
	if (kind === "profile") store.db.exec("DELETE FROM sync_device");
	if (kind === "generation") store.db.exec("UPDATE local_identity_generation SET generation=2");
	if (options.config) {
		if (kind === "config") options.config.syncCoordinatorAdminSecret = "changed";
		if (kind === "coordinator") options.config.syncCoordinatorUrl = "https://other.example.test";
		if (kind === "group") options.config.syncCoordinatorGroups = ["other-group"];
	}
}

it.each(["Identity", "key", "profile", "generation", "config", "coordinator", "group"])(
	"rechecks %s context drift across the actual asynchronous POST",
	async (kind) => {
		// Arrange: reader-specific input matrices live with account/context.test.ts, not at every async boundary.
		requireCompletion();
		const transport = vi.fn<typeof fetch>(async () => {
			drift(kind);
			return Response.json({ kind: "complete" });
		});
		vi.stubGlobal("fetch", transport);
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
		// Assert
		expectFailure(result, "device_setup_context_changed");
		expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST"]);
		expect(options.listDevices).toHaveBeenCalledOnce();
		expect(options.listConsumedTeamInvites).not.toHaveBeenCalled();
	},
);

it("rechecks a healthy canonical context after the asynchronous invite read", async () => {
	// Arrange
	options.completeDeviceSetup = vi.fn(async () => ({ kind: "complete" }));
	options.listConsumedTeamInvites = vi.fn(async () => {
		drift("Identity");
		return [];
	});
	// Act
	const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
	// Assert
	expectFailure(result, "device_setup_context_changed");
	expect(options.completeDeviceSetup).not.toHaveBeenCalled();
});

it("preserves the superseded-Identity diagnostic before any coordinator read", async () => {
	// Arrange
	store.db
		.prepare("UPDATE local_identity_generation SET actor_id='identity-other',generation=2")
		.run();
	// Act
	const result = await reconcileConfiguredCoordinatorEnrollment(store, options);
	// Assert
	expectFailure(result, "local_identity_superseded");
	expect(options.listDevices).not.toHaveBeenCalled();
});

it.each([
	"/api/sync/status",
	"/api/sync/peers",
	"/api/sync/recipient-policy/v1/reconciliation-status",
])("keeps UI GET %s free of device completion", async (path) => {
	// Arrange
	const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ kind: "ready" }));
	vi.stubGlobal("fetch", transport);
	// Act
	const response = await syncRoutes(() => store).request(path);
	// Assert
	expect(response.status).toBe(200);
	for (const [url] of transport.mock.calls)
		expect(String(url)).not.toContain("/v1/auth/device-binding");
});
