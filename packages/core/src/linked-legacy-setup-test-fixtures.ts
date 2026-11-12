import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { expect, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createV2CoordinatorFile } from "./coordinator-account-schema-sqlite-test-fixtures.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { prepareHistoricalAccountDatabase } from "./coordinator-auth-historical-test-fixture.js";
import { cfg, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, review, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	type DeviceKey,
	deviceKey,
	signedHeaders,
} from "./coordinator-device-headless-link-test-fixtures.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import { connect, type Database } from "./db.js";
import { assignIdentityDeviceInTransaction } from "./identity-device-assignment.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { verifySignature } from "./sync-auth.js";

export const LEGACY_SETUP = {
	coordinatorId: cfg.coordinatorId,
	groupId: "group-a",
	identityId: "local:device-a",
	project: "https://git.example.test/fixture/shared.git",
	excludedProject: "https://git.example.test/fixture/team-only.git",
	reviewedProject: "https://git.example.test/fixture/reviewed-only.git",
	teamId: "fixture-team",
	reviewedTeamId: "fixture-reviewed-team",
	now: new Date(NOW).toISOString(),
} as const;

function insert(db: Database, table: string, row: Record<string, unknown>): void {
	const entries = Object.entries(row);
	db.prepare(
		`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
	).run(...entries.map(([, value]) => value));
}

const HISTORICAL_ACCOUNT_TABLES = [
	"coordinator_auth_browser_transactions",
	"coordinator_auth_link_attempts",
	"coordinator_auth_device_claims",
	"coordinator_auth_account_links",
	"coordinator_auth_link_audit_log",
] as const;

async function seedHistoricalOwnAccount(
	f: ReturnType<typeof setupStore>,
	key: DeviceKey,
	authority: "device_claim" | "controller_attestation",
) {
	const historical = new SqliteDatabase(":memory:");
	try {
		const pins = prepareHistoricalAccountDatabase(historical, {
			authority,
			bornAtMs: NOW - 60_000,
		});
		const replacements: Record<string, unknown> = {
			identity_id: LEGACY_SETUP.identityId,
			device_id: key.deviceId,
			public_key: key.publicKey,
			fingerprint: key.fingerprint,
			key_id: await ed25519KeyId(key.publicKey),
		};
		// Reuse the maintained pre-upgrade genesis builder, remapping its synthetic
		// principal/key fields together. Never call the new producer to seed legacy state.
		for (const table of HISTORICAL_ACCOUNT_TABLES) {
			for (const row of historical.prepare(`SELECT * FROM ${table}`).all() as Record<
				string,
				unknown
			>[]) {
				for (const [column, value] of Object.entries(replacements)) {
					if (Object.hasOwn(row, column)) row[column] = value;
				}
				insert(f.db, table, row);
			}
		}
		if (pins.controllerAttestationId) {
			expect(
				await f.store.createAuthControllerAttestation(
					review({
						attestationId: pins.controllerAttestationId,
						reviewReceiptId: "historical-review",
						identityId: LEGACY_SETUP.identityId,
						deviceId: key.deviceId,
						publicKey: key.publicKey,
						fingerprint: key.fingerprint,
					}),
				),
			).toMatchObject({ kind: "created" });
		}
		return {
			signer: {
				deviceId: key.deviceId,
				publicKey: key.publicKey,
				fingerprint: key.fingerprint,
				groupId: LEGACY_SETUP.groupId,
			},
			config: pins.config,
		};
	} finally {
		historical.close();
	}
}

function seedLocalState(db: Database, key: DeviceKey): void {
	const { identityId, now } = LEGACY_SETUP;
	insert(db, "sync_device", {
		device_id: key.deviceId,
		public_key: key.publicKey,
		fingerprint: key.fingerprint,
		created_at: now,
	});
	insert(db, "actors", {
		actor_id: identityId,
		display_name: "Fixture Owner",
		is_local: 1,
		status: "active",
		merged_into_actor_id: null,
		created_at: now,
		updated_at: now,
	});
	db.transaction(() => {
		for (const deviceId of ["device-a", "device-b", "device-excluded"]) {
			assignIdentityDeviceInTransaction(db, {
				deviceId,
				targetIdentityId: identityId,
				expectation: { kind: "absent" },
				now,
				insert: {
					displayName: deviceId,
					provenance: "legacy_migration",
					revision: "1",
					migrationState: "user_managed",
					idempotencyKey: `fixture-${deviceId}`,
				},
			});
		}
	})();
	seedRecipientIntent(db);
	seedReviewedTeamIntent(db);
	seedRetainedHistory(db);
}

function seedReviewedTeamIntent(db: Database): void {
	const { identityId, now, reviewedTeamId, reviewedProject } = LEGACY_SETUP;
	const metadata = {
		provenance: "fixture",
		migration_state: "user_managed",
		created_at: now,
		updated_at: now,
	};
	insert(db, "policy_teams", {
		...metadata,
		team_id: reviewedTeamId,
		display_name: "Reviewed Fixture Team",
		status: "active",
		device_eligibility_mode: "reviewed_allowlist",
		revision: "1",
		idempotency_key: reviewedTeamId,
	});
	insert(db, "policy_team_memberships", {
		...metadata,
		team_id: reviewedTeamId,
		identity_id: identityId,
		role: "member",
		status: "reviewed_active",
		revision: "1",
		idempotency_key: "fixture-reviewed-member",
	});
	// B has no reviewed inclusion. Setup recovery must not turn that absence into consent.
	insert(db, "policy_team_device_decisions", {
		team_id: reviewedTeamId,
		device_id: "device-a",
		decision: "included",
		assignment_version: 0,
		provenance: "user",
		revision: "1",
		created_at: now,
		updated_at: now,
	});
	insert(db, "project_recipients", {
		...metadata,
		canonical_project_identity: reviewedProject,
		recipient_kind: "team",
		recipient_id: reviewedTeamId,
		status: "active",
		policy_revision: "1",
		idempotency_key: "fixture-reviewed-grant",
	});
}

function seedRecipientIntent(db: Database): void {
	const { identityId, now } = LEGACY_SETUP;
	const metadata = {
		provenance: "fixture",
		migration_state: "user_managed",
		created_at: now,
		updated_at: now,
	};
	insert(db, "policy_teams", {
		...metadata,
		team_id: LEGACY_SETUP.teamId,
		display_name: "Fixture Team",
		status: "active",
		device_eligibility_mode: "person_all_devices",
		revision: "1",
		idempotency_key: "fixture-team",
	});
	insert(db, "policy_team_memberships", {
		...metadata,
		team_id: LEGACY_SETUP.teamId,
		identity_id: identityId,
		role: "member",
		status: "active",
		revision: "1",
		idempotency_key: "fixture-member",
	});
	seedExclusionAndGrants(db, metadata);
}

function seedExclusionAndGrants(db: Database, metadata: Record<string, unknown>): void {
	const { identityId, now } = LEGACY_SETUP;
	insert(db, "policy_team_device_decisions", {
		team_id: LEGACY_SETUP.teamId,
		device_id: "device-excluded",
		decision: "excluded",
		assignment_version: 0,
		provenance: "user",
		revision: "1",
		created_at: now,
		updated_at: now,
	});
	for (const [project, kind, recipient] of [
		[LEGACY_SETUP.project, "identity", identityId],
		[LEGACY_SETUP.excludedProject, "team", LEGACY_SETUP.teamId],
	]) {
		insert(db, "project_recipients", {
			...metadata,
			canonical_project_identity: project,
			recipient_kind: kind,
			recipient_id: recipient,
			status: "active",
			policy_revision: "1",
			idempotency_key: `fixture-${kind}`,
		});
	}
}

function seedRetainedHistory(db: Database): void {
	const { now } = LEGACY_SETUP;
	insert(db, "sessions", { id: 1, started_at: now, project: "fixture-shared" });
	insert(db, "memory_items", {
		id: 1,
		session_id: 1,
		kind: "discovery",
		title: "Retained fixture history",
		body_text: "Synthetic historical authorship must survive setup convergence.",
		actor_id: "historical-fixture-author",
		origin_device_id: "historical-fixture-device",
		visibility: "shared",
		workspace_id: "fixture-history",
		workspace_kind: "shared",
		created_at: now,
		updated_at: now,
	});
}

/** Persisted policy intent and attribution, separate from mutable setup evidence. */
export function legacySetupPreservationSnapshot(db: Database) {
	const tables = [
		"actors",
		"identity_devices",
		"policy_teams",
		"policy_team_memberships",
		"policy_team_device_decisions",
		"project_recipients",
		"sessions",
		"memory_items",
	];
	const rows = tables.map((table) => ({
		table,
		rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
	}));
	return { rows, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}

export function legacySetupEvidenceSnapshot(
	coordinator: ReturnType<typeof setupStore>,
	local: Database,
) {
	const coordinatorTables = [
		"enrolled_devices",
		"coordinator_device_ownership_bindings",
		"coordinator_auth_device_claims",
		"coordinator_auth_account_links",
		"coordinator_auth_link_audit_log",
		"coordinator_identity_group_grants",
		"coordinator_auth_controller_attestations",
	];
	const rows = coordinatorTables.map((table) => ({
		table,
		rows: coordinator.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
	}));
	const localRows = ["sync_device", "sync_peers"].map((table) => ({
		table,
		rows: local.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
	}));
	return {
		rows,
		localRows,
		digest: createHash("sha256").update(JSON.stringify({ rows, localRows })).digest("hex"),
	};
}

/**
 * Migration-shaped seed with a historical committed claim and NULL own enrollment.
 * Future producers may prevent this state, but upgraded databases
 * must still recover it. Profile metadata is never used as device authority.
 */
async function seedCoordinatorState(
	coordinator: ReturnType<typeof setupStore>,
	keyA: DeviceKey,
	keyB: DeviceKey,
	authority: "device_claim" | "controller_attestation",
) {
	await coordinator.store.createGroup(LEGACY_SETUP.groupId);
	await coordinator.store.enrollDevice(LEGACY_SETUP.groupId, keyA);
	const account = await seedHistoricalOwnAccount(coordinator, keyA, authority);
	await coordinator.store.enrollDevice(LEGACY_SETUP.groupId, {
		...keyB,
		identityId: LEGACY_SETUP.identityId,
	});
	// Historical B ownership is independent of A's account claim and profile.
	insert(coordinator.db, "coordinator_device_ownership_bindings", {
		device_id: keyB.deviceId,
		key_id: await ed25519KeyId(keyB.publicKey),
		identity_id: LEGACY_SETUP.identityId,
		coordinator_id: LEGACY_SETUP.coordinatorId,
		binding_id: "fixture-b-binding",
		provenance: "owner_enrollment",
		source_ref: "fixture-b-owner-attempt",
		bound_at: LEGACY_SETUP.now,
	});
	await seedExistingCoordinatorGrant(coordinator, keyB);
	coordinator.db
		.prepare("UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?")
		.run(keyA.deviceId);
	return account;
}

async function seedExistingCoordinatorGrant(
	coordinator: ReturnType<typeof setupStore>,
	key: DeviceKey,
) {
	const attestation = review({
		attestationId: "fixture-b-controller",
		identityId: LEGACY_SETUP.identityId,
		deviceId: key.deviceId,
		publicKey: key.publicKey,
		fingerprint: key.fingerprint,
		reviewReceiptId: "fixture-b-controller-receipt",
	});
	expect(await coordinator.store.createAuthControllerAttestation(attestation)).toMatchObject({
		kind: "created",
	});
	expect(
		await coordinator.store.issueIdentityGroupGrantFromControllerAttestation({
			coordinatorId: LEGACY_SETUP.coordinatorId,
			attestationId: attestation.attestationId,
		}),
	).toMatchObject({ kind: "created" });
}

function composeSignedApi(
	coordinator: ReturnType<typeof setupStore>,
	options: { authConfigured?: boolean; adminSecret?: string; authRedirectUri?: string },
) {
	const close = vi.spyOn(coordinator.store, "close").mockResolvedValue(undefined);
	const app = createCoordinatorApp({
		storeFactory: () => coordinator.store,
		...(options.authConfigured
			? {
					authLink: {
						config: {
							...cfg,
							redirectUri:
								options.authRedirectUri ?? "https://coordinator.example.test/auth/callback",
						},
						storeFactory: () => coordinator.store,
					},
				}
			: {}),
		runtime: { adminSecret: () => options.adminSecret ?? null, now: () => LEGACY_SETUP.now },
		requestVerifier: async (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
	});
	const signed = (key: DeviceKey, method: string, path: string, value?: unknown) => {
		const body = value === undefined ? "" : JSON.stringify(value);
		return app.request(`https://coordinator.example.test${path}`, {
			method,
			headers: signedHeaders(key, method, path, body),
			...(method === "GET" ? {} : { body }),
		});
	};
	return { app, signed, restoreClose: () => close.mockRestore() };
}

