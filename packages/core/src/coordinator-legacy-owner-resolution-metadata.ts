import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS } from "./coordinator-legacy-owner-resolution-schema.js";

/** Shape and key consistency only: never an ownership or provenance proof. */
export interface LegacyOwnerResolutionRecord {
	coordinator_id: string;
	resolution_id: string;
	resolution_version: 1;
	device_id: string;
	key_id: string;
	owner_identity_id: string;
	purpose: "existing_account_owner";
	scope: "historical_included_owner_labels_only";
	source_attestation_id: string;
	source_group_id: string;
	source_controller_revision: 1;
	source_public_key: string;
	source_fingerprint: string;
	source_enrollment_identity_id: string | null;
	source_created_at: string;
	source_review_receipt_id: string;
	source_evidence_digest: string;
	resolution_evidence_digest: string;
	reviewed_weak_labels_json: string;
	created_at: string;
}

export interface ReviewedWeakLabel {
	label: string;
	kind: "legacy_included_owner_label" | "consumed_project_actor_label";
	group_id: string;
	device_id: string;
	evidence_ref: string;
	effect: "account_owner_display_only";
}

export type LegacyOwnerResolutionSchemaState = "ready" | "missing" | "unsupported";
const MAX_WEAK_BYTES = 131072;
const encoder = new TextEncoder();
const isIdentifier = (v: unknown): v is string =>
	typeof v === "string" &&
	v.length > 0 &&
	v.length <= 256 &&
	v.trim() === v &&
	!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v);
const isHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const isTimestamp = (v: unknown): v is string => {
	if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v)) return false;
	const date = new Date(v);
	return Number.isFinite(date.getTime()) && date.toISOString() === v;
};

const recordChecks = {
	coordinator_id: isIdentifier,
	resolution_id: isIdentifier,
	resolution_version: (v: unknown) => v === 1,
	device_id: isIdentifier,
	key_id: isHash,
	owner_identity_id: isIdentifier,
	purpose: (v: unknown) => v === "existing_account_owner",
	scope: (v: unknown) => v === "historical_included_owner_labels_only",
	source_attestation_id: isIdentifier,
	source_group_id: isIdentifier,
	source_controller_revision: (v: unknown) => v === 1,
	source_public_key: (v: unknown) =>
		typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\u0000"),
	source_fingerprint: isHash,
	source_enrollment_identity_id: (v: unknown) => v === null || isIdentifier(v),
	source_created_at: isTimestamp,
	source_review_receipt_id: isIdentifier,
	source_evidence_digest: isHash,
	resolution_evidence_digest: isHash,
	reviewed_weak_labels_json: (v: unknown) => typeof v === "string",
	created_at: isTimestamp,
} satisfies Record<keyof LegacyOwnerResolutionRecord, (v: unknown) => boolean>;
const weakFields = ["label", "kind", "group_id", "device_id", "evidence_ref", "effect"];

/** Copy own data descriptors before validation; never serialize caller objects. */
function captureFields(value: unknown, fields: string[]): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) return null;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== fields.length) return null;
	const captured: Record<string, unknown> = {};
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (!descriptor || !("value" in descriptor)) return null;
		captured[field] = descriptor.value;
	}
	return captured;
}

function captureWeakLabel(value: unknown): ReviewedWeakLabel | null {
	const row = captureFields(value, weakFields);
	if (
		!row ||
		!isIdentifier(row.label) ||
		!isIdentifier(row.group_id) ||
		!isIdentifier(row.device_id) ||
		!isHash(row.evidence_ref) ||
		(row.kind !== "legacy_included_owner_label" && row.kind !== "consumed_project_actor_label") ||
		row.effect !== "account_owner_display_only"
	)
		return null;
	return {
		label: row.label,
		kind: row.kind,
		group_id: row.group_id,
		device_id: row.device_id,
		evidence_ref: row.evidence_ref,
		effect: row.effect,
	};
}

