import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	ensureDeviceIdentity,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import {
	fixture as accountFixture,
	NOW,
	ORIGIN,
} from "../../../core/src/coordinator-account-change-http-test-fixtures.js";
import { createCoordinatorApp } from "../../../core/src/coordinator-api.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "../../../core/src/coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "../../../core/src/coordinator-browser-csrf.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "../../../core/src/coordinator-legacy-team-completion.js";
import { oidcFixture, PROVIDER } from "../../../core/src/coordinator-oidc-test-fixtures.js";
import { legacyTeamCandidateId } from "../../../core/src/recipient-policy-identifiers.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "../../../core/src/recipient-policy-reconciliation.js";
import { createInMemoryRequestRateLimiter } from "../../../core/src/request-rate-limit.js";
import { recoveryTests } from "../../test/owner-recovery-service-fixture.js";
import { seedResolvedOwner } from "../../test/resolved-owner-test-fixture.js";
import { createAccountContextReader } from "../account/context.js";
import { createAccountLinkRegistry } from "../account/link-registry.js";
import { createAccountOwnerRecoveryService } from "../account/owner-recovery-service.js";
import type { RecoveryPreview, RecoveryProfile } from "../account/owner-recovery-types.js";
import { createApp } from "../index.js";
import { __teamSetupTestHooks } from "./team-setup.js";
import type { LegacyTeamSetupDetailResponseV1 } from "./team-setup-view.js";

recoveryTests();
const FUTURE = "future-team";
const GROUPS = ["group-a", "group-b"];
const LOCAL = "http://127.0.0.1:7441";
const PROJECT = "https://example.invalid/retained.git";
const BASE = "/api/account/owner-recovery";
const ADMIN = "synthetic-team-admin";
const now = new Date(NOW).toISOString();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
const SETUP = `/api/sync/team-setup/v1/${legacyTeamCandidateId(ORIGIN, FUTURE)}`;
type Fixture = Awaited<ReturnType<typeof teamRecoveryFixture>>;
type Viewer = Awaited<ReturnType<Fixture["viewer"]>>;

