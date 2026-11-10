import { copyFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CoordinatorDeviceSetupOutcome,
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
import { ed25519KeyId } from "../../core/src/coordinator-ed25519-key-id.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	linkedLegacySetupFixture,
} from "../../core/src/linked-legacy-setup-test-fixtures.js";
import { reconcileConfiguredCoordinatorEnrollment, syncRoutes } from "./routes/sync.js";

type Options = NonNullable<Parameters<typeof reconcileConfiguredCoordinatorEnrollment>[1]>;
const now = "2026-07-29T00:00:00.000Z";

function createProfile(directory: string) {
	const keysDir = join(directory, "keys");
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
	db.prepare("UPDATE sync_device SET device_id = 'device-local'").run();
	db.exec(`CREATE TABLE local_identity_generation(id INTEGER PRIMARY KEY, generation INTEGER, actor_id TEXT);
		INSERT INTO local_identity_generation VALUES (1, 1, 'identity-local')`);
	// Exercise the real Identity checks without starting unrelated store services.
	const store: MemoryStore = Object.assign(Object.create(MemoryStore.prototype), {
		db,
		dbPath,
		deviceId: "device-local",
		actorId: "identity-local",
	});
	return { store, keysDir, device: readAccountLinkDevice(dbPath) };
}

let directory: string;
let profile: ReturnType<typeof createProfile>;
let options: Options;
let calls: string[];
let ownEnrollment: CoordinatorEnrollment;
let complete: Extract<CoordinatorDeviceSetupOutcome, { receipt: unknown }>;

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "codemem-device-setup-maintenance-"));
	profile = createProfile(directory);
	calls = [];
	ownEnrollment = {
		group_id: "group-a",
		device_id: profile.device.deviceId,
		public_key: profile.device.publicKey,
		fingerprint: profile.device.fingerprint,
		identity_id: "identity-local",
		enabled: 1,
		display_name: null,
		created_at: now,
	};
	complete = {
		kind: "complete",
		receipt: {
			bindingId: "binding-local",
			claimId: "claim-local",
			coordinatorId: "coordinator-local",
			deviceId: profile.device.deviceId,
			keyId: String(await ed25519KeyId(profile.device.publicKey)),
			identityId: "identity-local",
			enrollmentCount: 1,
			boundAt: now,
		},
	};
	options = {
		config: {
			syncCoordinatorUrl: "https://coord.example.test",
			syncCoordinatorAdminSecret: "secret",
			syncCoordinatorGroups: ["group-a"],
		} as Options["config"],
		listDevices: vi.fn(async () => {
			calls.push("devices");
			return [ownEnrollment];
		}),
		listConsumedTeamInvites: vi.fn(async () => {
			calls.push("invites");
			return [];
		}),
		reconcileSnapshot: vi.fn(() => {
			calls.push("reconcile");
			return {
				devicesAdded: 0,
				membershipsAdded: 0,
				identitiesAdded: 0,
				unchanged: 1,
				issues: [],
			};
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
	profile.store.db.close();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function configureLegacyMaintenance(fixture: LinkedLegacySetupFixture) {
	const dbPath = join(directory, "legacy.sqlite");
	const [privatePath, publicPath] = resolveKeyPaths(profile.keysDir);
	writeFileSync(privatePath, fixture.keyA.privateKey.export({ type: "pkcs8", format: "pem" }), {
		mode: 0o600,
	});
	writeFileSync(publicPath, fixture.keyA.publicKey, { mode: 0o600 });
	vi.stubEnv("CODEMEM_ACTOR_ID", LEGACY_SETUP.identityId);
	vi.stubEnv("CODEMEM_DEVICE_ID", fixture.keyA.deviceId);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "synthetic-maintenance-admin");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "https://coordinator.example.test");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", LEGACY_SETUP.groupId);
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({
			actor_id: LEGACY_SETUP.identityId,
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_admin_secret: "synthetic-maintenance-admin",
			sync_coordinator_groups: [LEGACY_SETUP.groupId],
		}),
	);
	const store: MemoryStore = Object.assign(Object.create(MemoryStore.prototype), {
		db: fixture.local,
		dbPath,
		deviceId: fixture.keyA.deviceId,
		actorId: LEGACY_SETUP.identityId,
	});
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			expect(new URL(request.url).origin).toBe("https://coordinator.example.test");
			requests.push(`${request.method} ${new URL(request.url).pathname}`);
			return fixture.app.request(request);
		}),
	);
	return { store, requests };
}

