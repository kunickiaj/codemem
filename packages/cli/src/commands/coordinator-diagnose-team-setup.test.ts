import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	deriveLegacyTeamSetupCompletionManifest,
	legacyTeamCandidateId,
	MemoryStore,
	refreshLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { legacyTeamProjectRef } from "../../../core/src/recipient-policy-identifiers.js";

const mocks = vi.hoisted(() => ({
	readCodememConfigFile: vi.fn(),
	listCompletions: vi.fn(),
	listDevices: vi.fn(),
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	readCodememConfigFile: mocks.readCodememConfigFile,
	coordinatorListLegacyTeamCompletionsAction: mocks.listCompletions,
	coordinatorListDevicesAction: mocks.listDevices,
}));

import { buildCoordinatorCommand } from "./coordinator.js";
import { buildCoordinatorDiagnoseTeamSetupCommand } from "./coordinator-diagnose-team-setup.js";

let dir: string;
const exitCode = process.exitCode;
const savedSyncEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	vi.clearAllMocks();
	// Environment overrides win over saved config; isolate them from the caller's shell.
	for (const key of Object.keys(process.env).filter((name) => name.startsWith("CODEMEM_SYNC_"))) {
		savedSyncEnv[key] = process.env[key];
		delete process.env[key];
	}
	dir = mkdtempSync(join(tmpdir(), "codemem-diagnose-team-setup-"));
	// Diagnosis requires an existing source and must never initialize one itself.
	new MemoryStore(join(dir, "mem.sqlite")).close();
	process.exitCode = exitCode;
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	mocks.readCodememConfigFile.mockReturnValue({
		sync_coordinator_url: "https://coordinator.example.test",
		sync_coordinator_admin_secret: "fixture-admin-secret",
		sync_coordinator_groups: ["group-a"],
	});
	mocks.listCompletions.mockResolvedValue([]);
	mocks.listDevices.mockResolvedValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
	Object.assign(process.env, savedSyncEnv);
	rmSync(dir, { recursive: true, force: true });
	process.exitCode = exitCode;
});

function run(args: string[]) {
	return buildCoordinatorDiagnoseTeamSetupCommand().parseAsync(
		[...args, "--db-path", join(dir, "mem.sqlite"), "--json"],
		{ from: "user" },
	);
}

function jsonOutput(): unknown {
	const [line] = vi.mocked(console.log).mock.calls.at(-1) ?? [];
	return JSON.parse(String(line));
}

