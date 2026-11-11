/**
 * Test-only. This file exists only to pin equivalence with the pre-port SQL.
 *
 * Between the markers are, copied verbatim from main at 9a9bf301f before the recipient
 * invite moved to read-set guards: the unknown-namespace builder and its catalog helpers
 * from coordinator-owner-negative-consistency.ts, and `recipientOwnerWriteSql` from
 * coordinator-recipient-owner-consistency.ts. Only the two entry points were renamed.
 * After the markers, the two SQL templates that d1-coordinator-store.ts built around the
 * pins, copied verbatim into functions. Do not edit the copy to follow later changes;
 * delete this file with coordinator-recipient-owner-equivalence.test.ts.
 */
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { classifyLegacyOwnerResolutionSchemaCatalog } from "./coordinator-legacy-owner-resolution-metadata.js";
import type { NegativeOwnerSubject } from "./coordinator-owner-negative-consistency.js";
import { withNegativeOwnerWrite } from "./coordinator-owner-producer-original-sql-test-fixtures.js";

// ---- verbatim copy starts ----
interface Backend {
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
	all?<T>(statement: AuthLinkStatement): Promise<T[]>;
}

export interface NegativeOwnerConsistency extends AuthLinkStatement {
	/** Catalog, retained facts and original source only; unaffected by producer output. */
	retainedRecheck: AuthLinkStatement;
}

function consistencyResult(statement: AuthLinkStatement): NegativeOwnerConsistency {
	return { ...statement, retainedRecheck: statement };
}

async function captureNegativeCatalog(backend: Backend) {
	const catalog = await backend.first<{ objects: string }>({ sql: catalogSql, values: [] });
	if (!catalog || typeof catalog.objects !== "string") return null;
	const state = capturedCatalogState(catalog.objects);
	if (state === "unsupported" || (state === "missing" && catalog.objects !== "[]")) return null;
	return { ...catalog, state, pin: `(${catalogSql.replace(" AS objects", "")}) IS ?` };
}

const catalogSql = `SELECT json_group_array(json_array(type,name,tbl_name,sql)) AS objects
 FROM sqlite_master WHERE tbl_name='coordinator_legacy_owner_resolutions'`;

function capturedCatalogState(encoded: string) {
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

/** Compatibility for old internal callers, never infer a coordinator namespace. */
export async function prepareOriginalUnknownNamespaceOwnerConsistency(
	backend: Backend,
	input: Pick<NegativeOwnerSubject, "deviceId" | "publicKey">,
): Promise<NegativeOwnerConsistency | null> {
	try {
		const catalog = await captureNegativeCatalog(backend);
		if (!catalog) return null;
		if (catalog.state === "missing")
			return consistencyResult({
				sql: `SELECT ${catalog.pin} AS matches`,
				values: [catalog.objects],
			});
		const keyId = await ed25519KeyIdForRevocation(input.publicKey);
		const absent: AuthLinkStatement = {
			sql: "SELECT NOT EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions WHERE device_id=? OR key_id=?) AS matches",
			values: [input.deviceId, keyId],
		};
		if ((await backend.first<{ matches: number }>(absent))?.matches !== 1) return null;
		return consistencyResult({
			sql: `WITH consistency_absent AS MATERIALIZED (${absent.sql}) SELECT ${catalog.pin} AND (SELECT matches FROM consistency_absent) AS matches`,
			values: [...absent.values, catalog.objects],
		});
	} catch {
		return null;
	}
}

export function originalRecipientOwnerWriteSql(sql: string, predicate: AuthLinkStatement): string {
	return withNegativeOwnerWrite({ sql, values: [] }, predicate).sql;
}
// ---- verbatim copy ends ----

/** runRecipientInviteBatch's confirmation, with the template text as it was. */
export function originalRecipientConfirmation(
	negative: AuthLinkStatement,
	guard: AuthLinkStatement,
): AuthLinkStatement {
	return {
		sql: `WITH recipient_negative AS MATERIALIZED (${negative.sql})
 SELECT CASE WHEN (${guard.sql}) AND (SELECT matches FROM recipient_negative)
 THEN 1 ELSE json('recipient_invite_authorization_failed') END AS confirmed`,
		values: [...negative.values, ...guard.values],
	};
}

/** repairBoundRecipientInviteIdentity's confirmation pin, with the template text as it was. */
export function originalRepairNegative(
	firstWriteNegative: AuthLinkStatement,
	retainedRecheck: AuthLinkStatement,
): AuthLinkStatement {
	return {
		sql: `SELECT (changes() = 1 OR (SELECT matches FROM (${firstWriteNegative.sql})))
				AND (SELECT matches FROM (${retainedRecheck.sql})) AS matches`,
		values: [...firstWriteNegative.values, ...retainedRecheck.values],
	};
}