type LinkedLegacySetupOptions = NonNullable<Parameters<typeof linkedLegacySetupFixture>[1]>;

/**
 * The seeded account history predates the account extension. SQLite coordinators are
 * seeded as a V2 file and then reopened, so ordinary startup handles that history the way
 * it handles an upgraded coordinator. Tests that install the extension themselves keep it
 * on V2.
 */
async function seededCoordinator(
	backend: Backend,
	options: LinkedLegacySetupOptions,
	keyA: DeviceKey,
	keyB: DeviceKey,
) {
	const directory =
		backend === "SQLite" && !options.coordinatorDatabasePath
			? mkdtempSync(join(tmpdir(), "linked-legacy-coordinator-"))
			: undefined;
	const removeDirectory = () => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	};
	const path = options.coordinatorDatabasePath ?? join(directory ?? "", "coordinator.sqlite");
	if (backend === "SQLite") createV2CoordinatorFile(path);
	const seeding =
		backend === "SQLite"
			? new BetterSqliteCoordinatorStore(path, { authClock: () => NOW, existingOnly: true })
			: null;
	const coordinator = seeding
		? { store: seeding, db: seeding.db }
		: setupStore(backend, { authClock: () => NOW });
	try {
		const authority = options.accountAuthority ?? "device_claim";
		const account = await seedCoordinatorState(coordinator, keyA, keyB, authority);
		if (!seeding || options.accountSchema === "v2")
			return { coordinator, account, removeDirectory };
		await seeding.close();
		if (seeding.db.open) seeding.db.close();
		const store = new BetterSqliteCoordinatorStore(path, { authClock: () => NOW });
		return { coordinator: { store, db: store.db }, account, removeDirectory };
	} catch (error) {
		await coordinator.store.close();
		if (coordinator.db.open) coordinator.db.close();
		removeDirectory();
		throw error;
	}
}

