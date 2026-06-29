import { normalizeMemoryDedupTitle } from "./memory-dedup.js";
import { classifyMemoryWorthiness, type MemoryWorthinessReason } from "./memory-quality.js";
import type {
	DerivedFactInput,
	DerivedFactProvenance,
	DerivedFactResult,
	MemoryStore,
} from "./store.js";

export const DERIVE_EXTRACTOR_VERSION = "v1";

export type ClaimType =
	| "contract"
	| "invariant"
	| "source-of-truth"
	| "non-goal"
	| "preference"
	| "gotcha"
	| "failure"
	| "bugfix"
	| "locator"
	| "decision";

export interface ComputeClaimKeyInput {
	claimType: ClaimType | string;
	scopeKey: string;
	title: string;
}

export function computeClaimKey(input: ComputeClaimKeyInput): string {
	return `df:v1:${input.claimType}:${input.scopeKey}:${normalizeMemoryDedupTitle(input.title)}`;
}

export interface ComputeScopeKeyInput {
	filesModified?: string[] | null;
	filesRead?: string[] | null;
	concepts?: string[] | null;
}

function normalizeScopePart(value: string): string {
	return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

export function computeScopeKey(input: ComputeScopeKeyInput): string {
	return [...(input.filesModified ?? []), ...(input.filesRead ?? []), ...(input.concepts ?? [])]
		.map(normalizeScopePart)
		.filter(Boolean)
		.filter((value, index, array) => array.indexOf(value) === index)
		.sort()
		.slice(0, 3)
		.join(",");
}

export function groundingTokensPresent(input: {
	mustAppearTokens: string[];
	sourceBodies: string[];
}): boolean {
	if (input.mustAppearTokens.length === 0) return false;
	const bodies = input.sourceBodies.map((body) => body.toLowerCase());
	return input.mustAppearTokens.every((token) => {
		const needle = token.trim().toLowerCase();
		return needle.length > 0 && bodies.some((body) => body.includes(needle));
	});
}

const TRUST_ORDER = ["trusted", "unreviewed", "legacy_unknown", "untrusted"];

export function leastTrustedState(states: Array<string | null | undefined>): string {
	let least = "trusted";
	for (const raw of states) {
		// A missing/blank source trust_state (nullable column on legacy/replicated
		// rows) must NOT be treated as trusted — degrade to the least-trusted known
		// tier so derivation never launders untrusted provenance into a trusted fact.
		const state = raw?.trim() || "legacy_unknown";
		if (TRUST_ORDER.indexOf(state) > TRUST_ORDER.indexOf(least)) least = state;
		if (!TRUST_ORDER.includes(state)) least = state;
	}
	return least;
}

export type ProvenanceReductionResult =
	| { ok: true; provenance: DerivedFactProvenance }
	| { ok: false; reason: string };

export function reduceProvenance(
	sources: Array<{
		scope_id: string | null;
		visibility: string | null;
		workspace_id: string | null;
		workspace_kind: string | null;
		trust_state: string | null;
		actor_id?: string | null;
		actor_display_name?: string | null;
		origin_device_id?: string | null;
	}>,
): ProvenanceReductionResult {
	if (sources.length === 0) return { ok: false, reason: "no_sources" };
	const first = sources[0];
	if (!first) return { ok: false, reason: "no_sources" };
	if (!first.scope_id || !first.visibility || !first.workspace_id || !first.workspace_kind) {
		return { ok: false, reason: "missing_provenance" };
	}
	for (const source of sources) {
		if (
			source.scope_id !== first.scope_id ||
			source.visibility !== first.visibility ||
			source.workspace_id !== first.workspace_id ||
			source.workspace_kind !== first.workspace_kind
		) {
			return { ok: false, reason: "mixed_provenance" };
		}
	}
	return {
		ok: true,
		provenance: {
			scope_id: first.scope_id,
			visibility: first.visibility,
			workspace_id: first.workspace_id,
			workspace_kind: first.workspace_kind,
			trust_state: leastTrustedState(sources.map((source) => source.trust_state)),
			actor_id: first.actor_id ?? null,
			actor_display_name: first.actor_display_name ?? null,
			origin_device_id: first.origin_device_id ?? null,
		},
	};
}

export function kindForClaimType(
	claimType: ClaimType | string,
): "decision" | "bugfix" | "discovery" {
	if (["gotcha", "failure", "failure-mode", "bugfix", "regression"].includes(claimType)) {
		return "bugfix";
	}
	if (claimType === "locator") return "discovery";
	return "decision";
}

export interface CorpusRow {
	id: number;
	session_id: number;
	kind: string;
	title: string;
	body_text: string;
	metadata_json: string | null;
	created_at: string;
	visibility: string | null;
	workspace_id: string | null;
	workspace_kind: string | null;
	scope_id: string | null;
	trust_state: string | null;
	actor_id: string | null;
	actor_display_name: string | null;
	origin_device_id: string | null;
	import_key: string | null;
	session_import_key: string | null;
	concepts: string | null;
	files_read: string | null;
	files_modified: string | null;
}

export interface DeriveBundle {
	sessionId: number;
	sessionImportKey: string | null;
	sources: CorpusRow[];
	summary: CorpusRow | null;
}

export interface SelectDeriveCorpusOptions {
	createdAtFrom?: string;
	createdAtTo?: string;
	sessionIds?: number[];
	limit?: number;
	extractorVersion?: string;
}

function fromJsonObject(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function jsonList(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

export function selectDeriveCorpus(
	store: MemoryStore,
	opts: SelectDeriveCorpusOptions = {},
): DeriveBundle[] {
	const extractorVersion = opts.extractorVersion ?? DERIVE_EXTRACTOR_VERSION;
	const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
	const createdAtFrom =
		opts.createdAtFrom ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	// Exclude already-derived facts in SQL so the LIMIT is spent on candidate
	// source rows, not previously-created derived facts (which we skip anyway).
	const clauses = [
		"m.active = 1",
		"m.created_at >= ?",
		"COALESCE(json_extract(m.metadata_json, '$.derivation.artifact_class'), '') != 'derived_fact'",
	];
	const params: unknown[] = [createdAtFrom];
	if (opts.createdAtTo) {
		clauses.push("m.created_at <= ?");
		params.push(opts.createdAtTo);
	}
	if (opts.sessionIds && opts.sessionIds.length > 0) {
		clauses.push(`m.session_id IN (${opts.sessionIds.map(() => "?").join(",")})`);
		params.push(...opts.sessionIds);
	}
	const rows = store.db
		.prepare(
			`SELECT m.*, s.import_key AS session_import_key
			 FROM memory_items m
			 LEFT JOIN sessions s ON s.id = m.session_id
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY m.created_at DESC, m.id DESC
			 LIMIT ${limit}`,
		)
		.all(...params) as CorpusRow[];
	const bySession = new Map<number, DeriveBundle>();
	for (const row of rows) {
		const metadata = fromJsonObject(row.metadata_json);
		const derivation =
			metadata.derivation && typeof metadata.derivation === "object"
				? (metadata.derivation as Record<string, unknown>)
				: {};
		if (derivation.artifact_class === "derived_fact") continue;
		if (
			derivation.candidate === false &&
			derivation.evaluated_extractor_version === extractorVersion
		) {
			continue;
		}
		let bundle = bySession.get(row.session_id);
		if (!bundle) {
			bundle = {
				sessionId: row.session_id,
				sessionImportKey: row.session_import_key,
				sources: [],
				summary: null,
			};
			bySession.set(row.session_id, bundle);
		}
		if (row.kind === "session_summary" || metadata.source === "observer_summary")
			bundle.summary = row;
		else bundle.sources.push(row);
	}
	return [...bySession.values()];
}

export interface DeriveClaimsOptions {
	extractorVersion?: string;
	fanOutCap?: number;
}

function durableSentence(text: string): string | null {
	const sentences = text
		.split(/(?<=[.!?])\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
	return (
		sentences.find((sentence) =>
			/\b(?:must|should|shall|requires?|depends? on|relies on|only after|works when|fails when|throws if|source of truth|non-goals?|preferred|look in)\b/i.test(
				sentence,
			),
		) ??
		sentences[0] ??
		null
	);
}

function claimTypeFromReasons(reasons: MemoryWorthinessReason[]): ClaimType {
	if (reasons.includes("troubleshooting_gotcha")) return "gotcha";
	if (reasons.includes("future_actionable_location")) return "locator";
	if (reasons.includes("durable_decision")) return "decision";
	if (reasons.includes("implementation_contract") || reasons.includes("modal_contract"))
		return "contract";
	return "decision";
}

function groundingTokenFor(sentence: string, row: CorpusRow, sourceBodies: string[]): string[] {
	const files = [...jsonList(row.files_modified), ...jsonList(row.files_read)];
	const fileToken = files.find((file) =>
		sourceBodies.some((body) => body.toLowerCase().includes(file.toLowerCase())),
	);
	if (fileToken) return [fileToken];
	const word = sentence.match(/\b[a-z][a-z0-9_-]{4,}\b/i)?.[0];
	return word ? [word] : [];
}

export function deriveClaimsFromBundle(
	bundle: DeriveBundle,
	opts: DeriveClaimsOptions = {},
): DerivedFactInput[] {
	const extractorVersion = opts.extractorVersion ?? DERIVE_EXTRACTOR_VERSION;
	const fanOutCap = opts.fanOutCap ?? 5;
	// Grounding corpus includes titles + bodies (durable content is often in the
	// title, e.g. title "Handlers must return structured errors" / body "Use them").
	const sourceBodies = [
		...bundle.sources.flatMap((row) => [row.title, row.body_text]),
		bundle.summary?.title ?? "",
		bundle.summary?.body_text ?? "",
	].filter(Boolean);
	const candidates = [...bundle.sources, ...(bundle.summary ? [bundle.summary] : [])];
	const claims: DerivedFactInput[] = [];
	for (const row of candidates) {
		if (claims.length >= fanOutCap) break;
		const text = `${row.title}. ${row.body_text}`;
		const metadata = fromJsonObject(row.metadata_json);
		const classifierKind = row.kind === "session_summary" ? "decision" : row.kind;
		const classification = classifyMemoryWorthiness({
			kind: classifierKind,
			title: row.title,
			body_text: row.body_text,
			metadata: row.kind === "session_summary" ? {} : metadata,
		});
		if (classification.artifact !== "derived_fact") continue;
		const sentence = durableSentence(text);
		if (!sentence) continue;
		const mustAppearTokens = groundingTokenFor(sentence, row, sourceBodies);
		if (!groundingTokensPresent({ mustAppearTokens, sourceBodies })) continue;
		const provenanceSources = [
			row,
			...(bundle.summary && bundle.summary.id !== row.id ? [bundle.summary] : []),
		];
		const provenance = reduceProvenance(provenanceSources);
		if (!provenance.ok) continue;
		const concepts = jsonList(row.concepts);
		const filesRead = jsonList(row.files_read);
		const filesModified = jsonList(row.files_modified);
		const claimType = claimTypeFromReasons(classification.reasons);
		const title = sentence.length > 120 ? `${sentence.slice(0, 117).trim()}...` : sentence;
		const scopeKey = computeScopeKey({ filesModified, filesRead, concepts });
		claims.push({
			sessionId: bundle.sessionId,
			kind: kindForClaimType(claimType),
			title,
			bodyText: sentence,
			confidence: 0.7,
			narrative: sentence,
			facts: [sentence],
			concepts,
			filesRead,
			filesModified,
			provenance: provenance.provenance,
			derivation: {
				claim_type: claimType,
				claim_key: computeClaimKey({ claimType, scopeKey, title }),
				extractor_version: extractorVersion,
				source: {
					session_ids: [bundle.sessionId],
					memory_ids: row.kind === "session_summary" ? [] : [row.id],
					summary_memory_id: bundle.summary?.id ?? null,
					session_import_keys: bundle.sessionImportKey ? [bundle.sessionImportKey] : [],
					memory_import_keys:
						row.kind === "session_summary" || !row.import_key ? [] : [row.import_key],
					summary_memory_import_key: bundle.summary?.import_key ?? null,
				},
				grounding: {
					concepts,
					files: [...filesModified, ...filesRead],
					must_appear_tokens: mustAppearTokens,
				},
			},
		});
	}
	return claims;
}

export interface RunDerivePassOptions extends SelectDeriveCorpusOptions, DeriveClaimsOptions {
	dryRun?: boolean;
	skipVectorWrite?: boolean;
}

export interface DeriveRunResult {
	consideredBundles: number;
	consideredClaims: number;
	inserted: number;
	updated: number;
	skipped_tombstone: number;
	skipped_legacy_conflict: number;
	dryRun: boolean;
	results: DerivedFactResult[];
}

export function runDerivePass(
	store: MemoryStore,
	opts: RunDerivePassOptions = {},
): DeriveRunResult {
	const bundles = selectDeriveCorpus(store, opts);
	const result: DeriveRunResult = {
		consideredBundles: bundles.length,
		consideredClaims: 0,
		inserted: 0,
		updated: 0,
		skipped_tombstone: 0,
		skipped_legacy_conflict: 0,
		dryRun: opts.dryRun === true,
		results: [],
	};
	for (const bundle of bundles) {
		const claims = deriveClaimsFromBundle(bundle, opts);
		result.consideredClaims += claims.length;
		for (const claim of claims) {
			if (opts.dryRun) continue;
			const writeResult = store.upsertDerivedFact({
				...claim,
				options: { skipVectorWrite: opts.skipVectorWrite },
			});
			result.results.push(writeResult);
			if (writeResult.outcome === "inserted") result.inserted++;
			else if (writeResult.outcome === "updated") result.updated++;
			else if (writeResult.outcome === "skipped_tombstone") result.skipped_tombstone++;
			else result.skipped_legacy_conflict++;
		}
	}
	return result;
}