describe("normal maintenance with the signed coordinator API", () => {
	it.each(["device_claim", "controller_attestation"] as const)(
		"uses actual completion and reconciliation for legacy %s authority",
		async (accountAuthority) => {
			// Arrange: historical genesis, real local key files, and the coordinator's actual router.
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(LEGACY_SETUP.now));
			const fixture = await linkedLegacySetupFixture("SQLite", {
				accountAuthority,
				authConfigured: true,
				adminSecret: "synthetic-maintenance-admin",
				localDatabasePath: join(directory, "legacy.sqlite"),
			});
			try {
				const { store, requests } = configureLegacyMaintenance(fixture);
				const peerBefore = await fixture.coordinator.store.listEnrolledDevices(
					LEGACY_SETUP.groupId,
				);
				const peerBindingBefore = fixture.coordinator.db
					.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id = ?")
					.get(fixture.keyB.deviceId);
				expect(
					peerBefore.find((row) => row.device_id === fixture.keyA.deviceId)?.identity_id,
				).toBeNull();
				expect(
					fixture.coordinator.db
						.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id = ?")
						.get(fixture.keyA.deviceId),
				).toBeUndefined();
				const completeDeviceSetup = vi.fn(completeCoordinatorDeviceSetup);
				expect(readCoordinatorSyncConfig().syncCoordinatorAdminSecret).toBe(
					"synthetic-maintenance-admin",
				);
				// Act: only the transport is substituted. Snapshot actions and reconciliation are real.
				const result = await reconcileConfiguredCoordinatorEnrollment(store, {
					config: readCoordinatorSyncConfig(),
					completeDeviceSetup,
				});
				// Assert: account/controller proof alone never becomes device ownership.
				const enrolled = await fixture.coordinator.store.listEnrolledDevices(LEGACY_SETUP.groupId);
				if (accountAuthority === "device_claim") {
					expect(result.failures).toEqual([]);
					expect(result).toMatchObject({
						groupsProcessed: 1,
						failedGroups: 0,
						issues: 0,
						unchanged: 2,
					});
					expect(enrolled.find((row) => row.device_id === fixture.keyA.deviceId)?.identity_id).toBe(
						LEGACY_SETUP.identityId,
					);
					expect(
						fixture.coordinator.db
							.prepare(
								"SELECT identity_id FROM coordinator_device_ownership_bindings WHERE device_id = ?",
							)
							.get(fixture.keyA.deviceId),
					).toEqual({ identity_id: LEGACY_SETUP.identityId });
					expect(requests).toEqual([
						"GET /v1/admin/devices",
						"GET /v1/auth/device-binding",
						"POST /v1/auth/device-binding",
						"GET /v1/admin/devices",
						"GET /v1/admin/invites",
					]);
				} else {
					expect(await completeDeviceSetup.mock.results[0]?.value).toEqual({
						kind: "connect_required",
					});
					expect(result.failures).toEqual([
						{
							groupId: LEGACY_SETUP.groupId,
							stage: "complete_device_setup",
							code: "device_setup_connect_required",
						},
					]);
					expect(enrolled).toEqual(peerBefore);
					expect(
						fixture.coordinator.db
							.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id = ?")
							.get(fixture.keyA.deviceId),
					).toBeUndefined();
					expect(requests).toEqual(["GET /v1/admin/devices", "GET /v1/auth/device-binding"]);
				}
				expect(completeDeviceSetup).toHaveBeenCalledOnce();
				expect(enrolled.find((row) => row.device_id === fixture.keyB.deviceId)).toEqual(
					peerBefore.find((row) => row.device_id === fixture.keyB.deviceId),
				);
				expect(
					fixture.coordinator.db
						.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id = ?")
						.get(fixture.keyB.deviceId),
				).toEqual(peerBindingBefore);
				expect(
					fixture.local
						.prepare("SELECT * FROM sync_peers WHERE peer_device_id = ?")
						.get(fixture.keyB.deviceId),
				).toBeUndefined();
			} finally {
				await fixture.close();
			}
		},
	);
});