// Reuse the real account-birth and historical-source harnesses. Ordinary setup
// uses a URL coordinator ID, unlike the older recovery-only fixture.
async function teamRecoveryFixture(cleanup: (fn: () => void | Promise<void>) => void) {
	const remote = await accountFixture("device_claim", {
		issuer: "https://accounts.google.com",
		coordinatorId: ORIGIN,
	});
	const directory = mkdtempSync(join(tmpdir(), "joined-team-recovery-"));
	cleanup(() => rmSync(directory, { recursive: true, force: true }));
	const dbPath = join(directory, "memory.sqlite");
	const keysDir = join(directory, "keys");
	const configPath = join(directory, "config.json");
	const config = {
		actor_id: "identity-b",
		sync_coordinator_url: ORIGIN,
		sync_coordinator_groups: GROUPS,
	};
	writeFileSync(configPath, JSON.stringify(config));
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const db = connect(dbPath);
	initTestSchema(db);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir });
	const { fingerprint } = db.prepare("SELECT fingerprint FROM sync_device").get() as {
		fingerprint: string;
	};
	db.close();
	let store = new MemoryStore(dbPath, { keysDir });
	cleanup(() => store.close());
	seedLocalSharing(store, deviceId);
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing fixture key");
	const signer = { groupId: "group-a", deviceId, publicKey, fingerprint };
	await seedRemoteHistory(remote, signer);
	const { requests, responses } = await connectCoordinatorTransport(remote);
	const profile = { dbPath, deviceId, identityId: "identity-b", identityLabel: "Original B" };
	const readContext = createAccountContextReader({
		getProfile: () => profile,
		readConfig: () => config,
		keysDir,
		configPath,
	});
	const link = vi.fn(async () => {
		throw new Error("Owner display cannot link accounts");
	});
	async function viewer() {
		const registry = createAccountLinkRegistry({ readContext, link });
		const recovery = createAccountOwnerRecoveryService({
			readContext,
			registry,
			readAdminSecret: () => ADMIN,
			now: () => NOW,
		});
		cleanup(() => registry.close());
		cleanup(() => recovery.close());
		const readSetupConfig = () => ({
			...readCoordinatorSyncConfig({}),
			syncCoordinatorUrl: ORIGIN,
			syncCoordinatorGroups: [FUTURE],
			syncCoordinatorAdminSecret: ADMIN,
		});
		const app = createApp({
			storeFactory: () => store,
			accountLink: {
				readContext,
				registry,
				ownerRecovery: recovery,
				getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
			},
			readCoordinatorConfig: readSetupConfig,
			loadLegacyTeamConfiguredGroupSnapshots: (options) =>
				__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
					{
						readConfig: readSetupConfig,
						listGroups: coordinatorListGroupsAction,
						listDevices: coordinatorListDevicesAction,
					},
					options,
					() => store,
				),
		});
		const sessionResponse = await app.request(`${LOCAL}/api/account/session`, {
			headers: { Host: "127.0.0.1:7441" },
		});
		const { csrfToken } = (await sessionResponse.json()) as { csrfToken: string };
		return {
			send: (path: string, method = "GET", body?: unknown) =>
				app.request(`${LOCAL}${path}`, {
					method,
					headers: {
						Host: "127.0.0.1:7441",
						Origin: LOCAL,
						"X-Codemem-Account-Csrf": csrfToken,
						"Content-Type": "application/json",
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			close: async () => {
				await recovery.close();
				await registry.close();
			},
		};
	}
	function rows(table: string) {
		return store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
	}
	const access = () => deriveRecipientPolicyEffectiveDevicesFromDatabase(store.db, PROJECT);
	return {
		...remote,
		deviceId,
		requests,
		responses,
		link,
		readContext,
		viewer,
		rows,
		access,
		restart: () => {
			store.close();
			store = new MemoryStore(dbPath, { keysDir });
		},
		stable: () => stableSnapshot(store.db, keysDir, configPath),
	};
}

function stableSnapshot(db: MemoryStore["db"], keysDir: string, configPath: string) {
	const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
	const access = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT);
	return {
		memories: rows("memory_items"),
		sessions: rows("sessions"),
		actors: rows("actors"),
		keys: readdirSync(keysDir)
			.sort()
			.map((name) => [name, readFileSync(join(keysDir, name))]),
		config: readFileSync(configPath),
		grants: rows("project_recipients").filter(
			(row) =>
				(row as { canonical_project_identity: string }).canonical_project_identity === PROJECT,
		),
		memberships: rows("policy_team_memberships").filter(
			(row) => (row as { team_id: string }).team_id === "retained-team",
		),
		accessStatus: access.status,
		access: access.devices.map(({ deviceId }) => deviceId),
	};
}

type RemoteFixture = Awaited<ReturnType<typeof accountFixture>>;
type Signer = { groupId: string; deviceId: string; publicKey: string; fingerprint: string };

function seedLocalSharing(store: MemoryStore, deviceId: string) {
	const session = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "joined-team",
		project: "retained",
	});
	store.remember(session, "decision", "Original B history", "Keep B authorship", 1, [], {});
	expect(store.actorId).toBe("identity-b");
	// These are pre-existing catalog rows, not new globally distinct identities.
	store.db
		.prepare(`INSERT INTO actors(actor_id,display_name,is_local,status,created_at,updated_at)
	 VALUES ('identity-a','Known A',0,'active',?,?)`)
		.run(now, now);
	store.db
		.prepare(`INSERT INTO actors(actor_id,display_name,is_local,status,created_at,updated_at)
	 VALUES ('identity-b','Original B',1,'active',?,?)`)
		.run(now, now);
	store.db
		.prepare(`INSERT INTO identity_devices(device_id,identity_id,display_name,status,provenance,revision,migration_state,assignment_version,idempotency_key,created_at,updated_at)
	 VALUES (?,'identity-b','Retained laptop','active','explicit','original','completed',1,'original-device',?,?)`)
		.run(deviceId, now, now);
	store.db
		.prepare(`INSERT INTO policy_teams(team_id,display_name,status,device_eligibility_mode,provenance,revision,migration_state,idempotency_key,created_at,updated_at)
	 VALUES ('retained-team','Existing sharing','active','person_all_devices','explicit','original','completed','original-team',?,?)`)
		.run(now, now);
	for (const identity of ["identity-a", "identity-b"]) {
		store.db
			.prepare(`INSERT INTO policy_team_memberships(team_id,identity_id,role,status,provenance,revision,migration_state,idempotency_key,created_at,updated_at)
		 VALUES ('retained-team',?,'member','active','explicit','original','completed',?,?,?)`)
			.run(identity, `original-${identity}`, now, now);
	}
	store.db
		.prepare(`INSERT INTO project_recipients(canonical_project_identity,recipient_kind,recipient_id,status,provenance,policy_revision,migration_state,idempotency_key,created_at,updated_at)
	 VALUES (?,'team','retained-team','active','explicit','original','completed','original-recipient',?,?)`)
		.run(PROJECT, now, now);
}

