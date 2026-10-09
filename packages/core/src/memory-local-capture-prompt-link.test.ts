import { expect, it } from "vitest";
import { exportMemories, importMemories } from "./export-import.js";
import { hasMatchingLocalCreation } from "./memory-creation-provenance.js";
import { useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";

const { fixture, remember, row, binding, enroll, ledger, factRows } = useLocalCaptureFixture();
const marker = `export-session:v1:${"a".repeat(64)}`;

function setup(bookkeeping = true) {
	const db = fixture.store.db;
	enroll();
	db.prepare("UPDATE sessions SET import_key = ? WHERE id = ?").run(marker, fixture.sessionId);
	// The real capture writer issues proof; export bookkeeping never issues it.
	const id = remember("Prompt restore capture", bookkeeping ? { source: "export" } : undefined);
	const key = String(row(id).import_key);
	const source = binding(id);
	expect(source?.evidence).toBe("local_creation");
	if (!source) throw new Error("Missing genuine capture source");
	const matches = () => hasMatchingLocalCreation(db, key, [source.sourceDeviceId]);
	expect(matches()).toBe(true);
	const payload = exportMemories({ dbPath: fixture.store.dbPath, allProjects: true });
	const session = payload.sessions[0];
	const memory = payload.memory_items[0];
	if (!session || !memory) throw new Error("Missing genuine capture export");
	session.export_session_key = marker;
	memory.user_prompt_import_key = "restore-prompt";
	payload.user_prompts = [
		{
			id: 91,
			session_id: fixture.sessionId,
			prompt_text: "Restored prompt",
			import_key: "restore-prompt",
		},
	];
	return {
		db,
		id,
		key,
		source,
		matches,
		payload,
		session,
		options: { dbPath: fixture.store.dbPath },
	};
}

it("prompt-link import invalidates current creation proof without rewriting its history", () => {
	// Arrange: authentic creation has a null link and matching export bookkeeping.
	const { id, key, source, matches, payload, options, db } = setup();
	const before = row(id);
	const facts = ledger();
	const snapshots = factRows("memory_local_creation_snapshots");
	// Act
	const result = importMemories(payload, options);
	// Assert: only the link changes; immutable evidence remains historical evidence.
	expect(result).toMatchObject({ memory_items: 0, user_prompts: 1 });
	const promptId = db
		.prepare("SELECT id FROM user_prompts WHERE import_key = 'restore-prompt'")
		.pluck()
		.get();
	expect(row(id)).toEqual({ ...before, user_prompt_id: promptId });
	expect(factRows("memory_foreign_revisions")).toMatchObject([
		{ entity_id: key, write_path: "import" },
	]);
	expect(matches()).toBe(false);
	expect(ledger()).toEqual(facts);
	expect(binding(id)).toEqual(source);
	expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
	// Restoring snapshot content cannot erase the permanent foreign-write fact.
	db.prepare("UPDATE memory_items SET user_prompt_id = NULL WHERE id = ?").run(id);
	expect(matches()).toBe(false);
});

it.each([
	"native",
	"unrelated session",
	"cross-session prompt",
	"missing prompt",
	"existing link",
	"redacted",
	"noncanonical",
])("%s duplicate does not taint genuine creation proof", (mode) => {
	// Arrange
	const { id, matches, payload, session, options, db } = setup(mode !== "native");
	if (mode === "unrelated session")
		session.export_session_key = `export-session:v1:${"b".repeat(64)}`;
	if (mode === "cross-session prompt") {
		db.prepare("INSERT INTO sessions(started_at, project) VALUES ('2026-01-01', 'other')").run();
		const other = db.prepare("SELECT MAX(id) FROM sessions").pluck().get();
		db.prepare(
			"INSERT INTO user_prompts(session_id, prompt_text, import_key, created_at, created_at_epoch) VALUES (?, 'Other', 'restore-prompt', '2026-01-01', 1767225600)",
		).run(other);
	}
	if (mode === "missing prompt") payload.user_prompts = [];
	if (mode === "existing link") {
		db.prepare(
			"INSERT INTO user_prompts(session_id, prompt_text, created_at, created_at_epoch) VALUES (?, 'Existing', '2026-01-01', 1767225600)",
		).run(fixture.sessionId);
		db.prepare("UPDATE memory_items SET user_prompt_id = ? WHERE id = ?").run(
			db.prepare("SELECT MAX(id) FROM user_prompts").pluck().get(),
			id,
		);
	}
	if (mode === "redacted") session.export_session_redacted = true;
	if (mode === "noncanonical") delete session.export_session_key;
	const content = row(id);
	const proof = matches();
	const facts = ledger();
	const snapshots = factRows("memory_local_creation_snapshots");
	// Act
	const result = importMemories(payload, options);
	// Assert
	expect(result.memory_items).toBe(0);
	expect(row(id)).toEqual(content);
	expect(factRows("memory_foreign_revisions")).toEqual([]);
	expect(matches()).toBe(proof);
	expect(ledger()).toEqual(facts);
	expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
});

it.each(["link", "later summary"])(
	"failed %s import rolls back prompt, link, marker and proof together",
	(stage) => {
		// Arrange: a later summary failure occurs after successful prompt reconciliation.
		const { id, matches, payload, options, db } = setup();
		payload.session_summaries = [
			{
				id: 92,
				session_id: fixture.sessionId,
				request: "Late summary",
				import_key: "restore-summary",
			},
		];
		const event = stage === "link" ? "UPDATE ON memory_items" : "INSERT ON session_summaries";
		db.exec(
			`CREATE TRIGGER fail_restore BEFORE ${event} BEGIN SELECT RAISE(ABORT, 'restore_failed'); END`,
		);
		const content = row(id);
		const facts = ledger();
		const snapshots = factRows("memory_local_creation_snapshots");
		const operations = factRows("replication_ops");
		const prompts = factRows("user_prompts");
		// Act
		expect(() => importMemories(payload, options)).toThrow("restore_failed");
		// Assert
		expect(row(id)).toEqual(content);
		expect(factRows("memory_foreign_revisions")).toEqual([]);
		expect(factRows("user_prompts")).toEqual(prompts);
		expect(factRows("session_summaries")).toEqual([]);
		expect(factRows("replication_ops")).toEqual(operations);
		expect(ledger()).toEqual(facts);
		expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
		expect(matches()).toBe(true);
		db.exec("DROP TRIGGER fail_restore");
		importMemories(payload, options);
		expect(row(id).user_prompt_id).not.toBeNull();
		expect(factRows("memory_foreign_revisions")).toHaveLength(1);
		expect(matches()).toBe(false);
	},
);