function wireReceipt() {
	const receipt = complete.receipt;
	return {
		kind: "complete",
		receipt: {
			binding_id: receipt.bindingId,
			claim_id: receipt.claimId,
			coordinator_id: receipt.coordinatorId,
			device_id: receipt.deviceId,
			key_id: receipt.keyId,
			identity_id: receipt.identityId,
			enrollment_count: receipt.enrollmentCount,
			bound_at: receipt.boundAt,
		},
	};
}

function expectSetupFailure(
	result: Awaited<ReturnType<typeof reconcileConfiguredCoordinatorEnrollment>>,
	code: string,
) {
	expect(result).toMatchObject({ groupsProcessed: 0, failedGroups: 1 });
	expect(result.failures).toEqual([{ groupId: "group-a", stage: "complete_device_setup", code }]);
	expect(options.reconcileSnapshot).not.toHaveBeenCalled();
}

function requireCompletion() {
	let reads = 0;
	options.listDevices = vi.fn(async () => {
		calls.push("devices");
		reads += 1;
		if (reads === 1) return [{ ...ownEnrollment, identity_id: null }];
		return [ownEnrollment];
	});
}

describe("coordinator device setup completion ordering", () => {
	it.each([
		"existing owner binding without an own claim",
		"legacy enrollment without ownership fields",
	])("reconciles healthy %s without invoking claim-only completion", async (mode) => {
		// Arrange: normal enrollment already proves this exact local device and Identity.
		if (mode === "existing owner binding without an own claim") {
			Object.assign(ownEnrollment, { ownership_identity_id: "identity-local" });
		}
		options.completeDeviceSetup = vi.fn(async () => ({ kind: "requires_review" }));
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		// Assert
		expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
		expect(options.completeDeviceSetup).not.toHaveBeenCalled();
		expect(calls).toEqual(["devices", "invites", "reconcile"]);
	});
	it.each(["complete", "completed"] as const)(
		"waits for %s before reading the final snapshot",
		async (kind) => {
			// Arrange: completion is an explicit seam, not a substitute for local context checks.
			requireCompletion();
			options.completeDeviceSetup = vi.fn(async (input) => {
				expect(input).toMatchObject({
					dbPath: profile.store.dbPath,
					keysDir: profile.keysDir,
					currentIdentityId: "identity-local",
					groupId: "group-a",
				});
				calls.push("complete");
				return { ...complete, kind };
			});
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
			expect(calls).toEqual(["devices", "complete", "devices", "invites", "reconcile"]);
		},
	);

	it.each([
		[{ kind: "ready" }, "device_setup_ready"],
		[{ kind: "requires_review" }, "device_setup_requires_review"],
		[{ kind: "unknown", cause: "completion_outcome_unknown" }, "completion_outcome_unknown"],
		[{ kind: "unavailable", cause: "coordinator_unreachable" }, "coordinator_unreachable"],
	] as const)("does not reconcile a %j setup outcome", async (outcome, code) => {
		// Arrange
		requireCompletion();
		options.completeDeviceSetup = vi.fn(async () => outcome);
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		// Assert
		expectSetupFailure(result, code);
		expect(calls).toEqual(["devices"]);
	});
});

describe("device setup receipt requires a fresh matching enrollment", () => {
	it.each([
		{ label: "missing", row: null },
		{ label: "disabled", row: { enabled: 0 } },
		{ label: "null Identity", row: { identity_id: null } },
		{ label: "foreign Identity", row: { identity_id: "identity-foreign" } },
		{ label: "wrong key", row: { public_key: "wrong-key" } },
		{ label: "wrong fingerprint", row: { fingerprint: "wrong-fingerprint" } },
		{ label: "conflicting ownership", row: { ownership_identity_id: "identity-foreign" } },
	])(
		"does not reconcile a completed receipt with $label in the final snapshot",
		async ({ row }) => {
			// Arrange: only the initial NULL row is eligible for automatic completion.
			options.listDevices = vi
				.fn()
				.mockResolvedValueOnce([{ ...ownEnrollment, identity_id: null }])
				.mockResolvedValueOnce(row === null ? [] : [{ ...ownEnrollment, ...row }]);
			options.completeDeviceSetup = vi.fn(async () => complete);
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expect(options.completeDeviceSetup).toHaveBeenCalledOnce();
			expect(options.listDevices).toHaveBeenCalledTimes(2);
			expect(result).toMatchObject({ groupsProcessed: 0, failedGroups: 1 });
			expect(options.reconcileSnapshot).not.toHaveBeenCalled();
		},
	);
});