async function seedRemoteHistory(remote: RemoteFixture, signer: Signer) {
	await seedResolvedOwner(remote, signer, { fact: false });
	const source = remote.db
		.prepare("SELECT manifest_json FROM coordinator_legacy_team_completions")
		.get() as { manifest_json: string };
	const original = JSON.parse(source.manifest_json);
	remote.db.exec("DELETE FROM coordinator_legacy_team_completions");
	for (const [index, groupId] of GROUPS.entries()) {
		if (groupId !== "group-a") {
			await remote.store.createGroup(groupId);
			await remote.store.enrollDevice(groupId, signer);
		}
		const identity = index === 0 ? "identity-a" : "identity-b";
		const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
			...original,
			candidate_ref: legacyTeamCandidateId(ORIGIN, groupId),
			team_id: `historical-team-${index}`,
			memberships: [{ identity_id: identity, role: "member" }],
			device_decisions: original.device_decisions.map((decision: Record<string, unknown>) => ({
				...decision,
				identity_id: identity,
			})),
		});
		remote.db
			.prepare(`INSERT INTO coordinator_legacy_team_completions(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
		 VALUES (?,?,1,?,?,?)`)
			.run(
				groupId,
				manifest.candidate_ref,
				canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
				now,
				now,
			);
	}
	await remote.store.createGroup(FUTURE);
	await remote.store.enrollDevice(FUTURE, signer);
	for (const groupId of [...GROUPS, FUTURE]) {
		remote.db
			.prepare(
				"UPDATE enrolled_devices SET identity_id='identity-b' WHERE device_id=? AND group_id=?",
			)
			.run(signer.deviceId, groupId);
	}
	// The source-controller enrollment keeps its original NULL label. B labels
	// have real legacy/consumed-Project origin, not an arbitrary enrollment override.
	remote.db
		.prepare(`INSERT INTO coordinator_invites(invite_id,group_id,token,policy,created_at,expires_at,consumed_at,bound_device_id,bound_public_key,bound_fingerprint,invite_kind,recipient_actor_id,reviewed_preview_digest)
	 VALUES ('retained-project',?,'synthetic-project-token','open',?,?,?,?,?,?,'project_share','identity-b',?)`)
		.run(
			"group-a",
			now,
			"2026-10-25T00:00:00.000Z",
			now,
			signer.deviceId,
			signer.publicKey,
			signer.fingerprint,
			"e".repeat(64),
		);
}

async function connectCoordinatorTransport(remote: RemoteFixture) {
	const browser = await createCoordinatorBrowserAuth(
		captureCoordinatorBrowserAuthOptions({
			config: {
				...remote.config,
				clientId: PROVIDER.clientId,
				clientSecret: PROVIDER.clientSecret,
			},
			csrfKey: await importBrowserCsrfKey(randomBytes(32)),
			oidcOptions: { fetch: oidcFixture({ issuer: remote.config.issuer }).fetch },
		}),
		remote.store,
		createInMemoryRequestRateLimiter({ now: () => NOW }),
	);
	if (!browser.ok) throw new Error("Missing fixture browser auth");
	const coordinator = createCoordinatorApp({
		...remote.options,
		runtime: { ...remote.options.runtime, adminSecret: () => ADMIN },
		browserAuth: {
			kind: "ready",
			auth: browser.auth,
			storeFactory: () => remote.store,
			clientKey: () => "synthetic-client",
		},
	});
	const requests: Request[] = [];
	const responses: Array<{ method: string; path: string; status: number; body: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).origin !== ORIGIN) throw new Error("External network forbidden");
			requests.push(request.clone());
			const response = await coordinator.request(request);
			responses.push({
				method: request.method,
				path: new URL(request.url).pathname,
				status: response.status,
				body: await response.clone().text(),
			});
			return response;
		}),
	);
	return { requests, responses };
}

function completionPosts(f: Fixture) {
	return f.requests.filter(
		(request) =>
			request.method === "POST" &&
			new URL(request.url).pathname === "/v1/admin/legacy-team-completions",
	);
}

