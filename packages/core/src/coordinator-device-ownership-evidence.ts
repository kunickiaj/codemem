import {
	type ControllerHistorySnapshot,
	captureControllerHistory,
	captureControllerHistorySnapshot,
	controllerHistoryDiscoveryFragments,
} from "./coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	classifyEvidence,
	type EvidenceRow,
	type EvidenceRows,
	type EvidenceSubject,
	evidenceRows,
	hash,
	identifier,
	keyId,
	type OwnershipDecision,
} from "./coordinator-device-ownership-evidence-classify.js";
import { capturedOwnershipEvidenceDigest } from "./coordinator-device-ownership-evidence-digest.js";
import {
	atomicEvidenceQuery,
	BYTE_LIMIT,
	type CapturedEvidenceRow,
	CONTROLLER_COLUMNS,
	EVIDENCE_QUERIES,
	ROW_LIMIT,
	readCombinedEvidenceQuery,
} from "./coordinator-device-ownership-evidence-queries.js";
import {
	captureLegacyOwnerResolutionRecord,
	classifyLegacyOwnerResolutionSchemaCatalog,
	type ReviewedWeakLabel,
	readLegacyOwnerResolutionSchemaState,
} from "./coordinator-legacy-owner-resolution-metadata.js";

interface EvidenceBackend {
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
	all<T>(statement: AuthLinkStatement): Promise<T[]>;
}
interface ActualSigner {
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
}
interface CollectionInput {
	canonicalOwnerId: string;
	actualSigner: ActualSigner;
	verifiedHistory: ControllerHistorySnapshot;
}
interface RecheckSnapshot {
	readonly version: 1;
}
type OwnershipCollection =
	| {
			kind: "collected";
			decision: OwnershipDecision;
			weakLabels: ReviewedWeakLabel[];
			recheckSnapshot: RecheckSnapshot;
	  }
	| { kind: "unavailable"; authorizationUnavailable: true };
type SourceVerification =
	| { kind: "verified_controller_source" | "source_missing" | "source_revoked" | "source_mismatch" }
	| { kind: "unavailable"; authorizationUnavailable: true };
const unavailable = { kind: "unavailable", authorizationUnavailable: true } as const;

function captureFields(value: unknown, fields: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_input");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid_input");
	if (Reflect.ownKeys(value).length !== fields.length) throw new Error("invalid_input");
	const copy: Record<string, unknown> = {};
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (!descriptor || !("value" in descriptor)) throw new Error("invalid_input");
		copy[field] = descriptor.value;
	}
	return copy;
}

async function captureSigner(value: unknown, coordinatorId: string): Promise<EvidenceSubject> {
	const signer = captureFields(value, ["groupId", "deviceId", "publicKey", "fingerprint"]);
	if (!identifier(signer.groupId) || !identifier(signer.deviceId) || !hash(signer.fingerprint))
		throw new Error("invalid_signer");
	const canonicalKey = await keyId(signer.publicKey);
	return {
		coordinatorId,
		groupId: signer.groupId,
		deviceId: signer.deviceId,
		publicKey: String(signer.publicKey),
		fingerprint: signer.fingerprint,
		keyId: canonicalKey,
	};
}

function parseRows(rows: { row: string | null }[]): { encoded: string[]; parsed: EvidenceRow[] } {
	if (rows.length > ROW_LIMIT) throw new Error("evidence_too_large");
	const encoded: string[] = [];
	let bytes = 0;
	const parsed = rows.map(({ row }) => {
		if (typeof row !== "string") throw new Error("invalid_evidence");
		bytes += new TextEncoder().encode(row).byteLength;
		if (bytes > BYTE_LIMIT) throw new Error("evidence_too_large");
		const value: unknown = JSON.parse(row);
		if (
			!Array.isArray(value) ||
			value.some((item) => item !== null && typeof item !== "string" && typeof item !== "number")
		)
			throw new Error("invalid_evidence");
		encoded.push(row);
		return value as EvidenceRow;
	});
	return { encoded, parsed };
}

function requireCapturedCategory(category: CapturedEvidenceRow[]): CapturedEvidenceRow[] {
	const count = category[0]?.row_count;
	if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > ROW_LIMIT)
		throw new Error("invalid_evidence");
	if (category.length !== Math.max(1, count)) throw new Error("invalid_evidence");
	if (category.some((row) => row.row_count !== count)) throw new Error("invalid_evidence");
	if (count !== 0) return category;
	if (category[0]?.row !== null) throw new Error("invalid_evidence");
	return [];
}