describe("coordinator device setup on unsupported coordinators", () => {
	it("accepts fresh exact own enrollment without contacting an old coordinator's completion API", async () => {
		// Arrange: an old coordinator need not support claim completion for a healthy enrollment.
		const transport = vi.fn(async () => {
			calls.push("GET");
			return new Response(null, { status: 404 });
		});
		vi.stubGlobal("fetch", transport);
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		// Assert
		expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
		expect(calls).toEqual(["devices", "invites", "reconcile"]);
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		{ enabled: 0 },
		{ identity_id: null },
		{ identity_id: "identity-foreign" },
		{ public_key: "wrong-key" },
		{ fingerprint: "wrong-fingerprint" },
		{ ownership_identity_id: "identity-foreign" },
	])("rejects unsupported coordinator fallback for own-row mismatch %j", async (change) => {
		// Arrange
		ownEnrollment = { ...ownEnrollment, ...change };
		options.completeDeviceSetup = vi.fn(async () => ({
			kind: "unsupported",
			cause: "coordinator_upgrade_required",
		}));
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		// Assert
		expectSetupFailure(result, "coordinator_upgrade_required");
		expect(options.completeDeviceSetup).toHaveBeenCalledOnce();
		expect(calls).toEqual(["devices"]);
	});

	it.each([{ device_id: "device-foreign" }, { group_id: "group-foreign" }])(
		"does not request completion for an initial row outside this device's selected group: %j",
		async (change) => {
			// Arrange: these rows do not describe this device's own enrollment in the selected group.
			ownEnrollment = { ...ownEnrollment, ...change };
			options.completeDeviceSetup = vi.fn(async () => ({
				kind: "unsupported",
				cause: "coordinator_upgrade_required",
			}));
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
			expect(options.completeDeviceSetup).not.toHaveBeenCalled();
			expect(calls).toEqual(["devices", "invites", "reconcile"]);
		},
	);

	it("does not invent own authority when an operator group's fresh snapshot is empty", async () => {
		// Arrange
		options.completeDeviceSetup = vi.fn(async () => ({
			kind: "unsupported",
			cause: "coordinator_upgrade_required",
		}));
		options.listDevices = vi.fn(async () => []);
		options.reconcileSnapshot = undefined;
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		// Assert
		expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0, issues: 0 });
		expect(options.completeDeviceSetup).not.toHaveBeenCalled();
		expect(profile.store.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		expect(profile.store.db.prepare("SELECT COUNT(*) FROM sync_peers").pluck().get()).toBe(0);
	});
});

function drift(kind: string) {
	if (kind === "Identity") vi.stubEnv("CODEMEM_ACTOR_ID", "identity-other");
	if (kind === "config") {
		const config = options.config;
		if (config) config.syncCoordinatorAdminSecret = "changed";
	}
	if (kind === "generation")
		profile.store.db.exec("UPDATE local_identity_generation SET generation = 2");
	if (kind === "inode") {
		const replacement = join(directory, "replacement.sqlite");
		copyFileSync(profile.store.dbPath, replacement);
		renameSync(replacement, profile.store.dbPath);
	}
	if (kind === "key") writeFileSync(resolveKeyPaths(profile.keysDir)[0], "invalid private key");
	if (kind === "profile") profile.store.db.exec("DELETE FROM sync_device");
}

function operatorPeer(identityId: string, isLocal: number) {
	const key = deviceKey("device-operator-peer");
	profile.store.db
		.prepare(`INSERT INTO actors(
		actor_id, display_name, is_local, status, created_at, updated_at
	) VALUES (?, 'Operator peer owner', ?, 'active', ?, ?)`)
		.run(identityId, isLocal, now, now);
	const enrollment = {
		...ownEnrollment,
		device_id: key.deviceId,
		public_key: key.publicKey,
		fingerprint: key.fingerprint,
		identity_id: identityId,
		ownership_identity_id: identityId,
		display_name: "Operator peer",
	};
	if (isLocal === 0) {
		profile.store.db
			.prepare(`INSERT INTO identity_devices(
			device_id, identity_id, display_name, status, provenance, revision, migration_state,
			idempotency_key, created_at, updated_at
		) VALUES (?, ?, 'Operator peer', 'active', 'coordinator_enrollment', '1', 'native', ?, ?, ?)`)
			.run(key.deviceId, identityId, "operator-peer-assignment", now, now);
	}
	return enrollment;
}