/** Categories describe reviewed display metadata, not verified server provenance. */
export function canonicalReviewedWeakLabels(value: unknown): string | null {
	try {
		if (!Array.isArray(value)) return null;
		const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
		if (
			typeof length !== "number" ||
			!Number.isInteger(length) ||
			length < 0 ||
			length > 256 ||
			Reflect.ownKeys(value).length !== length + 1
		)
			return null;
		const entries: string[] = [];
		for (let i = 0; i < length; i++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
			if (!descriptor || !("value" in descriptor)) return null;
			const entry = captureWeakLabel(descriptor.value);
			if (!entry) return null;
			entries.push(JSON.stringify(entry));
		}
		entries.sort(); // ECMAScript binary string order, never locale collation.
		if (new Set(entries).size !== entries.length) return null;
		const json = `[${entries.join(",")}]`;
		return encoder.encode(json).byteLength <= MAX_WEAK_BYTES ? json : null;
	} catch {
		return null;
	}
}

function isResolutionRecord(
	row: Record<string, unknown>,
): row is LegacyOwnerResolutionRecord & Record<string, unknown> {
	return Object.entries(recordChecks).every(([field, check]) => check(row[field]));
}

function hasCanonicalStoredLabels(json: string): boolean {
	if (json.length > MAX_WEAK_BYTES || encoder.encode(json).byteLength > MAX_WEAK_BYTES)
		return false;
	return canonicalReviewedWeakLabels(JSON.parse(json)) === json;
}

export async function captureLegacyOwnerResolutionRecord(
	value: unknown,
): Promise<LegacyOwnerResolutionRecord | null> {
	try {
		const row = captureFields(value, Object.keys(recordChecks));
		if (
			!row ||
			!isResolutionRecord(row) ||
			!hasCanonicalStoredLabels(row.reviewed_weak_labels_json)
		)
			return null;
		if ((await ed25519KeyIdForRevocation(row.source_public_key)) !== row.key_id) return null;
		// Historical fingerprint and exact key text bind source records in a later reader.
		return row;
	} catch {
		return null;
	}
}

/** Tokenize rather than deleting whitespace/comments inside SQL string literals. */
function normalizedDefinition(sql: string): string {
	const tokens =
		sql.match(
			/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s+|[a-zA-Z_][a-zA-Z_0-9]*|\d+|[^\s]/gu,
		) ?? [];
	const normalized = tokens
		.filter((t) => !/^\s|^--|^\/\*/u.test(t))
		.map((t) => (/^[a-zA-Z_]/u.test(t) ? t.toLowerCase() : t));
	if (normalized.at(-1) === ";") normalized.pop();
	return normalized.join(" ").replace(/^(create (?:table|index|trigger)) if not exists /u, "$1 ");
}

const table = "coordinator_legacy_owner_resolutions";
const definitions = LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS.map(normalizedDefinition);

/** Classify one captured catalog, using the same DDL rules as the live reader. */
export function classifyLegacyOwnerResolutionSchemaCatalog(
	value: unknown,
): LegacyOwnerResolutionSchemaState {
	if (!Array.isArray(value)) return "unsupported";
	if (value.length === 0) return "missing";
	if (
		value.some(
			(object) => !object || typeof object.type !== "string" || typeof object.sql !== "string",
		)
	)
		return "unsupported";
	if (!value.some((object) => object.type === "table")) return "unsupported";
	if (value.length !== definitions.length) return "unsupported";
	const actual = value.map((object) => normalizedDefinition(object.sql));
	return definitions.every((ddl) => actual.includes(ddl)) ? "ready" : "unsupported";
}

export async function readLegacyOwnerResolutionSchemaState(
	backend: Pick<AuthLinkBackend, "first">,
): Promise<LegacyOwnerResolutionSchemaState> {
	try {
		// One catalog snapshot includes every attached trigger and explicit index.
		const result = await backend.first<{ objects: string }>({
			sql: `SELECT json_group_array(json_object('type',type,'sql',sql)) AS objects
			 FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL`,
			values: [table],
		});
		if (!result) return "unsupported";
		return classifyLegacyOwnerResolutionSchemaCatalog(JSON.parse(result.objects));
	} catch {
		return "unsupported";
	}
}
