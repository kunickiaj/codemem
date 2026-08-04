import type { Database } from "./db.js";
import {
	getSchemaVersion,
	isEmbeddingDisabled,
	loadSqliteVec,
	REQUIRED_BOOTSTRAPPED_TABLES,
	SCHEMA_VERSION,
} from "./db.js";
import { TEST_SCHEMA_BASE_DDL } from "./test-schema.generated.js";

const RETRIEVAL_EXPOSURE_DETACH_UNAVAILABLE_MEMORY_DDL = `
CREATE TRIGGER IF NOT EXISTS trg_retrieval_exposures_detach_unavailable_memory
AFTER INSERT ON retrieval_exposures
WHEN NEW.memory_id IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM memory_items
	WHERE memory_items.id = NEW.memory_id
	  AND memory_items.active != 0
	  AND memory_items.deleted_at IS NULL
	  AND (
		(
			NEW.memory_import_key IS NOT NULL
			AND TRIM(NEW.memory_import_key) != ''
			AND import_key IS NOT NULL
			AND TRIM(import_key) != ''
			AND NEW.memory_import_key = import_key
			AND (
				NEW.origin_device_id IS NULL
				OR TRIM(NEW.origin_device_id) = ''
				OR (
					origin_device_id IS NOT NULL
					AND TRIM(origin_device_id) != ''
					AND NEW.origin_device_id = origin_device_id
				)
			)
		)
		OR (
			(NEW.memory_import_key IS NULL OR TRIM(NEW.memory_import_key) = '')
			AND NEW.memory_rev = rev
			AND julianday(NEW.memory_updated_at) IS NOT NULL
			AND julianday(updated_at) IS NOT NULL
			AND julianday(NEW.memory_updated_at) = julianday(updated_at)
			AND NEW.memory_scope_id IS scope_id
			AND NEW.memory_kind = kind
			AND NEW.memory_active = active
			AND NEW.memory_deleted_at IS deleted_at
		)
	  )
)
BEGIN
	UPDATE retrieval_exposures SET memory_id = NULL WHERE exposure_id = NEW.exposure_id;
END;
`;