describe("operator groups without an enrolled local device", () => {
	it.each([
		{ identityId: "identity-foreign", isLocal: 0, issues: 0 },
		{ identityId: "identity-local", isLocal: 1, issues: 1 },
	])(
		"keeps baseline reconciliation for actor $identityId without completing this device",
		async ({ identityId, isLocal, issues }) => {
			// Arrange: an admin may manage a group without enrolling this local device in it.
			const peer = operatorPeer(identityId, isLocal);
			const readAssignment = () =>
				profile.store.db
					.prepare("SELECT * FROM identity_devices WHERE device_id = ?")
					.get(peer.device_id);
			const before = readAssignment();
			options.listDevices = vi.fn(async () => [peer]);
			options.reconcileSnapshot = undefined;
			options.completeDeviceSetup = vi.fn(async () => ({ kind: "requires_review" }));
			// Act: use the maintained reconciler, including its existing local-Identity admission rule.
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expect(result).toMatchObject({ groupsProcessed: 1, failedGroups: 0, issues });
			expect(options.completeDeviceSetup).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(readAssignment()).toEqual(before);
			if (isLocal === 1) {
				expect(
					profile.store.db
						.prepare(
							"SELECT code FROM coordinator_enrollment_reconciliation_issues WHERE reference_id = ?",
						)
						.get(peer.device_id),
				).toEqual({ code: "identity_not_active" });
			}
		},
	);
});

describe("device setup initial availability and healthy-path drift", () => {
	it("reports local_identity_superseded when the actual generation marker names another Identity", async () => {
		// Arrange: the real MemoryStore check reads the persisted generation marker.
		profile.store.db
			.prepare("UPDATE local_identity_generation SET generation = 2, actor_id = ? WHERE id = 1")
			.run("identity-other");
		options.completeDeviceSetup = vi.fn(async () => complete);
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		// Assert
		expectSetupFailure(result, "local_identity_superseded");
		expect(options.completeDeviceSetup).not.toHaveBeenCalled();
		expect(options.listDevices).not.toHaveBeenCalled();
	});

	it.each(["missing key", "unreadable key", "missing profile", "unreadable profile"])(
		"reports device_unavailable for an initially %s",
		async (kind) => {
			// Arrange: failures before the first snapshot have no valid captured local context.
			const privatePath = resolveKeyPaths(profile.keysDir)[0];
			if (kind === "missing key") renameSync(privatePath, `${privatePath}.missing`);
			if (kind === "unreadable key") writeFileSync(privatePath, "invalid private key");
			if (kind.includes("profile")) {
				renameSync(profile.store.dbPath, `${profile.store.dbPath}.previous`);
				if (kind === "unreadable profile") writeFileSync(profile.store.dbPath, "invalid database");
			}
			options.completeDeviceSetup = vi.fn(async () => complete);
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expectSetupFailure(result, "device_unavailable");
			expect(options.listDevices).not.toHaveBeenCalled();
			expect(options.completeDeviceSetup).not.toHaveBeenCalled();
		},
	);

	it.each(["Identity", "config", "generation", "inode", "key", "profile"])(
		"blocks %s drift inside the invite read on the healthy fast path",
		async (kind) => {
			// Arrange: the exact own enrollment skips completion, but cannot skip local context checks.
			options.completeDeviceSetup = vi.fn(async () => ({ kind: "requires_review" }));
			options.listConsumedTeamInvites = vi.fn(async () => {
				drift(kind);
				return [];
			});
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expectSetupFailure(result, "device_setup_context_changed");
			expect(options.completeDeviceSetup).not.toHaveBeenCalled();
			expect(options.listConsumedTeamInvites).toHaveBeenCalledOnce();
		},
	);
});