async function recover(f: Fixture, app: Viewer) {
	const stable = f.stable();
	const assignments = f.rows("identity_devices");
	const authorization = [
		"policy_teams",
		"policy_team_memberships",
		"policy_team_device_decisions",
		"project_recipients",
	].map((table) => f.rows(table));
	const remote = f.snapshot().filter(([name]) => name !== "coordinator_legacy_owner_resolutions");
	const profileResponse = await app.send(BASE);
	expect(profileResponse.status).toBe(200);
	const { profile } = (await profileResponse.json()) as { profile: RecoveryProfile };
	const previewResponse = await app.send(`${BASE}/preview`, "POST", {
		profile,
		existingOwnerId: "identity-a",
		groups: GROUPS,
		purpose: "review",
		requestId: "joined-normal-setup",
	});
	expect(previewResponse.status).toBe(200);
	const preview = (await previewResponse.json()) as RecoveryPreview;
	expect(preview.history.complete).toBe(true);
	expect(preview.history.rows).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				identityId: "identity-a",
				relation: "exact_subject",
				assignment: "included",
			}),
			expect.objectContaining({
				identityId: "identity-b",
				relation: "exact_subject",
				assignment: "included",
			}),
		]),
	);
	const confirmed = await app.send(`${BASE}/confirm`, "POST", {
		preview,
		approvalDigest: preview.approvalDigest,
	});
	expect(confirmed.status).toBe(200);
	expect(await confirmed.json()).toMatchObject({
		groups: GROUPS.map((groupId) => ({ groupId, status: "confirmed" })),
	});
	// Recovery itself changes only the retained owner evidence and display association.
	expect(f.stable()).toEqual(stable);
	expect(f.rows("identity_devices")).toEqual(assignments);
	expect(
		[
			"policy_teams",
			"policy_team_memberships",
			"policy_team_device_decisions",
			"project_recipients",
		].map((table) => f.rows(table)),
	).toEqual(authorization);
	expect(f.snapshot().filter(([name]) => name !== "coordinator_legacy_owner_resolutions")).toEqual(
		remote,
	);
	expect(completionPosts(f)).toHaveLength(0);
	const resolution = f.db
		.prepare(
			"SELECT owner_identity_id,reviewed_weak_labels_json FROM coordinator_legacy_owner_resolutions",
		)
		.get() as { owner_identity_id: string; reviewed_weak_labels_json: string };
	expect(resolution.owner_identity_id).toBe("identity-a");
	expect(JSON.parse(resolution.reviewed_weak_labels_json)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ label: "identity-b", kind: "consumed_project_actor_label" }),
		]),
	);
	return { stable, assignments, remote, preview };
}

async function detail(app: Viewer) {
	const response = await app.send(SETUP);
	expect(response.status).toBe(200);
	return (await response.json()) as LegacyTeamSetupDetailResponseV1;
}

async function choose(app: Viewer, targetName: string) {
	const summary = await app.send("/api/sync/team-setup/v1");
	expect(summary.status, JSON.stringify(await summary.json())).toBe(200);
	let view = await detail(app);
	const device = view.devices[0];
	const choice = view.identityChoices.find((choice) => choice.displayName === targetName);
	if (!device || !choice)
		throw new Error(`Maintained setup cannot select ${targetName}: ${JSON.stringify(view)}`);
	expect(device.decision).toBe("unresolved");
	expect(device.targetIdentityRef).toBeNull();
	const assignment = {
		attemptId: view.attemptId,
		expectation: device.expectation,
		targetIdentityRef: choice.identityRef,
	};
	const stale = await app.send(`${SETUP}/devices/${device.deviceRef}/assignment`, "PUT", {
		...assignment,
		expectation: { kind: "absent" },
	});
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "team_setup_assignment_changed" });
	const assigned = await app.send(
		`${SETUP}/devices/${device.deviceRef}/assignment`,
		"PUT",
		assignment,
	);
	expect(assigned.status).toBe(200);
	view = (await assigned.json()) as LegacyTeamSetupDetailResponseV1;
	expect(view.devices[0]?.targetIdentityRef).toBe(choice.identityRef);
	expect(view.devices[0]?.decision).toBe("unresolved");
	const included = await app.send(`${SETUP}/devices/${device.deviceRef}/decision`, "PUT", {
		attemptId: view.attemptId,
		decision: "included",
		expectedTargetIdentityRef: choice.identityRef,
	});
	expect(included.status).toBe(200);
	view = await detail(app);
	expect(view.state, JSON.stringify(view)).toBe("ready_to_finish");
	if (view.state !== "ready_to_finish") throw new Error("Maintained setup review unavailable");
	return view;
}