function groupCapturedRows(captured: CapturedEvidenceRow[]): Map<string, CapturedEvidenceRow[]> {
	if (captured.length > EVIDENCE_QUERIES.length * (ROW_LIMIT + 1))
		throw new Error("evidence_too_large");
	const categories = new Map<string, CapturedEvidenceRow[]>(
		EVIDENCE_QUERIES.map(({ name }) => [name, []]),
	);
	for (const value of captured) {
		const row = captureFields(value, ["category", "row_count", "row"]);
		if (typeof row.category !== "string") throw new Error("invalid_evidence");
		const category = categories.get(row.category);
		if (!category) throw new Error("invalid_evidence");
		category.push(value);
	}
	for (const [name, category] of categories)
		categories.set(name, requireCapturedCategory(category));
	return categories;
}

function historyRows(history: ControllerHistorySnapshot): EvidenceRows {
	return {
		history: history.records.map((row) => [
			row.group_id,
			row.candidate_ref,
			row.manifest_version,
			row.completed_at,
			row.created_at,
			row.manifest_json,
		]),
		historyKeys: history.keys.map((row) => [row.public_key, row.fingerprint]),
		historyDiscovery: history.discoveryKeys.map((publicKey) => [publicKey]),
	};
}

function requireSameHistory(rows: EvidenceRows, history: ControllerHistorySnapshot): void {
	const expected = historyRows(history);
	for (const [name, values] of Object.entries(expected)) {
		if (
			JSON.stringify(values.map((row) => JSON.stringify(row)).sort()) !==
			JSON.stringify(
				evidenceRows(rows, name)
					.map((row) => JSON.stringify(row))
					.sort(),
			)
		)
			throw new Error("changed_history");
	}
}

function requireSupportedCapturedSchema(rows: EvidenceRows): void {
	const objects = evidenceRows(rows, "schema").map((row) => {
		if (
			row.length !== 4 ||
			typeof row[0] !== "string" ||
			typeof row[1] !== "string" ||
			row[2] !== "coordinator_legacy_owner_resolutions" ||
			typeof row[3] !== "string"
		)
			throw new Error("invalid_schema_evidence");
		return { type: row[0], sql: row[3] };
	});
	if (classifyLegacyOwnerResolutionSchemaCatalog(objects) !== "ready")
		throw new Error("unsupported_schema_evidence");
}

/** Internal read-only metadata collector. No result of this class grants access. */
export class CoordinatorDeviceOwnershipEvidence {
	private readonly snapshots = new WeakMap<object, { encoded: string; digest: string }>();
	private readonly coordinatorId: string;
	constructor(
		private readonly backend: EvidenceBackend,
		config: { coordinatorId: string },
	) {
		this.coordinatorId = config.coordinatorId;
	}

	async collect(input: CollectionInput): Promise<OwnershipCollection> {
		try {
			if (!identifier(this.coordinatorId)) return unavailable;
			const captured = captureFields(input, [
				"canonicalOwnerId",
				"actualSigner",
				"verifiedHistory",
			]);
			if (!identifier(captured.canonicalOwnerId)) return unavailable;
			const subject = await captureSigner(captured.actualSigner, this.coordinatorId);
			const history = await this.verifyHistory(captured.verifiedHistory, subject);
			if ((await readLegacyOwnerResolutionSchemaState(this.backend)) !== "ready")
				return unavailable;
			const { rows, encoded } = await this.captureRows(subject, history);
			requireSupportedCapturedSchema(rows);
			requireSameHistory(rows, history);
			const classification = await classifyEvidence(
				rows,
				subject,
				captured.canonicalOwnerId,
				history,
			);
			const matches = await this.backend.first<{ matches: number }>(atomicEvidenceQuery(encoded));
			if (matches?.matches !== 1) return unavailable;
			const digest = await capturedOwnershipEvidenceDigest(
				rows,
				subject,
				captured.canonicalOwnerId,
				history,
			);
			const recheckSnapshot = Object.freeze({ version: 1 as const });
			this.snapshots.set(recheckSnapshot, { encoded, digest });
			return { kind: "collected", ...classification, recheckSnapshot };
		} catch {
			return unavailable;
		}
	}