describe("coordinator device setup local context changes", () => {
	it.each(["Identity", "config", "generation", "inode", "key"])(
		"blocks %s drift as completion returns before reading snapshots",
		async (kind) => {
			// Arrange
			requireCompletion();
			options.completeDeviceSetup = vi.fn(async () => {
				drift(kind);
				return complete;
			});
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expectSetupFailure(result, "device_setup_context_changed");
			expect(calls).toEqual(["devices"]);
		},
	);
	it.each(["Identity", "config", "generation", "inode", "key"])(
		"blocks %s drift between signed GET and POST",
		async (kind) => {
			// Arrange: drift occurs after GET admission, before the client's next signed request.
			requireCompletion();
			const transport = vi.fn(async () => {
				calls.push("GET");
				drift(kind);
				return Response.json({ kind: "ready" });
			});
			vi.stubGlobal("fetch", transport);
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expectSetupFailure(result, "device_setup_context_changed");
			expect(transport).toHaveBeenCalledOnce();
			expect(calls).toEqual(["devices", "GET"]);
		},
	);

	it.each(["Identity", "config", "generation", "inode", "key"])(
		"blocks %s drift after completion before snapshot reconciliation",
		async (kind) => {
			// Arrange
			options.completeDeviceSetup = vi.fn(async () => complete);
			options.listDevices = vi
				.fn()
				.mockResolvedValueOnce([{ ...ownEnrollment, identity_id: null }])
				.mockImplementationOnce(async () => {
					drift(kind);
					return [ownEnrollment];
				});
			// Act
			const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
			// Assert
			expectSetupFailure(result, "device_setup_context_changed");
		},
	);
});

describe("read-only sync UI routes", () => {
	it.each([
		"/api/sync/status",
		"/api/sync/peers",
		"/api/sync/recipient-policy/v1/reconciliation-status",
	])("does not start device completion from GET %s", async (path) => {
		// Arrange: configure a real local profile with incomplete remote setup.
		writeFileSync(
			join(directory, "config.json"),
			JSON.stringify({
				actor_id: "identity-local",
				sync_enabled: true,
				sync_coordinator_url: "https://coord.example.test",
				sync_coordinator_admin_secret: "secret",
				sync_coordinator_groups: ["group-a"],
			}),
		);
		const transport = vi.fn(async (_url: string, _init?: RequestInit) =>
			Response.json({ kind: "ready" }),
		);
		vi.stubGlobal("fetch", transport);
		const app = syncRoutes(() => profile.store);
		// Act
		const response = await app.request(path);
		// Assert
		expect(response.status).toBe(200);
		for (const [url] of transport.mock.calls) {
			expect(String(url)).not.toContain("/v1/auth/device-binding");
		}
	});
});

describe("coordinator device setup retry recovery", () => {
	it("recovers a lost POST response by receipt GET and retries with no additional POST", async () => {
		// Arrange: real client signing and decoding, deterministic transport only.
		requireCompletion();
		let committed = false;
		const transport = vi.fn(async (_url: string, init?: RequestInit) => {
			calls.push(String(init?.method));
			if (init?.method === "POST") {
				committed = true;
				throw new Error("response lost after commit");
			}
			return Response.json(committed ? wireReceipt() : { kind: "ready" });
		});
		vi.stubGlobal("fetch", transport);
		// Act
		const first = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		const second = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		// Assert
		expect(first).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
		expect(second).toMatchObject({ groupsProcessed: 1, failedGroups: 0 });
		expect(calls).toEqual([
			"devices",
			"GET",
			"POST",
			"GET",
			"devices",
			"invites",
			"reconcile",
			"devices",
			"invites",
			"reconcile",
		]);
	});

	it("keeps an uncertain uncommitted POST passive until a later maintenance invocation", async () => {
		// Arrange
		requireCompletion();
		const transport = vi.fn(async (_url: string, init?: RequestInit) => {
			calls.push(String(init?.method));
			if (init?.method === "POST") throw new Error("request lost before commit");
			return Response.json({ kind: "ready" });
		});
		vi.stubGlobal("fetch", transport);
		// Act
		const result = await reconcileConfiguredCoordinatorEnrollment(profile.store, options);
		// Assert
		expectSetupFailure(result, "completion_outcome_unknown");
		expect(calls).toEqual(["devices", "GET", "POST", "GET"]);
	});
});
