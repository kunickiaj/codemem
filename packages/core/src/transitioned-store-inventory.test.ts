/**
 * Which device store tables a transition moves to names no released client knows.
 *
 * Every table this codebase creates must be listed: moved because it holds or can
 * rebuild memory content (`transitionedNames`), reviewed below as device metadata,
 * or kept in another database. A table with a content-like column can only stay
 * under its released name with a reason for that column here.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { prepareOfflineScopeServingStore } from "./offline-serving-preparation.js";
import { MemoryStore } from "./store.js";

/** Device store tables that keep their released names, and why they hold no content. */
const reviewedMetadata: Record<string, string> = {
	actors: "Person names and merge links.",
	attribution_assessment_evidence: "Links between assessment and evidence IDs.",
	attribution_assessments: "Retrieval impact labels and methods.",
	coordinator_enrollment_reconciliation_issues: "Enrollment issue codes and counts.",
	coordinator_group_preferences: "Project include/exclude filters per group.",
	device_identity_binding_audit: "Device-to-identity decisions.",
	device_identity_binding_commits: "Reviewed device binding requests and outcomes.",
	identity_devices: "Device display names and assignments.",
	legacy_team_setup_completions: "Team setup receipts with access deltas.",
	legacy_team_setup_draft_devices: "Device choices for a Team setup draft.",
	legacy_team_setup_draft_projects: "Project names and scope choices for a draft.",
	legacy_team_setup_drafts: "Team setup draft state.",
	local_identity_generation: "Current local actor.",
	local_identity_switches: "Identity switch attempts and receipts.",
	maintenance_jobs: "Job titles, progress and errors from maintenance runs.",
	memory_foreign_revisions: "Which write path created a received memory.",
	memory_local_capture: "Capture ID of this store.",
	memory_local_capture_adoption: "Device key that adopted the capture ID.",
	memory_ownership_recoveries: "Reviewed ownership recovery requests: IDs and digests.",
	memory_retirement_deliveries: "Retirement control delivery receipts.",
	memory_retirement_peer_trust: "Peer keys for retirement controls.",
	memory_retirement_receipts: "Received retirement control IDs.",
	memory_retirement_reset_manifests: "Retirement control IDs per reset.",
	memory_retirement_reset_receivers: "Reset paging progress.",
	memory_scope_retirements: "Memory IDs retired from a scope.",
	memory_source_bindings: "Memory entity IDs and their source device.",
	opencode_sessions: "Raw stream to session ID mapping.",
	outcome_evidence: "Measured outcome values and references.",
	peer_project_filter_management: "Migration marker.",
	peer_project_filter_retention: "Retained per-peer Project filters.",
	pi_import_state: "Imported Pi session file sizes and times.",
	policy_team_coordinator_links: "Team to coordinator group links.",
	policy_team_device_decisions: "Team device decisions.",
	policy_team_member_removal_enforcements: "Applied member removals.",
	policy_team_member_removals: "Member removals from the coordinator.",
	policy_team_memberships: "Team memberships.",
	policy_team_recovery_exclusions: "Devices a Team recovery left out.",
	policy_team_recovery_holds: "Held Team recoveries.",
	policy_team_recovery_skipped_projects: "Project identities a recovery skipped.",
	policy_teams: "Team names and state.",
	project_boundary_migrations: "Per-Project migration state.",
	project_recipients: "Project recipients.",
	project_scope_mappings: "Workspace patterns to scope IDs.",
	project_scope_withdrawals: "Withdrawn Project scopes.",
	raw_event_ingest_samples: "Ingest counters.",
	raw_event_ingest_stats: "Ingest counters.",
	raw_event_sessions:
		"Stream positions with working directory and Project name. Replay needs raw_events, which moves.",
	recipient_managed_project_projections: "Accepted managed Projects.",
	recipient_policy_authority_states: "Recipient policy state and digests.",
	recipient_policy_deny_overlays: "Denied devices per scope.",
	recipient_policy_reconciliation_steps: "Reconciliation step progress.",
	recipient_policy_review_resolutions: "Recipient review decisions and previews of access changes.",
	replication_cursor_orphan_cleanup: "Migration marker.",
	replication_cursors: "Peer cursors.",
	replication_cursors_v2: "Peer cursors per scope.",
	replication_scopes: "Scope labels and authority.",
	repository_discovery_format: "Index format version.",
	repository_discovery_state: "Index revision counters.",
	repository_workspace_evidence: "Repository identities seen per working directory.",
	retired_device_aliases: "Retired device fingerprints.",
	retrieval_attempts:
		"Retrieval diagnostics. Queries are stored as a hash and length. Working-set file paths come from the editor, not from memories.",
	retrieval_exposures: "Memory IDs and ranks shown by a retrieval.",
	schema_compat_state: "Applied schema version.",
	scope_membership_authorization_evidence: "Signed membership evidence.",
	scope_membership_cache_state: "Refresh times and errors.",
	scope_membership_removal_state: "Removal generation.",
	scope_memberships: "Scope memberships and signed manifests.",
	scope_serving_preparations: "Prepared groups.",
	scope_serving_proofs_v2: "Signed serving proofs.",
	share_operation_projects: "Project names in a share operation.",
	share_operation_steps: "Share step progress.",
	share_operations: "Share operation state, names and keys.",
	sync_attempts: "Sync outcomes and errors.",
	sync_channel_progress: "Per-scope sync cursors.",
	sync_daemon_state: "Daemon errors and phase.",
	sync_nonces: "Replay nonces.",
	sync_peer_removal_check_state: "Peer removal generation.",
	sync_peer_signature_state: "Signature versions seen per peer.",
	sync_peers: "Peer names, keys, addresses and Project filters.",
	sync_relay_service_pins: "Relay service keys.",
	sync_reset_state: "Reset baseline cursors.",
	sync_reset_state_v2: "Reset baseline cursors per scope.",
	sync_retention_state: "Retention run counters.",
	sync_retention_state_v2: "Retention run counters per scope.",
	sync_scope_rejections: "Rejected op IDs and reasons.",
	sync_transfer_observations: "Transfer times and error codes.",
	sync_transfer_receipts: "Transfer receipt IDs.",
	usage_events: "Token counts and pack metrics.",
	validated_vector_models: "Embedding model counts.",
	validated_vector_rows: "Embedding row metadata: memory ID, model and content hash.",
	validated_vector_state: "Vector index state.",
	validated_vector_versions: "Embedding versions per memory.",
	vector_corpus_epoch: "Change counter.",
};

