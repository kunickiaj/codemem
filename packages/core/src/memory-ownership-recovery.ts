import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { buildFilterClausesWithContext } from "./filters.js";
import { allocateLocalMemorySource, getVerifiedMemorySource } from "./memory-source-identity.js";
import { populateMemoryRefs } from "./ref-populate.js";
import * as schema from "./schema.js";
import type { MemoryStore } from "./store.js";

export class MemoryOwnershipRecoveryError extends Error {
	constructor(
		public readonly code: string,
		public readonly status: 400 | 403 | 404 | 409,
	) {
		super(code);
	}
}

interface RecoveryRequest {
	version: 1;
	memoryIds: number[];
}
type Row = typeof schema.memoryItems.$inferSelect;

function fail(code: string, status: 400 | 403 | 404 | 409 = 400): never {
	throw new MemoryOwnershipRecoveryError(code, status);
}

function request(value: unknown): RecoveryRequest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("ownership_request_invalid");
	const input = value as Record<string, unknown>;
	if (
		input.version !== 1 ||
		!Array.isArray(input.memoryIds) ||
		!input.memoryIds.length ||
		input.memoryIds.length > 100
	)
		fail("ownership_request_invalid");
	if (input.memoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
		fail("ownership_request_invalid");
	return { version: 1, memoryIds: [...new Set(input.memoryIds as number[])].sort((a, b) => a - b) };
}

function readableRows(store: MemoryStore, input: RecoveryRequest): Row[] {
	const filter = buildFilterClausesWithContext(null, store.ownershipFilterContext());
	const rows = store.db
		.prepare(`SELECT memory_items.* FROM memory_items
		WHERE memory_items.id IN (${input.memoryIds.map(() => "?").join(",")})
		AND active = 1 AND deleted_at IS NULL
		${filter.clauses.map((clause) => `AND (${clause})`).join(" ")} ORDER BY id`)
		.all(...input.memoryIds, ...filter.params) as Row[];
	if (rows.length !== input.memoryIds.length) fail("ownership_records_unavailable", 404);
	return rows;
}

function privacySignals(row: Row): string[] {
	let metadata: Record<string, unknown>;
	try {
		metadata = JSON.parse(row.metadata_json ?? "{}");
	} catch {
		return ["unknown"];
	}
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return ["unknown"];
	return [
		row.visibility,
		row.workspace_kind,
		row.workspace_id,
		row.scope_id,
		metadata.visibility,
		metadata.workspace_kind,
		metadata.workspace_id,
		metadata.scope_id,
	].map((value) =>
		String(value ?? "")
			.trim()
			.toLowerCase(),
	);
}

function assertRecoverable(store: MemoryStore, rows: Row[]): void {
	const device = store.db.prepare("SELECT device_id FROM sync_device").pluck().get();
	if (device !== store.deviceId || !store.hasCurrentConfiguredIdentity())
		fail("ownership_identity_changed", 409);
	const phase = store.db.prepare("SELECT phase FROM sync_daemon_state WHERE id = 1").pluck().get();
	if (phase === "needs_attention") fail("ownership_sync_reset_pending", 409);
	for (const row of rows) {
		const signals = privacySignals(row);
		if (signals.includes("unknown")) fail("ownership_privacy_evidence_invalid", 409);
		const personal = signals.some(
			(value) => value.startsWith("private") || value.startsWith("personal"),
		);
		if (personal && (row.actor_id !== store.actorId || !store.memoryOwnedBySelf(row)))
			fail("ownership_private_record_not_owned", 403);
	}
}

function recoveredVisibility(row: Row): string | null {
	if (
		privacySignals(row).some((value) => value.startsWith("private") || value.startsWith("personal"))
	)
		return "private";
	return row.visibility;
}

function evidence(store: MemoryStore, row: Row) {
	const binding = row.import_key ? getVerifiedMemorySource(store.db, row.import_key) : null;
	return {
		memoryId: row.id,
		title: row.title,
		originalIdentity: row.import_key,
		verification: binding ? ("verified" as const) : ("unverified" as const),
		verifiedSourceDeviceId: binding?.sourceDeviceId ?? null,
		missingEvidence: binding ? null : "immutable_source_binding",
		action: "recover_local_copy" as const,
		visibility: row.visibility,
		recoveredVisibility: recoveredVisibility(row),
		sourceScopeId: row.scope_id,
		destinationScopeId: "local-default",
		recipientDeviceIds: [] as string[],
		originalRetained: true as const,
	};
}

function previewState(store: MemoryStore, input: RecoveryRequest) {
	const rows = readableRows(store, input);
	assertRecoverable(store, rows);
	const records = rows.map((row) => evidence(store, row));
	const digest = createHash("sha256")
		.update(
			JSON.stringify({ input, rows, records, actorId: store.actorId, deviceId: store.deviceId }),
		)
		.digest("hex");
	return {
		rows,
		preview: {
			version: 1 as const,
			request: input,
			reviewedDigest: `ownership-recovery-v1:${digest}`,
			records,
			copyCount: rows.length,
			retainedOriginalCount: rows.length,
			effects: {
				copiesStayLocal: true as const,
				privacyPreserved: true as const,
				originalsRemain: true as const,
				duplicatesWillBeVisible: true as const,
				remoteErasure: false as const,
			},
		},
	};
}

/** Read-only: checking evidence never promotes reported origin into authority. */
export function previewMemoryOwnershipRecovery(store: MemoryStore, value: unknown) {
	return store.db.transaction(() => previewState(store, request(value)).preview)();
}

export function verifyMemoryOwnership(store: MemoryStore, value: unknown) {
	const preview = previewMemoryOwnershipRecovery(store, value);
	return {
		version: 1 as const,
		records: preview.records,
		nextAction: "preview_local_recovery" as const,
	};
}