const RETRIEVAL_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS retrieval_attempts (
	attempt_id TEXT PRIMARY KEY NOT NULL,
	contract_version INTEGER NOT NULL,
	surface TEXT NOT NULL,
	trigger TEXT NOT NULL,
	started_at TEXT NOT NULL,
	completed_at TEXT,
	retrieval_status TEXT NOT NULL,
	delivery_status TEXT NOT NULL,
	candidate_count INTEGER NOT NULL,
	selected_count INTEGER NOT NULL,
	persisted_candidate_count INTEGER NOT NULL,
	recorder_version TEXT NOT NULL,
	session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
	source TEXT,
	stream_id TEXT,
	source_session_id TEXT,
	prompt_number INTEGER,
	request_id TEXT,
	raw_event_start_seq INTEGER,
	raw_event_end_seq INTEGER,
	experiment_id TEXT,
	experiment_cell_id TEXT,
	evaluation_checkout_id TEXT,
	evaluation_fixture_id TEXT,
	evaluation_seed INTEGER,
	latency_ms INTEGER,
	project TEXT,
	scope_id TEXT,
	mode TEXT,
	limit_requested INTEGER,
	token_budget INTEGER,
	output_tokens INTEGER,
	working_set_file_count INTEGER,
	working_set_files_json TEXT,
	query_hash_sha256 TEXT,
	query_char_count INTEGER,
	query_token_estimate INTEGER,
	filter_summary_json TEXT,
	failure_code TEXT,
	failure_stage TEXT,
	trace_version INTEGER,
	retention_until TEXT,
	retention_pinned INTEGER NOT NULL DEFAULT 0,
	retention_finalized_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_session_started
	ON retrieval_attempts(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_source_stream_started
	ON retrieval_attempts(source, stream_id, started_at);
CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_retention
	ON retrieval_attempts(retention_pinned, retention_until);
CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_started
	ON retrieval_attempts(started_at, attempt_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_surface_started
	ON retrieval_attempts(surface, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_attempts_request_identity
	ON retrieval_attempts(source, surface, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_experiment_cell
	ON retrieval_attempts(experiment_id, experiment_cell_id);

CREATE TABLE IF NOT EXISTS retrieval_exposures (
	exposure_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	attempt_id TEXT NOT NULL REFERENCES retrieval_attempts(attempt_id) ON DELETE CASCADE,
	memory_id INTEGER REFERENCES memory_items(id) ON DELETE SET NULL,
	memory_import_key TEXT,
	origin_device_id TEXT,
	rank INTEGER NOT NULL,
	disposition TEXT NOT NULL,
	section TEXT,
	handoff_status TEXT NOT NULL,
	memory_rev INTEGER,
	memory_updated_at TEXT,
	memory_scope_id TEXT,
	memory_kind TEXT,
	memory_active INTEGER,
	memory_deleted_at TEXT,
	score_summary_json TEXT,
	reason_codes_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_exposures_attempt_rank
	ON retrieval_exposures(attempt_id, rank);
CREATE INDEX IF NOT EXISTS idx_retrieval_exposures_memory
	ON retrieval_exposures(memory_id);

CREATE TABLE IF NOT EXISTS outcome_evidence (
	evidence_id TEXT PRIMARY KEY NOT NULL,
	contract_version INTEGER NOT NULL,
	dimension TEXT NOT NULL,
	evidence_type TEXT NOT NULL,
	source_class TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	producer TEXT NOT NULL,
	producer_version TEXT NOT NULL,
	status TEXT NOT NULL,
	value_type TEXT,
	value_integer INTEGER,
	value_real REAL,
	value_unit TEXT,
	session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
	source TEXT,
	stream_id TEXT,
	source_session_id TEXT,
	prompt_number INTEGER,
	raw_event_start_seq INTEGER,
	raw_event_end_seq INTEGER,
	experiment_id TEXT,
	experiment_cell_id TEXT,
	window_start_at TEXT,
	window_end_at TEXT,
	references_json TEXT,
	retention_until TEXT,
	retention_pinned INTEGER NOT NULL DEFAULT 0,
	retention_finalized_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outcome_evidence_observed_id
	ON outcome_evidence(observed_at, evidence_id);
CREATE INDEX IF NOT EXISTS idx_outcome_evidence_session_observed
	ON outcome_evidence(session_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_outcome_evidence_source_stream_observed
	ON outcome_evidence(source, stream_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_outcome_evidence_type_observed
	ON outcome_evidence(evidence_type, observed_at);
CREATE INDEX IF NOT EXISTS idx_outcome_evidence_retention
	ON outcome_evidence(retention_pinned, retention_until);

CREATE TABLE IF NOT EXISTS attribution_assessments (
	assessment_id TEXT PRIMARY KEY NOT NULL,
	contract_version INTEGER NOT NULL,
	subject_type TEXT NOT NULL,
	attempt_id TEXT NOT NULL REFERENCES retrieval_attempts(attempt_id) ON DELETE CASCADE,
	exposure_id INTEGER REFERENCES retrieval_exposures(exposure_id) ON DELETE CASCADE,
	dimension TEXT NOT NULL,
	impact_label TEXT NOT NULL,
	basis TEXT NOT NULL,
	confidence_level TEXT NOT NULL,
	method TEXT NOT NULL,
	method_version TEXT NOT NULL,
	created_at TEXT NOT NULL,
	claim_type TEXT NOT NULL DEFAULT 'observational'
);

CREATE INDEX IF NOT EXISTS idx_attribution_assessments_attempt_created
	ON attribution_assessments(attempt_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attribution_assessments_label_created
	ON attribution_assessments(impact_label, created_at);
CREATE INDEX IF NOT EXISTS idx_attribution_assessments_exposure
	ON attribution_assessments(exposure_id);

CREATE TABLE IF NOT EXISTS attribution_assessment_evidence (
	assessment_id TEXT NOT NULL REFERENCES attribution_assessments(assessment_id) ON DELETE CASCADE,
	evidence_id TEXT NOT NULL REFERENCES outcome_evidence(evidence_id) ON DELETE CASCADE,
	PRIMARY KEY (assessment_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_attribution_assessment_evidence_evidence
	ON attribution_assessment_evidence(evidence_id, assessment_id);

-- Intentionally handwritten: Drizzle models tables/indexes but not SQLite triggers.
-- This keeps soft deletion aligned with the FK's physical-delete SET NULL behavior.
CREATE TRIGGER IF NOT EXISTS trg_retrieval_exposures_detach_deleted_memory
AFTER UPDATE OF active, deleted_at ON memory_items
WHEN NEW.active = 0 OR NEW.deleted_at IS NOT NULL
BEGIN
	UPDATE retrieval_exposures SET memory_id = NULL WHERE memory_id = NEW.id;
END;

-- Foreign keys are checked when the INSERT statement finishes, after AFTER
-- triggers run, so unavailable or identity-mismatched references can be detached
-- without losing the immutable exposure snapshot.
-- Keyless/privacy-redacted linkage requires every memory snapshot field to match.
-- This narrows, but cannot eliminate, the risk of linking a reused numeric ID.
${RETRIEVAL_EXPOSURE_DETACH_UNAVAILABLE_MEMORY_DDL}

-- Defensive identity check for callers that disable foreign-key enforcement
-- while replacing memory rows. Normal writable connections keep foreign keys on,
-- so ON DELETE SET NULL detaches the link before an ID can be reused.
-- There is intentionally no keyless fallback here: replacement cannot prove
-- continuity with a previously linked memory.
CREATE TRIGGER IF NOT EXISTS trg_retrieval_exposures_detach_reused_memory_id
AFTER INSERT ON memory_items
WHEN EXISTS (SELECT 1 FROM retrieval_exposures WHERE memory_id = NEW.id)
BEGIN
	UPDATE retrieval_exposures
	SET memory_id = NULL
	WHERE memory_id = NEW.id
	  AND (
		COALESCE(NEW.active, 0) = 0
		OR NEW.deleted_at IS NOT NULL
		OR memory_import_key IS NULL
		OR TRIM(memory_import_key) = ''
		OR NEW.import_key IS NULL
		OR TRIM(NEW.import_key) = ''
		OR memory_import_key != NEW.import_key
		OR (
			origin_device_id IS NOT NULL
			AND TRIM(origin_device_id) != ''
			AND (
				NEW.origin_device_id IS NULL
				OR TRIM(NEW.origin_device_id) = ''
				OR origin_device_id != NEW.origin_device_id
			)
		)
	  );
END;
`;

const RETRIEVAL_LEDGER_SCHEMA_OBJECTS = [
	"retrieval_attempts",
	"retrieval_exposures",
	"outcome_evidence",
	"attribution_assessments",
	"attribution_assessment_evidence",
	"idx_retrieval_attempts_session_started",
	"idx_retrieval_attempts_source_stream_started",
	"idx_retrieval_attempts_retention",
	"idx_retrieval_attempts_started",
	"idx_retrieval_attempts_surface_started",
	"idx_retrieval_attempts_request_identity",
	"idx_retrieval_attempts_experiment_cell",
	"idx_retrieval_exposures_attempt_rank",
	"idx_retrieval_exposures_memory",
	"idx_outcome_evidence_observed_id",
	"idx_outcome_evidence_session_observed",
	"idx_outcome_evidence_source_stream_observed",
	"idx_outcome_evidence_type_observed",
	"idx_outcome_evidence_retention",
	"idx_attribution_assessments_attempt_created",
	"idx_attribution_assessments_label_created",
	"idx_attribution_assessments_exposure",
	"idx_attribution_assessment_evidence_evidence",
	"trg_retrieval_exposures_detach_deleted_memory",
	"trg_retrieval_exposures_detach_unavailable_memory",
	"trg_retrieval_exposures_detach_reused_memory_id",
] as const;

const SCHEMA_AUX_DDL = `
${RETRIEVAL_LEDGER_DDL}

CREATE INDEX IF NOT EXISTS idx_sync_peers_actor_id ON sync_peers(actor_id);

CREATE TABLE IF NOT EXISTS coordinator_enrollment_reconciliation_issues (
	coordinator_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	reference_id TEXT NOT NULL,
	code TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open',
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	resolved_at TEXT,
	occurrence_count INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (coordinator_id, group_id, kind, reference_id, code)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_enrollment_issues_boundary_status
	ON coordinator_enrollment_reconciliation_issues(coordinator_id, group_id, status);

CREATE INDEX IF NOT EXISTS idx_coordinator_enrollment_issues_status_recent
	ON coordinator_enrollment_reconciliation_issues(status, last_seen_at, resolved_at);

CREATE TABLE IF NOT EXISTS recipient_policy_review_resolutions (
	review_item_id TEXT NOT NULL,
	source_fingerprint TEXT NOT NULL,
	decision TEXT NOT NULL,
	decision_input_json TEXT NOT NULL,
	preview_json TEXT NOT NULL,
	decided_by_identity_id TEXT NOT NULL,
	decided_by_device_id TEXT NOT NULL,
	resolved_at TEXT NOT NULL,
	PRIMARY KEY (review_item_id, source_fingerprint)
);

CREATE TABLE IF NOT EXISTS recipient_policy_authority_states (
	canonical_project_identity TEXT PRIMARY KEY NOT NULL,
	authority_state TEXT NOT NULL DEFAULT 'legacy',
	generation INTEGER NOT NULL DEFAULT 0,
	desired_devices_digest TEXT,
	current_devices_digest TEXT,
	stable_parity_evidence_digest TEXT,
	stable_parity_passed_at TEXT,
	fresh_snapshot_fingerprint TEXT,
	fresh_snapshot_observed_at TEXT,
	safe_error_code TEXT,
	state_changed_at TEXT NOT NULL,
	last_error_at TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	last_attempt_at TEXT,
	last_completed_at TEXT,
	lease_owner TEXT,
	lease_acquired_at TEXT,
	lease_expires_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipient_policy_reconciliation_steps (
	canonical_project_identity TEXT NOT NULL,
	generation INTEGER NOT NULL,
	step_key TEXT NOT NULL,
	effect_id TEXT NOT NULL,
	payload_digest TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	attempt_count INTEGER NOT NULL DEFAULT 0,
	started_at TEXT,
	completed_at TEXT,
	last_attempt_at TEXT,
	safe_error_code TEXT,
	error_at TEXT,
	lease_owner TEXT,
	lease_acquired_at TEXT,
	lease_expires_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (canonical_project_identity, generation, step_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipient_policy_reconciliation_steps_effect
	ON recipient_policy_reconciliation_steps(effect_id);
CREATE INDEX IF NOT EXISTS idx_recipient_policy_reconciliation_steps_status
	ON recipient_policy_reconciliation_steps(canonical_project_identity, status);
CREATE INDEX IF NOT EXISTS idx_recipient_policy_reconciliation_steps_pending_refresh
	ON recipient_policy_reconciliation_steps(canonical_project_identity, generation, step_key)
	WHERE status IN ('pending', 'running', 'failed')
	AND step_key GLOB 'refresh-after-revocations-v2:*';
CREATE TABLE IF NOT EXISTS recipient_policy_deny_overlays (
	canonical_project_identity TEXT NOT NULL,
	scope_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	generation INTEGER NOT NULL,
	reason_code TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (canonical_project_identity, scope_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_recipient_policy_deny_overlays_scope_device
	ON recipient_policy_deny_overlays(scope_id, device_id);

CREATE TABLE IF NOT EXISTS recipient_managed_project_projections (
	canonical_project_identity TEXT NOT NULL,
	display_name TEXT NOT NULL,
	managed_scope_id TEXT NOT NULL,
	coordinator_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	recipient_identity_id TEXT NOT NULL,
	accepting_device_id TEXT NOT NULL,
	source_operation_id TEXT NOT NULL,
	reviewed_project_set_digest TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	accepted_at TEXT NOT NULL,
	revoked_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (source_operation_id, canonical_project_identity)
);
CREATE INDEX IF NOT EXISTS idx_recipient_managed_projects_identity_status
	ON recipient_managed_project_projections(recipient_identity_id, status);
CREATE INDEX IF NOT EXISTS idx_recipient_managed_projects_scope_authority
	ON recipient_managed_project_projections(managed_scope_id, coordinator_id, group_id, status);

CREATE TABLE IF NOT EXISTS share_operations (
	operation_id TEXT PRIMARY KEY NOT NULL,
	state TEXT NOT NULL,
	inviter_actor_id TEXT NOT NULL,
	inviter_device_ids_json TEXT NOT NULL,
	person_id TEXT NOT NULL,
	person_kind TEXT NOT NULL,
	pending_person_operation_id TEXT,
	teammate_name TEXT NOT NULL,
	history_policy TEXT NOT NULL,
	reviewed_project_set_digest TEXT NOT NULL,
	coordinator_group_id TEXT NOT NULL,
	coordinator_invite_id TEXT,
	invite_token_digest TEXT NOT NULL,
	invite_expires_at TEXT NOT NULL,
	recipient_actor_id TEXT,
	recipient_display_name TEXT,
	recipient_device_id TEXT,
	recipient_device_display_name TEXT,
	recipient_public_key TEXT,
	recipient_fingerprint TEXT,
	acceptance_consumed_at TEXT,
	trust_state TEXT,
	bootstrap_grant_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_operations_state_updated
	ON share_operations(state, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_operations_invite_digest
	ON share_operations(invite_token_digest);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_operations_pending_person_operation
	ON share_operations(pending_person_operation_id)
	WHERE pending_person_operation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS share_operation_projects (
	operation_id TEXT NOT NULL,
	canonical_project_identity TEXT NOT NULL,
	display_name TEXT NOT NULL,
	identity_source TEXT NOT NULL,
	existing_memory_count INTEGER NOT NULL,
	ordinal INTEGER NOT NULL,
	PRIMARY KEY (operation_id, canonical_project_identity)
);
CREATE TABLE IF NOT EXISTS share_operation_steps (
	operation_id TEXT NOT NULL,
	step_key TEXT NOT NULL,
	effect_id TEXT NOT NULL,
	status TEXT NOT NULL,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	started_at TEXT,
	completed_at TEXT,
	last_attempt_at TEXT,
	safe_error_code TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (operation_id, step_key)
);

CREATE TABLE IF NOT EXISTS sync_retention_state (
	id INTEGER PRIMARY KEY,
	last_run_at TEXT,
	last_duration_ms INTEGER,
	last_deleted_ops INTEGER NOT NULL DEFAULT 0,
	last_estimated_bytes_before INTEGER,
	last_estimated_bytes_after INTEGER,
	retained_floor_cursor TEXT,
	last_error TEXT,
	last_error_at TEXT
);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
	kind TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	status TEXT NOT NULL,
	message TEXT,
	progress_current INTEGER NOT NULL DEFAULT 0,
	progress_total INTEGER,
	progress_unit TEXT NOT NULL DEFAULT 'items',
	metadata_json TEXT,
	started_at TEXT,
	updated_at TEXT NOT NULL,
	finished_at TEXT,
	error TEXT
);

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_status_updated
	ON maintenance_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS sync_scope_rejections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	peer_device_id TEXT,
	op_id TEXT NOT NULL,
	entity_type TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	scope_id TEXT,
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_scope_rejections_peer_created
	ON sync_scope_rejections(peer_device_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sync_scope_rejections_scope_created
	ON sync_scope_rejections(scope_id, created_at);

-- import_key is the primary lookup key from replication_ops.entity_id back to
-- the source memory. The scope-backfill runner's selectReplicationOpScopeCandidates
-- query joins on it for every unstamped op; without this index a Pi 4 with
-- ~17k memories and ~35k ops scans the full memory_items table on every batch
-- tick. The partial WHERE clause keeps the index small (most rows have
-- import_key set; the few that don't aren't searchable anyway).
CREATE INDEX IF NOT EXISTS idx_memory_items_import_key
	ON memory_items(import_key)
	WHERE import_key IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
	title, body_text, tags_text,
	content='memory_items',
	content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
	INSERT INTO memory_fts(rowid, title, body_text, tags_text)
	VALUES (new.id, new.title, new.body_text, new.tags_text);
END;

DROP TRIGGER IF EXISTS memory_items_au;
CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items BEGIN
	INSERT INTO memory_fts(memory_fts, rowid, title, body_text, tags_text)
	VALUES('delete', old.id, old.title, old.body_text, old.tags_text);
	INSERT INTO memory_fts(rowid, title, body_text, tags_text)
	VALUES (new.id, new.title, new.body_text, new.tags_text);
END;

DROP TRIGGER IF EXISTS memory_items_ad;
CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items BEGIN
	INSERT INTO memory_fts(memory_fts, rowid, title, body_text, tags_text)
	VALUES('delete', old.id, old.title, old.body_text, old.tags_text);
END;

CREATE TABLE IF NOT EXISTS memory_file_refs (
	memory_id INTEGER NOT NULL,
	file_path TEXT NOT NULL,
	relation TEXT NOT NULL CHECK(relation IN ('read', 'modified')),
	PRIMARY KEY (memory_id, file_path, relation),
	FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_file_refs_path
	ON memory_file_refs(file_path);

CREATE TABLE IF NOT EXISTS memory_concept_refs (
	memory_id INTEGER NOT NULL,
	concept TEXT NOT NULL,
	PRIMARY KEY (memory_id, concept),
	FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_concept_refs_concept
	ON memory_concept_refs(concept);

CREATE TABLE IF NOT EXISTS coordinator_group_preferences (
	coordinator_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	projects_include_json TEXT,
	projects_exclude_json TEXT,
	auto_seed_scope INTEGER NOT NULL DEFAULT 1,
	default_space_scope_id TEXT,
	auto_grant_default_space_on_join INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (coordinator_id, group_id)
);

CREATE TABLE IF NOT EXISTS scope_membership_cache_state (
	coordinator_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	last_refresh_at TEXT NOT NULL,
	last_success_at TEXT,
	last_error TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (coordinator_id, group_id)
);
`;

/**
 * DDL for the sqlite-vec `memory_vectors` virtual table. Drizzle cannot model
 * virtual tables driven by a loadable extension, so this lives alongside the
 * other aux DDL and is executed through `ensureVectorSchema` (which first
 * makes sure the `vec0` module is actually loaded on the connection).
 *
 * Columns mirror the Python `_ensure_vector_schema` helper in `codemem/db.py`.
 * The embedding width (384) matches the default BAAI/bge-small-en-v1.5 model
 * and the existing vectors tests; changing it requires rebuilding existing
 * vector rows via the migration helper.
 */
const MEMORY_VECTORS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
	embedding float[384],
	memory_id INTEGER,
	chunk_index INTEGER,
	content_hash TEXT,
	model TEXT
);
`;

/**
 * Create the `memory_vectors` sqlite-vec virtual table on `db` if it does not
 * already exist. No-op when embeddings are disabled via
 * `CODEMEM_EMBEDDING_DISABLED`, matching the Python backend's behavior.
 *
 * This function is safe to call from any bootstrap path — it probes for
 * `vec_version()` first and only attempts to load the sqlite-vec extension if
 * it is not already present on the connection. That avoids double-loading when
 * callers (like `MemoryStore`) have already called `loadSqliteVec` directly.
 */
export function ensureVectorSchema(db: Database): void {
	if (isEmbeddingDisabled()) return;
	try {
		if (!isSqliteVecLoaded(db)) {
			loadSqliteVec(db);
		}
		db.exec(MEMORY_VECTORS_DDL);
	} catch {
		return;
	}
}

function isSqliteVecLoaded(db: Database): boolean {
	try {
		const row = db.prepare("SELECT vec_version() AS v").get() as { v?: string } | undefined;
		return typeof row?.v === "string" && row.v.length > 0;
	} catch {
		return false;
	}
}

export function bootstrapSchema(db: Database): void {
	db.transaction(() => {
		db.exec(TEST_SCHEMA_BASE_DDL);
		db.exec(SCHEMA_AUX_DDL);
		ensureRetrievalAttemptColumns(db);
		ensureOutcomeEvidenceColumns(db);
		assertBootstrapTablesCreated(db);
		db.pragma(`user_version = ${SCHEMA_VERSION}`);
	}).immediate();

	// sqlite-vec support is optional/best-effort. Keep it outside the core
	// bootstrap transaction so an unavailable extension cannot produce a
	// half-successful core schema, and cannot prevent first-run stats/setup.
	ensureVectorSchema(db);
}

/** Add the local-only retrieval ledger to an already initialized database. */
export function ensureRetrievalLedgerSchema(db: Database): void {
	if (!tableExists(db, "sessions") || !tableExists(db, "memory_items")) return;
	ensureMemoryItemsDeletedAtColumn(db);
	// Contract-v1 cleanup is explicit and bounded by retention/privacy selectors.
	// Remove the earlier global orphan trigger even when every table/index already exists.
	db.exec("DROP TRIGGER IF EXISTS trg_attribution_evidence_delete_orphan");
	if (
		!columnExists(db, "memory_items", "import_key") ||
		!columnExists(db, "memory_items", "origin_device_id")
	) {
		return;
	}
	const placeholders = RETRIEVAL_LEDGER_SCHEMA_OBJECTS.map(() => "?").join(", ");
	const row = db
		.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN (${placeholders})`)
		.get(...RETRIEVAL_LEDGER_SCHEMA_OBJECTS) as { count?: number } | undefined;
	if (row?.count !== RETRIEVAL_LEDGER_SCHEMA_OBJECTS.length) {
		// Replay the idempotent DDL only after detecting an interrupted migration.
		db.exec(RETRIEVAL_LEDGER_DDL);
	}
	ensureRetrievalExposureDetachUnavailableMemoryTrigger(db);
	ensureRetrievalAttemptColumns(db);
	ensureOutcomeEvidenceColumns(db);
}

function ensureRetrievalExposureDetachUnavailableMemoryTrigger(db: Database): void {
	const sql = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_retrieval_exposures_detach_unavailable_memory'",
		)
		.pluck()
		.get() as string | undefined;
	if (
		sql?.includes("NEW.memory_import_key IS NOT NULL") &&
		sql.includes("NEW.memory_import_key = import_key") &&
		sql.includes("NEW.origin_device_id = origin_device_id") &&
		sql.includes("NEW.memory_rev = rev") &&
		sql.includes("julianday(NEW.memory_updated_at) = julianday(updated_at)")
	) {
		return;
	}
	db.transaction(() => {
		db.exec(`
			DROP TRIGGER IF EXISTS trg_retrieval_exposures_detach_unavailable_memory;
			${RETRIEVAL_EXPOSURE_DETACH_UNAVAILABLE_MEMORY_DDL}
		`);
	}).immediate();
}

function ensureMemoryItemsDeletedAtColumn(db: Database): void {
	if (columnExists(db, "memory_items", "deleted_at")) return;
	try {
		// Existing rows become NULL, preserving active rows while leaving legacy
		// active=0 rows unavailable without inventing a deletion timestamp.
		db.exec("ALTER TABLE memory_items ADD COLUMN deleted_at TEXT");
	} catch (error) {
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		if (
			message.includes("duplicate column name") &&
			columnExists(db, "memory_items", "deleted_at")
		) {
			return;
		}
		throw error;
	}
}

function ensureRetrievalAttemptColumns(db: Database): void {
	for (const [name, definition] of [
		["evaluation_checkout_id", "TEXT"],
		["evaluation_fixture_id", "TEXT"],
		["evaluation_seed", "INTEGER"],
		["retention_finalized_at", "TEXT"],
	] as const) {
		const exists = db
			.prepare("SELECT 1 FROM pragma_table_info('retrieval_attempts') WHERE name = ? LIMIT 1")
			.get(name);
		if (exists === undefined) {
			db.exec(`ALTER TABLE retrieval_attempts ADD COLUMN ${name} ${definition}`);
		}
	}
}

function ensureOutcomeEvidenceColumns(db: Database): void {
	if (columnExists(db, "outcome_evidence", "retention_finalized_at")) return;
	try {
		db.exec("ALTER TABLE outcome_evidence ADD COLUMN retention_finalized_at TEXT");
	} catch (error) {
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		if (
			message.includes("duplicate column name") &&
			columnExists(db, "outcome_evidence", "retention_finalized_at")
		) {
			return;
		}
		throw error;
	}
}

function assertBootstrapTablesCreated(db: Database): void {
	const missing = REQUIRED_BOOTSTRAPPED_TABLES.filter((table) => !tableExists(db, table));
	if (missing.length > 0) {
		throw new Error(`Schema bootstrap failed; missing required tables: ${missing.join(", ")}`);
	}
}

function isSafeEmptyDatabase(db: Database): boolean {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM sqlite_master
			 WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
		)
		.get() as { count?: number } | undefined;
	return (row?.count ?? 0) === 0;
}

function tableExists(db: Database, table: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(table);
	return row !== undefined;
}

function columnExists(db: Database, table: string, column: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ? LIMIT 1")
		.get(table, column);
	return row !== undefined;
}

/**
 * Run `bootstrapSchema` on a database only if it's still at the unbootstrapped
 * state (`user_version === 0`). `connect()` now calls this by default for
 * writable handles, but explicit callers may still use it directly. Idempotent:
 * already-initialized databases are left untouched.
 */
export function ensureSchemaBootstrapped(db: Database): void {
	if (!isReadonlyDatabase(db) && canAutoBootstrapSchema(db)) {
		bootstrapSchema(db);
	}
}

export function canAutoBootstrapSchema(db: Database): boolean {
	return getSchemaVersion(db) === 0 && isSafeEmptyDatabase(db);
}

function isReadonlyDatabase(db: Database): boolean {
	return (db as { readonly?: boolean }).readonly === true;
}