export async function linkedLegacySetupFixture(
	backend: Backend,
	options: {
		localDatabasePath?: string;
		coordinatorDatabasePath?: string;
		accountAuthority?: "device_claim" | "controller_attestation";
		authConfigured?: boolean;
		adminSecret?: string;
		authRedirectUri?: string;
		/** SQLite only: `v2` keeps the seeded coordinator on V2 instead of reopening it. */
		accountSchema?: "current" | "v2";
	} = {},
): Promise<LinkedLegacySetupFixture> {
	const keyA = deviceKey("device-a");
	const keyB = deviceKey("device-b");
	const { coordinator, account, removeDirectory } = await seededCoordinator(
		backend,
		options,
		keyA,
		keyB,
	);
	const local = connect(options.localDatabasePath ?? ":memory:");
	try {
		seedLocalState(local, keyA);
		const api = composeSignedApi(coordinator, options);
		return {
			coordinator,
			local,
			keyA,
			keyB,
			account,
			app: api.app,
			signed: api.signed,
			before: legacySetupPreservationSnapshot(local),
			evidenceBefore: legacySetupEvidenceSnapshot(coordinator, local),
			recipients: (project: string = LEGACY_SETUP.project) =>
				deriveRecipientPolicyEffectiveDevicesFromDatabase(local, project),
			reconcile: async () =>
				reconcileCoordinatorEnrollmentSnapshot(local, {
					coordinatorId: LEGACY_SETUP.coordinatorId,
					groupId: LEGACY_SETUP.groupId,
					localDeviceId: keyA.deviceId,
					now: LEGACY_SETUP.now,
					consumedTeamInvites: [],
					enrollments: await coordinator.store.listEnrolledDevices(LEGACY_SETUP.groupId),
				}),
			close: async () => {
				api.restoreClose();
				await coordinator.store.close();
				if (coordinator.db.open) coordinator.db.close();
				local.close();
				removeDirectory();
			},
		};
	} catch (error) {
		await coordinator.store.close();
		if (coordinator.db.open) coordinator.db.close();
		local.close();
		removeDirectory();
		throw error;
	}
}

export interface LinkedLegacySetupFixture {
	coordinator: ReturnType<typeof setupStore>;
	local: Database;
	keyA: DeviceKey;
	keyB: DeviceKey;
	account: Awaited<ReturnType<typeof seedHistoricalOwnAccount>>;
	app: ReturnType<typeof createCoordinatorApp>;
	signed(
		key: DeviceKey,
		method: string,
		path: string,
		value?: unknown,
	): Response | Promise<Response>;
	before: ReturnType<typeof legacySetupPreservationSnapshot>;
	evidenceBefore: ReturnType<typeof legacySetupEvidenceSnapshot>;
	recipients(
		project?: string,
	): ReturnType<typeof deriveRecipientPolicyEffectiveDevicesFromDatabase>;
	reconcile(): ReturnType<typeof reconcileCoordinatorEnrollmentSnapshot>;
	close(): Promise<void>;
}