	private async verifyHistory(
		value: unknown,
		subject: EvidenceSubject,
	): Promise<ControllerHistorySnapshot> {
		const captured = captureControllerHistorySnapshot(value);
		if (!captured) throw new Error("invalid_history");
		const live = await captureControllerHistory(
			{
				coordinatorId: subject.coordinatorId,
				deviceId: subject.deviceId,
				publicKey: subject.publicKey,
				fingerprint: subject.fingerprint,
			},
			<T>(sql: string, values: string[]) => this.backend.all<T>({ sql, values }),
		);
		if (
			live.coordinatorId !== captured.coordinatorId ||
			live.deviceId !== captured.deviceId ||
			live.publicKey !== captured.publicKey ||
			live.fingerprint !== captured.fingerprint
		)
			throw new Error("changed_history");
		requireSameHistory(historyRows(live), captured);
		return live;
	}

	private async captureRows(
		subject: EvidenceSubject,
		legacyHistory: ControllerHistorySnapshot,
	): Promise<{ rows: EvidenceRows; encoded: string }> {
		const base = {
			subject: { ...subject, fragments: controllerHistoryDiscoveryFragments(subject.publicKey) },
			legacyHistory,
		};
		const parameters = JSON.stringify(base);
		const categories = groupCapturedRows(
			await this.backend.all<CapturedEvidenceRow>(readCombinedEvidenceQuery(parameters)),
		);
		const rows: EvidenceRows = {};
		const encodedRows: Record<string, string[]> = {};
		let bytes = parameters.length;
		for (const [name, category] of categories) {
			const values = parseRows(category);
			rows[name] = values.parsed;
			encodedRows[name] = values.encoded;
			bytes += values.encoded.reduce((total, row) => total + row.length, 0);
			if (bytes > BYTE_LIMIT) throw new Error("evidence_too_large");
		}
		const encoded = JSON.stringify({ ...base, rows: encodedRows });
		if (new TextEncoder().encode(encoded).byteLength > BYTE_LIMIT)
			throw new Error("evidence_too_large");
		return { rows, encoded };
	}

	/** A predicate for a future checked batch, never an admission or a write. */
	prepareAtomicRecheck(snapshot: RecheckSnapshot): AuthLinkStatement {
		const encoded = this.snapshots.get(snapshot)?.encoded;
		if (!encoded) return { sql: "SELECT 0 AS matches", values: [] };
		return atomicEvidenceQuery(encoded);
	}

	/** Private confirmation metadata; only this reader's original capture is accepted. */
	async reviewedEvidenceDigest(snapshot: unknown): Promise<string | null> {
		if (snapshot === null || typeof snapshot !== "object") return null;
		return this.snapshots.get(snapshot)?.digest ?? null;
	}

	async verifyControllerSource(input: {
		sourceRef: unknown;
		expectedOwnerId: string;
		actualSigner: ActualSigner;
	}): Promise<SourceVerification> {
		try {
			const captured = captureFields(input, ["sourceRef", "expectedOwnerId", "actualSigner"]);
			const reference = await captureLegacyOwnerResolutionRecord(captured.sourceRef);
			if (!reference || !identifier(captured.expectedOwnerId)) return unavailable;
			const subject = await captureSigner(captured.actualSigner, this.coordinatorId);
			if (
				reference.coordinator_id !== this.coordinatorId ||
				reference.owner_identity_id !== captured.expectedOwnerId ||
				reference.device_id !== subject.deviceId ||
				reference.key_id !== subject.keyId
			)
				return { kind: "source_mismatch" };
			const source = await this.backend.first<Record<string, string | number | null>>({
				sql: `SELECT ${CONTROLLER_COLUMNS.map((column) => (column === "public_key" ? "CASE WHEN length(CAST(public_key AS BLOB)) <= 4096 THEN public_key ELSE NULL END AS public_key" : column)).join(",")} FROM coordinator_auth_controller_attestations WHERE coordinator_id=? AND attestation_id=?`,
				values: [this.coordinatorId, reference.source_attestation_id],
			});
			if (!source) return { kind: "source_missing" };
			if (source.revoked_at !== null) return { kind: "source_revoked" };
			const expected = [
				reference.source_attestation_id,
				reference.coordinator_id,
				reference.owner_identity_id,
				reference.source_group_id,
				reference.device_id,
				reference.source_public_key,
				reference.source_fingerprint,
				reference.source_review_receipt_id,
				reference.source_evidence_digest,
				reference.source_enrollment_identity_id,
				reference.source_controller_revision,
				reference.source_created_at,
				null,
			];
			if (
				!CONTROLLER_COLUMNS.every((column, i) => source[column] === expected[i]) ||
				(await keyId(source.public_key)) !== subject.keyId
			)
				return { kind: "source_mismatch" };
			return { kind: "verified_controller_source" };
		} catch {
			return unavailable;
		}
	}
}