/**
 * Device store tables a transition moves, and what each holds: memory text and
 * its FTS index (with shadow tables), extracted concepts and file references,
 * creation snapshots, embeddings (sqlite-vec tables with shadow tables and the
 * compatibility view), artifacts, prompts, summaries, session metadata (the first
 * prompt), captured transcripts and their flush records, replication op payloads,
 * and the sync identity.
 */
const expectedMoved = [
	"sessions",
	"memory_items",
	"memory_fts",
	"memory_concept_refs",
	"memory_file_refs",
	"memory_local_creation_snapshots",
	"memory_vectors",
	"memory_vectors_v1",
	"artifacts",
	"user_prompts",
	"session_summaries",
	"raw_events",
	"raw_event_flush_batches",
	"replication_ops",
	"sync_device",
];

/** Content-like columns that stay under a released name, with the reason. */
const reviewedColumns: Record<string, string> = {
	"maintenance_jobs.message": "Progress text that maintenance code writes.",
	"maintenance_jobs.metadata_json": "Job parameters and counts.",
	"maintenance_jobs.title": "Job names that maintenance code writes.",
	"pi_import_state.file_path": "Paths of imported Pi session files. Their text becomes memories.",
	"retrieval_attempts.working_set_files_json": "Editor working-set paths, not memory text.",
	"usage_events.metadata_json": "Token counts and pack item counts.",
};

const contentColumn =
	/^(?:body|body_text|text|title|subtitle|narrative|facts|concepts?|payload(?:_json)?|content(?:_text|_json)?|prompt(?:_text)?|first_prompt|request|investigated|learned|completed|next_steps|notes|summary|transcript|embedding|message|snippet|query|tags_text|files_read|files_modified|files_edited|file_path|working_set_files_json|metadata_json)$/;

// Tables created only by these files live in coordinator, relay or in-memory
// databases, never in a device store.
const otherDatabaseFile =
	/^(?:better-sqlite-coordinator-store|coordinator-(?!group-preferences)[\w-]*|relay-[\w-]+|admission-budget[\w-]*|peer-traversal-coordinator[\w-]*|owner-enrollment-link-authority|vector-metadata-snapshot)\.ts$/;

const packagesRoot = join(import.meta.dirname, "..", "..");
const sourceRoots = ["core", "cli", "viewer-server", "mcp-server"].map((name) =>
	join(packagesRoot, name, "src"),
);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		if (!/\.(?:ts|js|mjs)$/.test(entry)) return [];
		if (/\.test\.|test-|-test|fixture|harness|\.d\.ts$/.test(entry)) return [];
		return [path];
	});
}