function consent(view: Awaited<ReturnType<typeof choose>>) {
	return {
		attemptId: view.attemptId,
		finishDigest: view.finishDigest,
		confirmedAccessDeltaDigest: view.accessDeltaDigest,
		confirmedViewerAccessDeltaDigest: view.viewerAccessDeltaDigest,
	};
}

it("joins explicit A recovery to ordinary reviewed setup and real HTTP completion, then restarts without changing prior permissions", async () => {
	// Arrange: B authored this nonempty profile; canonical linked A is already known.
	const f = await teamRecoveryFixture((fn) => cleanups.push(fn));
	const app = await f.viewer();
	expect(f.access(), JSON.stringify(f.access())).toMatchObject({
		status: "eligible",
		devices: [{ deviceId: f.deviceId, identityId: "identity-b" }],
	});
	const { stable, assignments } = await recover(f, app);
	const grants = f.rows("project_recipients");
	const history = f.db
		.prepare("SELECT * FROM coordinator_legacy_team_completions ORDER BY rowid")
		.all();
	const remoteBeforeSetup = f.snapshot();
	const review = await choose(app, "Known A");
	expect(review.projects).toEqual([]);
	expect(review.accessDelta.recipientChanges).toEqual([]);
	expect(review.accessDelta.deviceAccessChanges).toEqual([]);
	expect(f.rows("identity_devices")).toEqual(assignments);
	expect(f.stable()).toEqual(stable);
	expect(review.accessDelta.membershipChanges).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ identityDisplayName: "Known A", change: "add" }),
		]),
	);
	expect(completionPosts(f)).toHaveLength(0);
	const approved = consent(review);
	for (const missing of [
		"confirmedAccessDeltaDigest",
		"confirmedViewerAccessDeltaDigest",
	] as const) {
		const incomplete: Partial<typeof approved> = { ...approved };
		delete incomplete[missing];
		const denied = await app.send(`${SETUP}/finish`, "POST", incomplete);
		expect(denied.status).toBe(409);
		expect(await denied.json()).toEqual({ error: "team_setup_confirmation_stale" });
		expect(completionPosts(f)).toHaveLength(0);
		expect(f.rows("identity_devices")).toEqual(assignments);
		expect(f.snapshot()).toEqual(remoteBeforeSetup);
	}

	// Act: normal access review, not the owner projection, authorizes publication and assignment.
	const finished = await app.send(`${SETUP}/finish`, "POST", approved);
	const result = await finished.json();
	expect(
		finished.status,
		JSON.stringify({
			result,
			responses: f.responses.filter(
				(response) => response.method === "POST" && response.path.includes("legacy-team"),
			),
		}),
	).toBe(200);
	expect(completionPosts(f)).toHaveLength(1);
	const published = await completionPosts(f)[0]?.clone().json();
	expect(published).toMatchObject({
		group_id: FUTURE,
		manifest: {
			device_decisions: [
				{ device_id: f.deviceId, identity_id: "identity-a", decision: "included" },
			],
		},
	});
	expect(f.rows("legacy_team_setup_completions")).toEqual([
		expect.objectContaining({
			finish_digest: review.finishDigest,
			confirmed_access_delta_digest: review.accessDeltaDigest,
		}),
	]);
	const setupAssignments = f.rows("identity_devices");
	expect(setupAssignments).toEqual([
		expect.objectContaining({ identity_id: "identity-a", assignment_version: 2 }),
	]);
	expect(f.stable()).toEqual(stable);
	expect(f.rows("project_recipients")).toEqual(grants);
	expect(
		f.db
			.prepare("SELECT * FROM coordinator_legacy_team_completions WHERE group_id<>? ORDER BY rowid")
			.all(FUTURE),
	).toEqual(history);
	const replay = await app.send(`${SETUP}/finish`, "POST", approved);
	expect(replay.status).toBe(200);
	expect(completionPosts(f)).toHaveLength(1);
	const staleReplay = await app.send(`${SETUP}/finish`, "POST", {
		...approved,
		confirmedAccessDeltaDigest: `legacy-team-access-delta:${"0".repeat(64)}`,
	});
	expect(staleReplay.status).toBe(409);
	await app.close();
	f.restart();
	const restarted = await f.viewer();

	// Assert: restart retains separate A owner display and B operation context; no new account or actor merge.
	const status = await restarted.send("/api/account/link-status?group_id=group-a");
	expect(status.status).toBe(200);
	expect(await status.json()).toMatchObject({
		local: { identityId: "identity-b" },
		accountOwner: { identityId: "identity-a", memoryActorId: "identity-b" },
		remote: { kind: "not_checked" },
		canLink: false,
	});
	expect(f.readContext("group-a")).toMatchObject({ context: { identityId: "identity-b" } });
	expect((await detail(restarted)).state).toBe("completed");
	expect(f.rows("identity_devices")).toEqual(setupAssignments);
	expect(f.stable()).toEqual(stable);
	expect(f.link).not.toHaveBeenCalled();
});

