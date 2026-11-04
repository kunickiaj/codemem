/**
 * Viewer target proof. A stale viewer on the configured port would serve
 * operations from its own database with a 2xx, so every HTTP tool call first
 * proves the viewer reports this process's db_path + identity_target.
 *
 * Duplicates the OpenCode plugin's identity keys (runtime.js) — do not import
 * @codemem/core here; thin hosts must not load the native SQLite stack.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
const DEFAULT_EMBEDDING_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
const VIEWER_TARGET_CONFLICT_CODES = new Set([
	"viewer_db_mismatch",
	"viewer_identity_mismatch",
	"viewer_contract_unsupported",
]);
const PROMPT_TRANSPORT_PROTOCOL_RANGE = {
	minSupportedProtocolVersion: 1,
	protocolVersion: 1,
} as const;

export interface ViewerIdentityTarget {
	device_id: string | null;
	actor_id_present: boolean;
	actor_id: string | null;
	config_path: string | null;
	runtime_root: string | null;
	workspace_id: string | null;
	home_dir: string | null;
	pack_compression: string | null;
	embedding_disabled: boolean;
	embedding_offline: boolean;
	embedding_model: string;
	embedding_revision: string | null;
}

export interface ViewerRequestTarget {
	db_path: string;
	identity_target: ViewerIdentityTarget;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function isTruthyFlag(value: string | undefined): boolean {
	return ["1", "true", "yes"].includes(String(value || "").toLowerCase());
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
	if (!value.startsWith("~/")) return value;
	return join(env.HOME?.trim() || homedir(), value.slice(2));
}

function normalizeIdentityPath(
	value: string | undefined,
	cwd: string,
	env: NodeJS.ProcessEnv,
): string | null {
	const trimmed = String(value || "").trim();
	if (!trimmed) return null;
	return resolve(cwd, expandHome(trimmed, env));
}

/** Resolve CODEMEM_DB the same way the OpenCode plugin does. */
export function resolveViewerDbPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.CODEMEM_DB?.trim() || "";
	const expanded = expandHome(raw, env);
	return resolve(cwd, expanded || join(homedir(), ".codemem", "mem.sqlite"));
}

export function buildViewerIdentityTarget(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): ViewerIdentityTarget {
	const embeddingModel = env.CODEMEM_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
	let embeddingRevision = env.CODEMEM_EMBEDDING_REVISION?.trim() || null;
	if (!embeddingRevision && embeddingModel === DEFAULT_EMBEDDING_MODEL) {
		embeddingRevision = DEFAULT_EMBEDDING_REVISION;
	}
	return {
		device_id: env.CODEMEM_DEVICE_ID?.trim() || null,
		actor_id_present: Object.hasOwn(env, "CODEMEM_ACTOR_ID"),
		actor_id: env.CODEMEM_ACTOR_ID?.trim() || null,
		config_path: normalizeIdentityPath(env.CODEMEM_CONFIG, cwd, env),
		runtime_root: normalizeIdentityPath(env.CODEMEM_RUNTIME_ROOT, cwd, env),
		workspace_id: env.CODEMEM_WORKSPACE_ID?.trim() || null,
		home_dir: normalizeIdentityPath(env.HOME || homedir(), cwd, env),
		pack_compression: env.CODEMEM_PACK_COMPRESSION?.trim() || null,
		embedding_disabled: isTruthyFlag(env.CODEMEM_EMBEDDING_DISABLED),
		embedding_offline: isTruthyFlag(env.CODEMEM_EMBEDDING_OFFLINE),
		embedding_model: embeddingModel,
		embedding_revision: embeddingRevision,
	};
}

export function viewerRequestTarget(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): ViewerRequestTarget {
	return {
		db_path: resolveViewerDbPath(cwd, env),
		identity_target: buildViewerIdentityTarget(env, cwd),
	};
}

export function isViewerTargetConflict(status: number, body: unknown): boolean {
	if (status !== 409 || !isRecord(body) || !isRecord(body.error)) return false;
	return VIEWER_TARGET_CONFLICT_CODES.has(String(body.error.code ?? ""));
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		const entries = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizeProtocolRange(
	protocolVersion: unknown,
	minSupportedProtocolVersion?: unknown,
): { minSupportedProtocolVersion: number; protocolVersion: number } | null {
	if (!Number.isSafeInteger(protocolVersion) || Number(protocolVersion) < 1) return null;
	const minimum =
		minSupportedProtocolVersion === undefined ? protocolVersion : minSupportedProtocolVersion;
	const minimumIsValid =
		Number.isSafeInteger(minimum) &&
		Number(minimum) >= 1 &&
		Number(minimum) <= Number(protocolVersion);
	if (!minimumIsValid) return null;
	return {
		minSupportedProtocolVersion: Number(minimum),
		protocolVersion: Number(protocolVersion),
	};
}

/** Capabilities a viewer advertises in its prompt-pack profile; absent on older viewers. */
export function viewerCapabilities(profile: unknown): ReadonlySet<string> {
	if (!isRecord(profile) || !Array.isArray(profile.capabilities)) return new Set();
	return new Set(
		profile.capabilities.filter((entry): entry is string => typeof entry === "string"),
	);
}

export function profileMatchesViewerTarget(
	profile: unknown,
	dbPath: string,
	identity: unknown,
): boolean {
	if (!isRecord(profile) || profile.service !== "codemem-viewer") return false;
	const range = normalizeProtocolRange(
		profile.protocol_version,
		profile.min_supported_protocol_version,
	);
	if (!range) return false;
	const incompatible =
		PROMPT_TRANSPORT_PROTOCOL_RANGE.minSupportedProtocolVersion > range.protocolVersion ||
		range.minSupportedProtocolVersion > PROMPT_TRANSPORT_PROTOCOL_RANGE.protocolVersion;
	if (incompatible) return false;
	if (profile.db_path !== dbPath) return false;
	return canonicalJson(profile.identity_target) === canonicalJson(identity);
}