/** Columns of the parenthesized body that starts at `open`. */
function bodyColumns(text: string, open: number): string[] {
	let depth = 0;
	let part = "";
	const parts: string[] = [];
	for (const char of text.slice(open)) {
		if (char === "(") depth += 1;
		if (char === ")") depth -= 1;
		if (depth === 0) break;
		if (depth === 1 && char === ",") {
			parts.push(part);
			part = "";
		} else if (depth >= 1 && !(depth === 1 && char === "(")) part += char;
	}
	parts.push(part);
	return parts
		.map((column) => /^\s*[`"[]?(\w+)/.exec(column)?.[1]?.toLowerCase())
		.filter(
			(name): name is string =>
				!!name && !/^(?:primary|foreign|unique|check|constraint)$/.test(name),
		);
}

interface Declared {
	files: Set<string>;
	columns: Set<string>;
}

function declaredTables(): Map<string, Declared> {
	const tables = new Map<string, Declared>();
	const declare = (name: string, file: string, columns: string[]) => {
		const entry = tables.get(name) ?? { files: new Set(), columns: new Set() };
		entry.files.add(file);
		for (const column of columns) entry.columns.add(column);
		tables.set(name, entry);
	};
	for (const path of sourceRoots.flatMap(sourceFiles)) {
		const text = readFileSync(path, "utf8");
		const file = relative(packagesRoot, path).split("/").at(-1) ?? path;
		for (const match of text.matchAll(
			/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?\s*(\(|USING\s+\w+\s*\()/gi,
		)) {
			const name = match[1]?.toLowerCase() ?? "";
			const open = (match.index ?? 0) + match[0].length - 1;
			declare(name, file, bodyColumns(text, open));
		}
		const drizzle = [...text.matchAll(/sqliteTable\(\s*"(\w+)"/g)];
		drizzle.forEach((match, index) => {
			const end = drizzle[index + 1]?.index ?? text.length;
			const columns = [
				...text
					.slice(match.index, end)
					.matchAll(/\b(?:text|integer|real|blob|numeric)\(\s*"(\w+)"/g),
			].map((column) => column[1] ?? "");
			declare(match[1] ?? "", file, columns);
		});
		for (const match of text.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi))
			declare(match[1]?.toLowerCase() ?? "", file, [match[2]?.toLowerCase() ?? ""]);
		for (const match of text.matchAll(/addColumnIfMissing\(\s*\w+,\s*"(\w+)",\s*"(\w+)"/g))
			declare(match[1] ?? "", file, [match[2] ?? ""]);
	}
	return tables;
}

function classify(declared: Map<string, Declared>, moved: Set<string>) {
	const unclassified: string[] = [];
	const unreviewedColumns: string[] = [];
	for (const [table, { files, columns }] of declared) {
		if ([...files].every((file) => otherDatabaseFile.test(file)) || moved.has(table)) continue;
		if (!Object.hasOwn(reviewedMetadata, table)) {
			unclassified.push(`${table} (${[...files].join(", ")})`);
			continue;
		}
		for (const column of columns)
			if (contentColumn.test(column) && !Object.hasOwn(reviewedColumns, `${table}.${column}`))
				unreviewedColumns.push(`${table}.${column}`);
	}
	return { unclassified, unreviewedColumns };
}

describe("transitioned store inventory", () => {
	it("classifies every device store table this codebase creates", async () => {
		const { transitionedNames } = await import("./transitioned-store-names.js");
		const declared = declaredTables();
		// The scan must see the schema it classifies.
		expect(declared.get("raw_events")?.columns).toContain("payload_json");
		expect(declared.get("sessions")?.columns).toContain("metadata_json");
		const moved = new Set<string>([
			...Object.keys(transitionedNames),
			...Object.values(transitionedNames),
		]);
		const { unclassified, unreviewedColumns } = classify(declared, moved);
		expect(unclassified, "Add each table to transitionedNames or reviewedMetadata").toEqual([]);
		expect(unreviewedColumns, "Move these tables in a transition, or review the column").toEqual(
			[],
		);
	});

	it("moves exactly the tables this inventory lists", async () => {
		const { transitionedNames, renamedOptionalTables, renamedRequiredTables } = await import(
			"./transitioned-store-names.js"
		);
		const tables = [
			...renamedRequiredTables,
			...renamedOptionalTables,
			"memory_fts",
			"memory_vectors",
			"memory_vectors_v1",
		];
		expect([...tables].sort()).toEqual([...expectedMoved].sort());
		for (const table of expectedMoved)
			expect(Object.hasOwn(transitionedNames, table), table).toBe(true);
	});
});

describe("a transitioned store", () => {
	const canary = "c4n4ry-transcript-0fa1";
	let home: string;
	let path: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "store-inventory-"));
		path = join(home, "device.sqlite");
		new MemoryStore(path).close();
		const db = connect(path);
		try {
			const session = Number(
				db
					.prepare(
						"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (datetime('now'), '/w', 'p', ?)",
					)
					.run(JSON.stringify({ session_context: { firstPrompt: canary } })).lastInsertRowid,
			);
			const memory = Number(
				db
					.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, narrative, created_at, updated_at, import_key)
					VALUES (?, 'discovery', ?, ?, ?, datetime('now'), datetime('now'), 'entity-1')`)
					.run(session, canary, canary, canary).lastInsertRowid,
			);
			db.prepare("INSERT INTO memory_concept_refs(memory_id, concept) VALUES (?, ?)").run(
				memory,
				canary,
			);
			db.prepare(
				"INSERT INTO memory_file_refs(memory_id, file_path, relation) VALUES (?, ?, 'read')",
			).run(memory, canary);
			db.prepare(
				"INSERT INTO artifacts(session_id, kind, content_text, created_at) VALUES (?, 'note', ?, datetime('now'))",
			).run(session, canary);
			db.prepare(
				"INSERT INTO user_prompts(session_id, prompt_text, created_at, created_at_epoch) VALUES (?, ?, datetime('now'), 0)",
			).run(session, canary);
			db.prepare(
				"INSERT INTO session_summaries(session_id, learned, created_at, created_at_epoch) VALUES (?, ?, datetime('now'), 0)",
			).run(session, canary);
			db.prepare(`INSERT INTO raw_events(opencode_session_id, event_seq, event_type, payload_json, created_at)
				VALUES ('stream', 1, 'user_prompt', ?, datetime('now'))`).run(
				JSON.stringify({ text: canary }),
			);
			db.prepare(`INSERT INTO raw_event_flush_batches(opencode_session_id, start_event_seq, end_event_seq,
				extractor_version, status, error_message, created_at, updated_at)
				VALUES ('stream', 1, 1, 'v', 'failed', ?, datetime('now'), datetime('now'))`).run(canary);
			db.prepare(`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev,
				clock_updated_at, clock_device_id, device_id, created_at)
				VALUES ('op-1', 'memory_item', 'entity-1', 'upsert', ?, 1, 'now', 'd', 'd', 'now')`).run(
				JSON.stringify({ body_text: canary }),
			);
			db.exec(`CREATE TABLE IF NOT EXISTS memory_source_bindings(entity_id TEXT PRIMARY KEY, source_device_id TEXT, evidence TEXT, created_at TEXT);
				INSERT OR IGNORE INTO memory_source_bindings VALUES ('entity-1', 'd', 'local_creation', 'now');
				CREATE TABLE IF NOT EXISTS memory_local_creation_snapshots (
					entity_id TEXT PRIMARY KEY NOT NULL REFERENCES memory_source_bindings(entity_id),
					scope_id TEXT, content_json TEXT NOT NULL, source_public_key TEXT,
					source_fingerprint TEXT, created_at TEXT NOT NULL)`);
			db.prepare(
				"INSERT INTO memory_local_creation_snapshots(entity_id, content_json, created_at) VALUES ('entity-1', ?, 'now')",
			).run(JSON.stringify({ body_text: canary }));
			db.prepare(
				"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('d', 'k', 'f', 'now')",
			).run();
		} finally {
			db.close();
		}
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it("leaves no content under a released name and no released name for a moved object", () => {
		const tables = () => {
			const raw = new Database(path, { readonly: true });
			try {
				return raw.prepare("SELECT type, name, tbl_name FROM sqlite_schema").all() as {
					type: string;
					name: string;
					tbl_name: string;
				}[];
			} finally {
				raw.close();
			}
		};
		const before = new Set(tables().map(({ name }) => name));
		prepareOfflineScopeServingStore(
			path,
			{
				coordinatorId: "fixture",
				groupId: "team",
				generation: "ddc460b1-6dd8-4489-ab5c-799c2319af62",
			},
			[],
		);
		const objects = tables();
		const releasedNames = objects.filter(
			({ type, name, tbl_name }) =>
				expectedMoved.includes(name) ||
				expectedMoved.includes(tbl_name) ||
				(type === "table" && expectedMoved.some((old) => name.startsWith(`${old}_`))),
		);
		expect(releasedNames).toEqual([]);
		// Tables the transition created hold the moved content under new names.
		// SQLite planner statistics sample index keys. No released path reads them.
		const unmoved = objects
			.filter(({ type, name }) => type === "table" && before.has(name))
			.map(({ name }) => name)
			.filter((name) => !/^sqlite_stat/.test(name));
		const raw = new Database(path, { readonly: true });
		try {
			const leaks = unmoved.filter((name) =>
				JSON.stringify(raw.prepare(`SELECT * FROM "${name}"`).raw().all(), (_key, value) =>
					Buffer.isBuffer(value) ? value.toString("latin1") : value,
				).includes(canary),
			);
			expect(leaks).toEqual([]);
		} finally {
			raw.close();
		}
		const unclassified = unmoved.filter(
			(name) => !/^sqlite_/.test(name) && !Object.hasOwn(reviewedMetadata, name),
		);
		expect(unclassified).toEqual([]);
	});
});