function completionRecord(coordinatorId: string, options: { withProject?: boolean } = {}) {
	const store = new MemoryStore(":memory:");
	const now = "2026-10-01T00:00:00.000Z";
	const candidateRef = legacyTeamCandidateId(coordinatorId, "group-a");
	try {
		store.db
			.prepare(
				`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
				 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
			)
			.run(now, now);
		if (options.withProject) {
			store.db
				.prepare(
					`INSERT INTO replication_scopes(
					 scope_id, label, kind, authority_type, coordinator_id, group_id,
					 membership_epoch, status, created_at, updated_at
					 ) VALUES ('scope-a', 'Engineering', 'team', 'coordinator', ?, 'group-a', 1, 'active', ?, ?)`,
				)
				.run(coordinatorId, now, now);
		}
		let draft = refreshLegacyTeamSetupDraft(store.db, {
			candidateId: candidateRef,
			coordinatorId,
			groupId: "group-a",
			displayName: "Engineering",
			devices: [
				{ deviceId: "device-a", fingerprint: "a".repeat(64), displayName: "Laptop", enabled: true },
			],
			projects: options.withProject
				? [
						{
							projectRef: legacyTeamProjectRef(candidateRef, "https://example.test/team/repo.git"),
							sourceProjectIdentity: "https://example.test/team/repo.git",
							displayName: "Repository",
							sourceFingerprint: "source-scope-a",
							deterministicProjectIdentity: "https://example.test/team/repo.git",
							targetScopeId: "scope-a",
						},
					]
				: [],
			now,
		});
		const device = draft.devices[0];
		if (!device) throw new Error("missing test device");
		draft = setLegacyTeamSetupDeviceAssignment(store.db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: "identity-a",
			expectation: device.expectation,
			now,
		});
		setLegacyTeamSetupDeviceDecision(store.db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: "included",
			now,
		});
		const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
			candidateRef,
			attemptId: draft.attemptId,
			completedAt: now,
		});
		return {
			group_id: "group-a",
			candidate_ref: candidateRef,
			manifest_version: 1,
			completed_at: now,
			created_at: now,
			manifest_json: canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
			manifest,
		};
	} finally {
		store.close();
	}
}

it("is registered under the coordinator group", () => {
	// Arrange
	const command = buildCoordinatorCommand();

	// Act
	const names = command.commands.map((child) => child.name());

	// Assert
	expect(names).toContain("diagnose-team-setup");
});

it("reports configured groups that have no coordinator completion", async () => {
	// Arrange: the coordinator has no completion records by default.

	// Act
	await run([]);

	// Assert
	expect(mocks.listCompletions).toHaveBeenCalledWith(
		expect.objectContaining({ groupIds: ["group-a"], adminSecret: "fixture-admin-secret" }),
	);
	expect(jsonOutput()).toMatchObject({
		coordinator_id: "https://coordinator.example.test",
		groups: [
			{
				groupId: "group-a",
				manifest: { ok: false, code: "coordinator_completion_absent" },
				apply: null,
			},
		],
	});
});

it("diagnoses only the requested group", async () => {
	// Arrange: group-b overrides the configured group-a.

	// Act
	await run(["group-b"]);

	// Assert
	expect(mocks.listCompletions).toHaveBeenCalledWith(
		expect.objectContaining({ groupIds: ["group-b"] }),
	);
	expect(jsonOutput()).toMatchObject({ groups: [{ groupId: "group-b" }] });
});

it("diagnoses the current candidate when a historical completion for the group comes first", async () => {
	// Arrange: a prior coordinator address must not hide the current completion.
	const historical = completionRecord("https://previous-coordinator.example.test");
	const current = completionRecord("https://coordinator.example.test");
	mocks.listCompletions.mockResolvedValue([historical, current]);

	// Act
	await run([]);

	// Assert: use real manifest validation to distinguish the two candidates.
	expect(jsonOutput()).toMatchObject({
		groups: [
			{
				candidateRef: current.manifest.candidate_ref,
				completedAt: current.manifest.completed_at,
				manifest: { ok: true, projectMappings: 0 },
			},
		],
	});
});

it("reports no coordinator completion when the group has only a historical candidate", async () => {
	// Arrange: a completion for the old address is not a completion for this candidate.
	mocks.listCompletions.mockResolvedValue([
		completionRecord("https://previous-coordinator.example.test"),
	]);

	// Act
	await run([]);

	// Assert
	expect(jsonOutput()).toMatchObject({
		groups: [
			{
				candidateRef: legacyTeamCandidateId("https://coordinator.example.test", "group-a"),
				completedAt: null,
				manifest: { ok: false, code: "coordinator_completion_absent" },
				localCompletion: { ok: false, code: "coordinator_completion_absent" },
				apply: null,
			},
		],
	});
});

it("fails without coordinator admin configuration", async () => {
	// Arrange
	mocks.readCodememConfigFile.mockReturnValue({});

	// Act
	await run([]);

	// Assert
	expect(mocks.listCompletions).not.toHaveBeenCalled();
	expect(jsonOutput()).toEqual({
		error: "team_setup_diagnosis_failed",
		message: "team_setup_diagnosis_configuration_unavailable",
	});
	expect(process.exitCode).toBe(1);
});

it.each(["success", "coordinator failure"])(
	"leaves a source needing additive schema compatibility unchanged on %s",
	async (outcome) => {
		// Arrange: normal MemoryStore initialization would recreate this additive table.
		const path = join(dir, "mem.sqlite");
		const source = new DatabaseSync(path);
		source.exec("DROP TABLE memory_ownership_recoveries");
		source.close();
		const before = readFileSync(path);
		if (outcome === "coordinator failure") {
			mocks.listCompletions.mockRejectedValue(new Error("coordinator unavailable"));
		}

		// Act
		await run([]);

		// Assert: opening the source must not upgrade its schema, even before an API failure.
		expect(readFileSync(path).equals(before)).toBe(true);
		const inspection = new DatabaseSync(path, { readOnly: true });
		try {
			expect(
				inspection
					.prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_ownership_recoveries'")
					.all(),
			).toEqual([]);
		} finally {
			inspection.close();
		}
		if (outcome === "coordinator failure") {
			expect(jsonOutput()).toMatchObject({
				error: "team_setup_diagnosis_failed",
				message: "coordinator unavailable",
			});
			expect(process.exitCode).toBe(1);
			return;
		}
		expect(jsonOutput()).toMatchObject({ groups: [{ groupId: "group-a" }] });
	},
);

it.each(["active", "archived"])(
	"includes committed WAL-only %s scope state while the original store is open",
	async (status) => {
		// Arrange: keep the committed scope out of the main file to require a SQLite backup.
		const path = join(dir, "mem.sqlite");
		const source = new MemoryStore(path);
		try {
			const record = completionRecord("https://coordinator.example.test", { withProject: true });
			mocks.listCompletions.mockResolvedValue([record]);
			source.db.pragma("wal_autocheckpoint = 0");
			source.db.pragma("wal_checkpoint(TRUNCATE)");
			const mainBeforeCommit = readFileSync(path);
			source.db
				.prepare(
					`INSERT INTO replication_scopes(
					 scope_id, label, kind, authority_type, coordinator_id, group_id,
					 membership_epoch, status, created_at, updated_at
					 ) VALUES ('scope-a', 'Engineering', 'team', 'coordinator', ?, 'group-a', 1, ?, ?, ?)`,
				)
				.run(record.manifest.coordinator_id, status, record.completed_at, record.completed_at);
			const logicalBefore = source.db.serialize();

			// Act
			await run([]);

			// Assert: both active and unavailable scope decisions must use the committed WAL state.
			expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
			expect(readFileSync(path).equals(mainBeforeCommit)).toBe(true);
			expect(source.db.serialize().equals(logicalBefore)).toBe(true);
			expect(jsonOutput()).toMatchObject({
				groups: [
					{
						manifest: { ok: true, projectMappings: 1 },
						unavailableScopeIds: status === "active" ? [] : ["scope-a"],
					},
				],
			});
		} finally {
			source.close();
		}
	},
);

it("reports a missing source without creating the database or its parent directory", async () => {
	// Arrange
	const parent = join(dir, "missing-parent");
	const path = join(parent, "missing.sqlite");

	// Act
	await buildCoordinatorDiagnoseTeamSetupCommand().parseAsync(["--db-path", path, "--json"], {
		from: "user",
	});

	// Assert
	expect(jsonOutput()).toMatchObject({
		error: "team_setup_diagnosis_failed",
		message: expect.any(String),
	});
	expect(process.exitCode).toBe(1);
	expect(mocks.listCompletions).not.toHaveBeenCalled();
	expect(existsSync(path)).toBe(false);
	expect(existsSync(parent)).toBe(false);
});