function commitRequest(value: unknown) {
	const input = request(value);
	const body = value as Record<string, unknown>;
	if (
		typeof body.operationId !== "string" ||
		!/^[a-zA-Z0-9_-]{16,128}$/u.test(body.operationId) ||
		typeof body.reviewedDigest !== "string" ||
		!/^ownership-recovery-v1:[0-9a-f]{64}$/u.test(body.reviewedDigest) ||
		body.acknowledgeOriginalsRetained !== true
	)
		fail("ownership_confirmation_required");
	return { input, operationId: body.operationId, reviewedDigest: body.reviewedDigest };
}

function refValues(value: string | null): string[] | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return null;
	}
}

function recoveredMetadata(
	store: MemoryStore,
	original: Row,
	operationId: string,
	entityId: string,
) {
	return {
		import_key: entityId,
		actor_id: store.actorId,
		origin_device_id: store.deviceId,
		clock_device_id: store.deviceId,
		visibility: recoveredVisibility(original),
		workspace_id: original.workspace_id,
		workspace_kind: original.workspace_kind,
		scope_id: "local-default",
		recovered_copy: true,
		recovery: {
			original_metadata: JSON.parse(original.metadata_json ?? "{}"),
			operation_id: operationId,
			original_memory_id: original.id,
			original_import_key: original.import_key,
			reported_original_source: original.origin_device_id,
			original_retained: true,
			source_verification: "not_asserted",
		},
	};
}

function copyRow(store: MemoryStore, original: Row, operationId: string, now: string) {
	const binding = allocateLocalMemorySource(store.db);
	const session = store.db
		.prepare(`INSERT INTO sessions(started_at, project, tool_version, metadata_json)
		VALUES (?, ?, 'memory_recovery', ?)`)
		.run(now, original.project, JSON.stringify({ recovery_operation_id: operationId }));
	const metadata = recoveredMetadata(store, original, operationId, binding.entityId);
	const { id: _id, ...content } = original;
	const scanned = store.scanner.redactValue(content).value as typeof content;
	const inserted = drizzle(store.db)
		.insert(schema.memoryItems)
		.values({
			...scanned,
			session_id: Number(session.lastInsertRowid),
			import_key: binding.entityId,
			origin_device_id: store.deviceId,
			origin_source: "manual_recovery",
			actor_id: store.actorId,
			visibility: recoveredVisibility(original),
			actor_display_name: null,
			trust_state: original.trust_state,
			scope_id: "local-default",
			metadata_json: JSON.stringify(store.scanner.redactValue(metadata).value),
			rev: 1,
			created_at: now,
			updated_at: now,
			user_prompt_id: null,
			prompt_number: null,
		})
		.returning({ id: schema.memoryItems.id })
		.get();
	populateMemoryRefs(
		store.db,
		inserted.id,
		refValues(scanned.files_read),
		refValues(scanned.files_modified),
		refValues(scanned.concepts),
	);
	return {
		originalMemoryId: original.id,
		recoveredMemoryId: inserted.id,
		recoveredIdentity: binding.entityId,
	};
}

type RecoveryResult = {
	version: 1;
	status: "recovered";
	operationId: string;
	idempotent: boolean;
	copies: Array<{ originalMemoryId: number; recoveredMemoryId: number; recoveredIdentity: string }>;
	originalsRetained: true;
	copiesStayLocal: true;
};

export function commitMemoryOwnershipRecovery(store: MemoryStore, value: unknown): RecoveryResult {
	if (store.db.inTransaction) fail("ownership_outer_transaction_not_supported", 409);
	const { input, operationId, reviewedDigest } = commitRequest(value);
	const committed = store.db
		.transaction(() => {
			const receipt = store.db
				.prepare("SELECT * FROM memory_ownership_recoveries WHERE operation_id = ?")
				.get(operationId) as Record<string, string> | undefined;
			if (
				receipt &&
				(receipt.actor_id !== store.actorId ||
					receipt.device_id !== store.deviceId ||
					receipt.request_json !== JSON.stringify(input) ||
					receipt.reviewed_digest !== reviewedDigest)
			)
				fail("ownership_recovery_operation_conflict", 409);
			// Matching receipts still require current access; conflicting reuse never inspects records.
			const current = previewState(store, input);
			if (receipt) {
				return { ...JSON.parse(receipt.result_json ?? "{}"), idempotent: true } as RecoveryResult;
			}
			if (current.preview.reviewedDigest !== reviewedDigest) fail("ownership_preview_stale", 409);
			const now = new Date().toISOString();
			const copies = current.rows.map((row) => copyRow(store, row, operationId, now));
			const result: RecoveryResult = {
				version: 1,
				status: "recovered",
				operationId,
				idempotent: false,
				copies,
				originalsRetained: true,
				copiesStayLocal: true,
			};
			store.db
				.prepare(`INSERT INTO memory_ownership_recoveries(operation_id, actor_id, device_id, request_json, reviewed_digest, result_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`)
				.run(
					operationId,
					store.actorId,
					store.deviceId,
					JSON.stringify(input),
					reviewedDigest,
					JSON.stringify(result),
					now,
				);
			return result;
		})
		.immediate();
	if (!committed.idempotent) scheduleRecoveredVectors(store, committed);
	return committed;
}

function scheduleRecoveredVectors(store: MemoryStore, result: RecoveryResult): void {
	const query = store.db.prepare("SELECT title, body_text FROM memory_items WHERE id = ?");
	for (const copy of result.copies) {
		const row = query.get(copy.recoveredMemoryId) as { title: string; body_text: string };
		store.enqueueVectorWrite(copy.recoveredMemoryId, row.title, row.body_text);
	}
}
