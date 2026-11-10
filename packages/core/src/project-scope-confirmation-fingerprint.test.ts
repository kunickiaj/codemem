import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	analyzeProjectScopeMappingChangeGuardrails,
	analyzeProjectScopeMappingDeletionGuardrails,
	deleteProjectScopeSettingsMapping,
	listProjectScopeSettingsMappings,
	upsertProjectScopeSettingsMapping,
} from "./project-scope-settings.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";
import { initTestSchema } from "./test-utils.js";

const DEVICE = "source-device";
const REMOTE = "git@git.example.invalid:example/fixture.git";
const NOW = "2026-05-06T00:00:00Z";

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

let db: InstanceType<typeof Database>;
let mappingId: number;

function addSession(cwd: string | null, metadata: string | null = null): number {
	return Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, metadata_json)
				 VALUES (?, ?, 'fixture', ?, ?)`,
			)
			.run(NOW, cwd, REMOTE, metadata).lastInsertRowid,
	);
}

function addMemory(sessionId: number, id: number): void {
	db.prepare(
		`INSERT INTO memory_items(id, session_id, kind, title, body_text, created_at,
			 updated_at, scope_id, origin_device_id, active, workspace_id)
			 VALUES (?, ?, 'discovery', 'Fixture', 'Body', ?, ?, 'fixture-space', ?, 1, NULL)`,
	).run(id, sessionId, NOW, NOW, DEVICE);
}

function deletionWarning() {
	const warning = analyzeProjectScopeMappingDeletionGuardrails(db, mappingId, DEVICE)[0];
	if (!warning?.confirmation_token) throw new Error("expected scope reassignment confirmation");
	return { ...warning, confirmation_token: warning.confirmation_token };
}

// Independent legacy oracle: keep the original whole-value encoding on small fixtures only.
function legacyFingerprint(): string {
	const mappings = listProjectScopeSettingsMappings(db)
		.map((row) => [row.id, row.workspace_identity, row.project_pattern, row.scope_id, row.priority])
		.toSorted((left, right) => Number(left[0]) - Number(right[0]));
	const rows = db
		.prepare(
			`SELECT mi.id, mi.scope_id, s.cwd, s.git_remote, s.metadata_json, mi.workspace_id
			 FROM memory_items mi JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.active = 1
			 AND (mi.origin_device_id IS NULL OR TRIM(mi.origin_device_id) = '' OR mi.origin_device_id = ?)
			 AND (s.cwd IS NULL OR substr(s.cwd, 1, length(?)) <> ?)`,
		)
		.raw()
		.all(DEVICE, "__sync_bootstrap__", "__sync_bootstrap__") as unknown[][];
	rows.sort((left, right) => Number(left[0]) - Number(right[0]));
	return sha256([sha256(mappings), rows]);
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	db.prepare(
		`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
			 membership_epoch, status, created_at, updated_at)
			 VALUES ('fixture-space', 'Fixture Space', 'team', 'coordinator', 1, 'active', ?, ?)`,
	).run(NOW, NOW);
	mappingId = upsertProjectScopeSettingsMapping(db, {
		workspace_identity: REMOTE,
		project_pattern: "fixture",
		scope_id: "fixture-space",
	}).id;
});

afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

describe("project scope confirmation fingerprint", () => {
	it("preserves legacy JSON bytes for numeric ID order, nulls, Unicode and escaped strings", () => {
		// Arrange: insert IDs out of order, including the lexical 2/10 ordering trap.
		addMemory(
			addSession('/workspace/雪/"quoted"\\path\n', JSON.stringify({ text: "🧠\t\u0000\ud800" })),
			10,
		);
		addMemory(addSession(null), 2);
		addMemory(addSession("/workspace/fixture", "{}"), 1);
		db.prepare("UPDATE memory_items SET scope_id = NULL, workspace_id = ? WHERE id = 2").run(
			"雪🧠",
		);
		db.prepare("UPDATE sessions SET git_remote = NULL WHERE cwd IS NULL").run();
		const expected = legacyFingerprint();

		// Act.
		const warning = deletionWarning();

		// Assert: existing confirmation challenges retain their exact fingerprint.
		expect(warning.conflict_state).toBe(expected);
	});

	it("handles many moderate unrelated rows without aggregate JSON serialization", () => {
		// Arrange: a small selected SSH project and repeated metadata elsewhere in the corpus.
		for (let session = 0; session < 5; session++) {
			const sessionId = addSession(`/workspace/fixture-${session}`);
			for (let memory = 1; memory <= 3; memory++) addMemory(sessionId, session * 3 + memory);
		}
		const unrelated = addSession(
			"/workspace/unrelated",
			JSON.stringify({ padding: "x".repeat(8192) }),
		);
		db.prepare(
			"UPDATE sessions SET project = 'unrelated', git_remote = 'git@git.example.invalid:example/unrelated.git' WHERE id = ?",
		).run(unrelated);
		for (let id = 100; id < 228; id++) addMemory(unrelated, id);
		const expected = legacyFingerprint();
		const stringify = JSON.stringify;
		const spy = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
			const result = stringify(value);
			if (result && result.length > 32768)
				throw new RangeError("aggregate JSON exceeds test budget");
			return result;
		});

		// Act.
		const warning = deletionWarning();

		// Assert: exercise the size failure deterministically without a giant CI allocation.
		expect(warning.conflict_state).toBe(expected);
		expect(spy).toHaveBeenCalled();
	});

	it.each([
		["session metadata", "UPDATE sessions SET metadata_json = '{\"changed\":true}'"],
		["cwd", "UPDATE sessions SET cwd = '/workspace/moved'"],
		[
			"remote",
			"UPDATE sessions SET git_remote = 'git@git.example.invalid:example/other.git' WHERE id = 2",
		],
		["workspace", "UPDATE memory_items SET workspace_id = 'workspace:changed'"],
		["scope", "UPDATE memory_items SET scope_id = 'local:changed' WHERE id = 2"],
		["active membership", "UPDATE memory_items SET active = 0 WHERE id = 2"],
		["origin ownership", "UPDATE memory_items SET origin_device_id = 'peer-device' WHERE id = 2"],
		["mapping", "UPDATE project_scope_mappings SET priority = priority + 1"],
	])("invalidates confirmation after a change to %s", (_name, sql) => {
		// Arrange: retain a matching row so both states produce a deletion challenge.
		addMemory(addSession("/workspace/fixture"), 1);
		addMemory(addSession("/workspace/fixture-copy"), 2);
		const before = deletionWarning();

		// Act.
		db.prepare(sql).run();
		const after = deletionWarning();

		// Assert.
		expect(after.confirmation_token).not.toBe(before.confirmation_token);
		expect(after.conflict_state).toBe(legacyFingerprint());
	});

	it("retains origin, active and bootstrap filters without excluding unrelated eligible rows", () => {
		// Arrange.
		addMemory(addSession("/workspace/fixture"), 1);
		addMemory(addSession("/workspace/inactive"), 2);
		addMemory(addSession("/workspace/peer"), 3);
		addMemory(addSession("__sync_bootstrap__suffix"), 4);
		db.prepare("UPDATE memory_items SET active = 0 WHERE id = 2").run();
		db.prepare("UPDATE memory_items SET origin_device_id = 'peer-device' WHERE id = 3").run();
		const before = deletionWarning();

		// Act: excluded rows cannot invalidate the token.
		db.prepare("UPDATE sessions SET metadata_json = '{}' WHERE id <> 1").run();
		const excludedChange = deletionWarning();
		addMemory(addSession(null), 5);
		db.prepare("UPDATE memory_items SET origin_device_id = '   ' WHERE id = 5").run();
		const includedChange = deletionWarning();

		// Assert.
		expect(excludedChange.confirmation_token).toBe(before.confirmation_token);
		expect(includedChange.confirmation_token).not.toBe(before.confirmation_token);
		expect(includedChange.conflict_state).toBe(legacyFingerprint());
	});

	it("releases the read cursor after serialization fails and allows a fresh preview", () => {
		// Arrange.
		addMemory(addSession("/workspace/fixture"), 1);
		const stringify = JSON.stringify;
		vi.spyOn(JSON, "stringify").mockImplementation((value) => {
			if (
				Array.isArray(value) &&
				((value.length === 6 && value[0] === 1) ||
					(typeof value[0] === "string" && Array.isArray(value[1]) && Array.isArray(value[1][0])))
			) {
				throw new Error("serialization failed");
			}
			return stringify(value);
		});

		// Act.
		expect(() => deletionWarning()).toThrow("serialization failed");
		vi.restoreAllMocks();
		db.prepare("UPDATE sessions SET metadata_json = '{}'").run();
		const recovered = deletionWarning();

		// Assert.
		expect(recovered.conflict_state).toBe(legacyFingerprint());
	});

	it("previews an empty source-owned corpus without creating a confirmation challenge", () => {
		// Arrange.
		addMemory(addSession("/workspace/fixture"), 1);
		db.prepare("UPDATE memory_items SET origin_device_id = 'peer-device'").run();

		// Act.
		const analysis = analyzeProjectScopeMappingChangeGuardrails(db, {
			workspace_identity: "git@git.example.invalid:example/empty.git",
			project_pattern: "empty",
			deviceId: DEVICE,
			scope_id: "fixture-space",
		});

		// Assert.
		expect(analysis.warnings).toEqual([]);
	});
});

it("hashes one cursor snapshot and invalidates the next preview after a concurrent commit", async () => {
	// Arrange: a synthetic WAL database allows a second connection to commit during iteration.
	addMemory(addSession("/workspace/fixture"), 1);
	addMemory(addSession("/workspace/fixture-copy", "{}"), 2);
	const directory = mkdtempSync(join(tmpdir(), "codemem-fingerprint-test-"));
	const file = join(directory, "fixture.sqlite");
	await db.backup(file);
	db.close();
	db = new Database(file);
	db.pragma("journal_mode = WAL");
	const writer = new Database(file);
	const expected = legacyFingerprint();
	const stringify = JSON.stringify;
	let committed = false;
	vi.spyOn(JSON, "stringify").mockImplementation((value) => {
		if (!committed && Array.isArray(value) && value.length === 6 && value[0] === 1) {
			writer.prepare("UPDATE sessions SET metadata_json = '{\"new\":true}' WHERE id = 2").run();
			committed = true;
		}
		return stringify(value);
	});
	try {
		// Act.
		const current = deletionWarning();
		vi.restoreAllMocks();
		const next = deletionWarning();

		// Assert: a commit cannot mix old and new rows within the fingerprint.
		expect(committed).toBe(true);
		expect(current.conflict_state).toBe(expected);
		expect(next.conflict_state).toBe(legacyFingerprint());
		expect(next.confirmation_token).not.toBe(current.confirmation_token);
	} finally {
		writer.close();
		db.close();
		db = new Database(":memory:");
		rmSync(directory, { recursive: true, force: true });
	}
});

it("accepts an unchanged confirmation and moves only source-owned memories", () => {
	// Arrange.
	const sessionId = addSession("/workspace/fixture");
	addMemory(sessionId, 1);
	addMemory(sessionId, 2);
	db.prepare("UPDATE memory_items SET origin_device_id = 'peer-device' WHERE id = 2").run();
	const warning = deletionWarning();

	// Act.
	const deleted = deleteProjectScopeSettingsMapping(db, mappingId, {
		deviceId: DEVICE,
		confirmedGuardrailTokens: [warning.confirmation_token],
	});

	// Assert.
	expect(deleted).toBe(true);
	expect(db.prepare("SELECT scope_id FROM memory_items ORDER BY id").all()).toEqual([
		{ scope_id: LOCAL_DEFAULT_SCOPE_ID },
		{ scope_id: "fixture-space" },
	]);
});

it("rejects a stale confirmation without changing mappings or memories", () => {
	// Arrange.
	addMemory(addSession("/workspace/fixture", "{}"), 1);
	const warning = deletionWarning();
	db.prepare("UPDATE sessions SET metadata_json = '{\"changed\":true}'").run();

	// Act.
	const remove = () =>
		deleteProjectScopeSettingsMapping(db, mappingId, {
			deviceId: DEVICE,
			confirmedGuardrailTokens: [warning.confirmation_token],
		});

	// Assert.
	expect(remove).toThrow("guardrail_confirmation_required");
	expect(db.prepare("SELECT scope_id FROM project_scope_mappings").pluck().get()).toBe(
		"fixture-space",
	);
	expect(db.prepare("SELECT scope_id FROM memory_items").pluck().get()).toBe("fixture-space");
	expect(db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get()).toBe(0);
});

it("rolls back a confirmed change when memory propagation fails", () => {
	// Arrange.
	addMemory(addSession("/workspace/fixture"), 1);
	const warning = deletionWarning();
	db.exec(`CREATE TRIGGER fail_replication BEFORE INSERT ON replication_ops
	 BEGIN SELECT RAISE(ABORT, 'synthetic propagation failure'); END`);

	// Act.
	const remove = () =>
		deleteProjectScopeSettingsMapping(db, mappingId, {
			deviceId: DEVICE,
			confirmedGuardrailTokens: [warning.confirmation_token],
		});

	// Assert: mapping deletion and all earlier propagation writes are atomic.
	expect(remove).toThrow("synthetic propagation failure");
	expect(db.prepare("SELECT scope_id FROM project_scope_mappings").pluck().get()).toBe(
		"fixture-space",
	);
	expect(db.prepare("SELECT scope_id, rev FROM memory_items").get()).toEqual({
		scope_id: "fixture-space",
		rev: 0,
	});
	expect(db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get()).toBe(0);
});

it("previews a new SSH project Space assignment despite large unrelated metadata", () => {
	// Arrange: fifteen Local memories across five sessions, plus unrelated source-owned history.
	db.prepare("DELETE FROM project_scope_mappings").run();
	for (let session = 0; session < 5; session++) {
		const sessionId = addSession(`/workspace/fixture-${session}`);
		for (let memory = 1; memory <= 3; memory++) addMemory(sessionId, session * 3 + memory);
	}
	const unrelated = addSession(
		"/workspace/unrelated",
		JSON.stringify({ padding: "x".repeat(8192) }),
	);
	db.prepare(
		"UPDATE sessions SET project = 'unrelated', git_remote = 'git@git.example.invalid:example/unrelated.git' WHERE id = ?",
	).run(unrelated);
	for (let id = 100; id < 228; id++) addMemory(unrelated, id);
	db.prepare("UPDATE memory_items SET scope_id = ?").run(LOCAL_DEFAULT_SCOPE_ID);
	const stringify = JSON.stringify;
	vi.spyOn(JSON, "stringify").mockImplementation((value) => {
		const result = stringify(value);
		if (result && result.length > 32768) throw new RangeError("aggregate JSON exceeds test budget");
		return result;
	});

	// Act.
	const analysis = analyzeProjectScopeMappingChangeGuardrails(db, {
		deviceId: DEVICE,
		workspace_identity: REMOTE,
		project_pattern: "fixture",
		scope_id: "fixture-space",
	});

	// Assert: preview still requires confirmation and does not save anything.
	expect(analysis.warnings).toEqual([
		expect.objectContaining({
			code: "scope_reassignment_old_copies",
			previous_scope_id: LOCAL_DEFAULT_SCOPE_ID,
			scope_id: "fixture-space",
			requires_confirmation: true,
			confirmation_token: expect.stringMatching(/^psg_/),
		}),
	]);
	expect(db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get()).toBe(0);
	expect(
		db
			.prepare("SELECT COUNT(*) FROM memory_items WHERE scope_id <> ?")
			.pluck()
			.get(LOCAL_DEFAULT_SCOPE_ID),
	).toBe(0);
});
