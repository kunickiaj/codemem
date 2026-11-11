import type { ControllerHistorySnapshot } from "./coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import type { EvidenceRow } from "./coordinator-device-ownership-evidence-classify.js";
import {
	CONTROLLER_COLUMNS,
	RESOLUTION_COLUMNS,
	ROW_LIMIT,
} from "./coordinator-device-ownership-evidence-queries.js";
import {
	captureLegacyOwnerResolutionRecord,
	classifyLegacyOwnerResolutionSchemaCatalog,
} from "./coordinator-legacy-owner-resolution-metadata.js";

/**
 * Helpers the negative owner read set shares: the subject it checks, the resolution
 * catalog's classification, evidence row parsing, and the original-source pin.
 */

interface Backend {
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
	all?<T>(statement: AuthLinkStatement): Promise<T[]>;
}

/** Trusted subject metadata, not authority. Enrollment is optional for future
 * new-device producers; those producers must independently prove admission.
 */
export interface NegativeOwnerSubject {
	coordinatorId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	ownerIdentityId: string;
	enrollment?: { groupId: string };
	verifiedHistory?: ControllerHistorySnapshot;
}

export function capturedCatalogState(encoded: string) {
	const rows: unknown = JSON.parse(encoded);
	if (!Array.isArray(rows)) return "unsupported";
	const objects: { type: string; sql: string }[] = [];
	for (const row of rows) {
		if (
			!Array.isArray(row) ||
			row.length !== 4 ||
			typeof row[0] !== "string" ||
			typeof row[1] !== "string" ||
			row[2] !== "coordinator_legacy_owner_resolutions" ||
			(row[3] !== null && typeof row[3] !== "string")
		)
			return "unsupported";
		// The shared reader excludes SQLite's implicit indexes (SQL IS NULL).
		// Keep those objects in the full catalog pin, not the DDL comparison.
		if (row[3] !== null) objects.push({ type: row[0], sql: row[3] });
	}
	return classifyLegacyOwnerResolutionSchemaCatalog(objects);
}

export function parseEvidenceRows(values: { row: string | null }[]): EvidenceRow[] {
	if (values.length > ROW_LIMIT) throw new Error("ownership_evidence_too_large");
	return values.map(({ row }) => {
		if (typeof row !== "string") throw new Error("ownership_evidence_unavailable");
		const value: unknown = JSON.parse(row);
		if (
			!Array.isArray(value) ||
			value.some((v) => v !== null && typeof v !== "string" && typeof v !== "number")
		)
			throw new Error("ownership_evidence_unavailable");
		return value as EvidenceRow;
	});
}

export async function sourcePins(
	backend: Backend,
	rows: EvidenceRow[],
): Promise<AuthLinkStatement> {
	const sources: EvidenceRow[] = [];
	for (const row of rows) {
		const resolution = await captureLegacyOwnerResolutionRecord(
			Object.fromEntries(RESOLUTION_COLUMNS.map((column, i) => [column, row[i]])),
		);
		if (!resolution) throw new Error("ownership_resolution_unavailable");
		const expected = [
			resolution.source_attestation_id,
			resolution.coordinator_id,
			resolution.owner_identity_id,
			resolution.source_group_id,
			resolution.device_id,
			resolution.source_public_key,
			resolution.source_fingerprint,
			resolution.source_review_receipt_id,
			resolution.source_evidence_digest,
			resolution.source_enrollment_identity_id,
			resolution.source_controller_revision,
			resolution.source_created_at,
			null,
		];
		const source = await backend.first<Record<string, unknown>>({
			sql: `SELECT ${CONTROLLER_COLUMNS.join(",")} FROM coordinator_auth_controller_attestations WHERE coordinator_id=? AND attestation_id=?`,
			values: [resolution.coordinator_id, resolution.source_attestation_id],
		});
		if (source && CONTROLLER_COLUMNS.every((column, i) => source[column] === expected[i]))
			sources.push(expected);
	}
	// One complete original source suffices; stale same-owner receipts do not
	// erase another original, unrevoked source. Metadata was validated separately.
	if (sources.length === 0) throw new Error("ownership_source_unavailable");
	return {
		sql: `SELECT EXISTS (SELECT 1 FROM json_each(?) pin WHERE EXISTS (
 SELECT 1 FROM coordinator_auth_controller_attestations source WHERE ${CONTROLLER_COLUMNS.map((column, i) => `source.${column} IS json_extract(pin.value,'$[${i}]')`).join(" AND ")})) AS matches`,
		values: [JSON.stringify(sources)],
	};
}