it("does not let retained owner status select or confirm an ordinary setup assignment", async () => {
	// Arrange
	const f = await teamRecoveryFixture((fn) => cleanups.push(fn));
	const app = await f.viewer();
	const { stable, assignments, preview } = await recover(f, app);
	const remote = f.snapshot();
	const drafts = f.rows("legacy_team_setup_drafts");
	// Act: repeated account reads are display-only, including after a process restart.
	await app.close();
	f.restart();
	const restarted = await f.viewer();
	for (let index = 0; index < 2; index++) {
		const response = await restarted.send("/api/account/link-status?group_id=group-a");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ accountOwner: { identityId: "identity-a" } });
	}
	expect(f.rows("legacy_team_setup_drafts")).toEqual(drafts);
	expect(f.snapshot()).toEqual(remote);
	expect((await restarted.send("/api/sync/team-setup/v1")).status).toBe(200);
	const view = await detail(restarted);
	const device = view.devices[0];
	if (!device) throw new Error("Missing ordinary setup device");
	const a = view.identityChoices.find((choice) => choice.displayName === "Known A");
	if (!a) throw new Error("Missing pre-existing canonical A choice");
	const deniedInclude = await restarted.send(
		`${SETUP}/devices/${device.deviceRef}/decision`,
		"PUT",
		{ attemptId: view.attemptId, decision: "included", expectedTargetIdentityRef: a.identityRef },
	);
	const deniedFinish = await restarted.send(`${SETUP}/finish`, "POST", {
		attemptId: view.attemptId,
		finishDigest: preview.approvalDigest,
		confirmedAccessDeltaDigest: preview.approvalDigest,
		confirmedViewerAccessDeltaDigest: preview.approvalDigest,
	});
	// Assert: A remains an available choice, never an automatically selected or confirmed target.
	expect(view.state).toBe("reviewing");
	expect(device).toMatchObject({ decision: "unresolved", targetIdentityRef: null });
	expect(deniedInclude.status).toBe(409);
	expect(await deniedInclude.json()).toEqual({ error: "team_setup_assignment_changed" });
	expect(deniedFinish.status).toBe(400);
	expect((await detail(restarted)).devices[0]).toMatchObject({
		decision: "unresolved",
		targetIdentityRef: null,
	});
	expect(completionPosts(f)).toHaveLength(0);
	expect(f.rows("identity_devices")).toEqual(assignments);
	expect(f.stable()).toEqual(stable);
	expect(f.snapshot()).toEqual(remote);
	expect(f.link).not.toHaveBeenCalled();
});

it("denies a new B completion through ordinary setup even after separately reviewed B assignment and access consent", async () => {
	// Arrange: B is an existing actor, not a new identity invented to satisfy setup.
	const f = await teamRecoveryFixture((fn) => cleanups.push(fn));
	const app = await f.viewer();
	const { stable, assignments } = await recover(f, app);
	const remote = f.snapshot();
	const review = await choose(app, "Original B");
	// Act
	const response = await app.send(`${SETUP}/finish`, "POST", consent(review));
	const result = await response.json();
	// Assert: ordinary consent cannot override the retained canonical owner.
	expect(response.status, JSON.stringify(result)).toBe(409);
	expect(result).toEqual({ error: "team_setup_completion_conflict" });
	expect(completionPosts(f)).toHaveLength(1);
	expect(f.rows("identity_devices")).toEqual(assignments);
	expect(f.stable()).toEqual(stable);
	expect(f.snapshot()).toEqual(remote);
});
