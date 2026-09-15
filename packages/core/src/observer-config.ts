/**
 * OpenCode provider configuration loading and resolution.
 *
 * Mirrors codemem/observer_config.py — reads ~/.config/opencode/opencode.json{c},
 * resolves custom provider settings (base URL, headers, API keys), and expands
 * environment variable / file placeholders in config values.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fchownSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { codememHomeDir } from "./home.js";

// ---------------------------------------------------------------------------
// JSONC helpers
// ---------------------------------------------------------------------------

/** Strip JavaScript-style `//` line comments and `/* ... *​/` block comments from JSONC text. */
export function stripJsonComments(text: string): string {
	const result: string[] = [];
	let inString = false;
	let escapeNext = false;
	for (let i = 0; i < text.length; i++) {
		const char = text.charAt(i);
		if (escapeNext) {
			result.push(char);
			escapeNext = false;
			continue;
		}
		if (char === "\\" && inString) {
			result.push(char);
			escapeNext = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			result.push(char);
			continue;
		}
		if (!inString && char === "/" && i + 1 < text.length) {
			const next = text.charAt(i + 1);
			if (next === "/") {
				// Line comment — skip until newline
				let j = i + 2;
				while (j < text.length && text.charAt(j) !== "\n") j++;
				i = j - 1; // outer loop will increment
				continue;
			}
			if (next === "*") {
				// Block comment — skip until */
				let j = i + 2;
				while (j < text.length - 1) {
					if (text.charAt(j) === "*" && text.charAt(j + 1) === "/") {
						j += 2;
						break;
					}
					j++;
				}
				i = j - 1; // outer loop will increment
				continue;
			}
		}
		result.push(char);
	}
	return result.join("");
}

/** Remove trailing commas before `]` or `}` (outside strings). */
export function stripTrailingCommas(text: string): string {
	const result: string[] = [];
	let inString = false;
	let escapeNext = false;
	for (let i = 0; i < text.length; i++) {
		const char = text.charAt(i);
		if (escapeNext) {
			result.push(char);
			escapeNext = false;
			continue;
		}
		if (char === "\\" && inString) {
			result.push(char);
			escapeNext = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			result.push(char);
			continue;
		}
		if (!inString && char === ",") {
			// Look ahead past whitespace for a closing bracket/brace
			let j = i + 1;
			while (j < text.length && /\s/.test(text.charAt(j))) j++;
			if (j < text.length && (text.charAt(j) === "]" || text.charAt(j) === "}")) {
				continue; // skip the trailing comma
			}
		}
		result.push(char);
	}
	return result.join("");
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/** Load OpenCode config from `~/.config/opencode/opencode.json{c}`. */
export function loadOpenCodeConfig(): Record<string, unknown> {
	const configDir = join(codememHomeDir(), ".config", "opencode");
	const candidates = [join(configDir, "opencode.json"), join(configDir, "opencode.jsonc")];

	const configPath = candidates.find((p) => existsSync(p));
	if (!configPath) return {};

	let text: string;
	try {
		text = readFileSync(configPath, "utf-8");
	} catch {
		return {};
	}

	// Try plain JSON first
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		// fall through to JSONC
	}

	try {
		const cleaned = stripTrailingCommas(stripJsonComments(text));
		return JSON.parse(cleaned) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Expand `~/...` paths like Python's `Path(...).expanduser()`. */
export function expandUserPath(value: string): string {
	return value.startsWith("~/") ? join(codememHomeDir(), value.slice(2)) : value;
}

function isSafeWorkspaceId(value: string): boolean {
	return /^[A-Za-z0-9._:-]+$/.test(value) && !/^\.+$/.test(value);
}

export function getWorkspaceCodememConfigPath(workspaceId: string): string {
	const trimmed = workspaceId.trim();
	if (!trimmed || !isSafeWorkspaceId(trimmed)) {
		throw new Error(`Invalid workspace id for config path: ${workspaceId}`);
	}
	return join(codememHomeDir(), ".codemem", "workspaces", trimmed, "config", "codemem.json");
}

export function getWorkspaceScopedCodememConfigPath(): string | null {
	const runtimeRoot = process.env.CODEMEM_RUNTIME_ROOT?.trim();
	if (runtimeRoot) {
		const expandedRoot = expandUserPath(runtimeRoot);
		if (isAbsolute(expandedRoot)) {
			return join(expandedRoot, "config", "codemem.json");
		}
		// Invalid/relative runtime root — fall through to workspace-id lookup
	}

	const workspaceId = process.env.CODEMEM_WORKSPACE_ID?.trim();
	if (!workspaceId) return null;
	if (!isSafeWorkspaceId(workspaceId)) return null;
	return getWorkspaceCodememConfigPath(workspaceId);
}

function getLegacyCodememConfigPath(): string {
	const configDir = join(codememHomeDir(), ".config", "codemem");
	const candidates = [join(configDir, "config.json"), join(configDir, "config.jsonc")];
	return candidates.find((p) => existsSync(p)) ?? join(configDir, "config.json");
}

function getCodememConfigWritePath(): string {
	return resolveCodememConfigPath(undefined, "write").resolved.path;
}

export function readWorkspaceCodememConfigFile(workspaceId: string): Record<string, unknown> {
	return readCodememConfigFileAtPath(getWorkspaceCodememConfigPath(workspaceId));
}

/** Env var overrides matching Python's CONFIG_ENV_OVERRIDES. */
export const CODEMEM_CONFIG_ENV_OVERRIDES: Record<string, string> = {
	actor_id: "CODEMEM_ACTOR_ID",
	actor_display_name: "CODEMEM_ACTOR_DISPLAY_NAME",
	claude_command: "CODEMEM_CLAUDE_COMMAND",
	codex_command: "CODEMEM_CODEX_COMMAND",
	observer_provider: "CODEMEM_OBSERVER_PROVIDER",
	observer_model: "CODEMEM_OBSERVER_MODEL",
	observer_temperature: "CODEMEM_OBSERVER_TEMPERATURE",
	observer_reasoning_effort: "CODEMEM_OBSERVER_REASONING_EFFORT",
	observer_reasoning_summary: "CODEMEM_OBSERVER_REASONING_SUMMARY",
	observer_tier_routing_enabled: "CODEMEM_OBSERVER_TIER_ROUTING_ENABLED",
	observer_simple_model: "CODEMEM_OBSERVER_SIMPLE_MODEL",
	observer_simple_temperature: "CODEMEM_OBSERVER_SIMPLE_TEMPERATURE",
	observer_rich_model: "CODEMEM_OBSERVER_RICH_MODEL",
	observer_rich_temperature: "CODEMEM_OBSERVER_RICH_TEMPERATURE",
	observer_rich_reasoning_effort: "CODEMEM_OBSERVER_RICH_REASONING_EFFORT",
	observer_rich_reasoning_summary: "CODEMEM_OBSERVER_RICH_REASONING_SUMMARY",
	observer_rich_max_output_tokens: "CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS",
	observer_output_mode: "CODEMEM_OBSERVER_OUTPUT_MODE",
	observer_base_url: "CODEMEM_OBSERVER_BASE_URL",
	observer_runtime: "CODEMEM_OBSERVER_RUNTIME",
	observer_auth_source: "CODEMEM_OBSERVER_AUTH_SOURCE",
	observer_auth_file: "CODEMEM_OBSERVER_AUTH_FILE",
	observer_auth_command: "CODEMEM_OBSERVER_AUTH_COMMAND",
	observer_auth_timeout_ms: "CODEMEM_OBSERVER_AUTH_TIMEOUT_MS",
	observer_auth_cache_ttl_s: "CODEMEM_OBSERVER_AUTH_CACHE_TTL_S",
	observer_headers: "CODEMEM_OBSERVER_HEADERS",
	observer_max_chars: "CODEMEM_OBSERVER_MAX_CHARS",
	pack_observation_limit: "CODEMEM_PACK_OBSERVATION_LIMIT",
	pack_session_limit: "CODEMEM_PACK_SESSION_LIMIT",
	sync_enabled: "CODEMEM_SYNC_ENABLED",
	sync_device_name: "CODEMEM_SYNC_DEVICE_NAME",
	sync_host: "CODEMEM_SYNC_HOST",
	sync_port: "CODEMEM_SYNC_PORT",
	sync_interval_s: "CODEMEM_SYNC_INTERVAL_S",
	sync_mdns: "CODEMEM_SYNC_MDNS",
	sync_advertise: "CODEMEM_SYNC_ADVERTISE",
	sync_coordinator_url: "CODEMEM_SYNC_COORDINATOR_URL",
	sync_coordinator_group: "CODEMEM_SYNC_COORDINATOR_GROUP",
	sync_coordinator_groups: "CODEMEM_SYNC_COORDINATOR_GROUPS",
	sync_coordinator_timeout_s: "CODEMEM_SYNC_COORDINATOR_TIMEOUT_S",
	sync_coordinator_presence_ttl_s: "CODEMEM_SYNC_COORDINATOR_PRESENCE_TTL_S",
	sync_coordinator_admin_secret: "CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
	sync_retention_enabled: "CODEMEM_SYNC_RETENTION_ENABLED",
	sync_retention_max_age_days: "CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS",
	sync_retention_max_size_mb: "CODEMEM_SYNC_RETENTION_MAX_SIZE_MB",
	sync_retention_interval_s: "CODEMEM_SYNC_RETENTION_INTERVAL_S",
	sync_retention_max_runtime_ms: "CODEMEM_SYNC_RETENTION_MAX_RUNTIME_MS",
	sync_retention_max_ops_per_pass: "CODEMEM_SYNC_RETENTION_MAX_OPS_PER_PASS",
	sync_projects_include: "CODEMEM_SYNC_PROJECTS_INCLUDE",
	sync_projects_exclude: "CODEMEM_SYNC_PROJECTS_EXCLUDE",
	sync_ops_limit: "CODEMEM_SYNC_OPS_LIMIT",
	raw_events_sweeper_interval_s: "CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_S",
	raw_events_retention_enabled: "CODEMEM_RAW_EVENTS_RETENTION_ENABLED",
	raw_events_retention_max_age_days: "CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS",
};

/** Normalize a configured sidecar command from argv or a shell-style string. */
export function coerceObserverCommand(value: unknown): string[] | null {
	if (value == null) return null;
	if (Array.isArray(value)) {
		const parts = value.filter((item): item is string => {
			return typeof item === "string" && item.trim() !== "";
		});
		return parts.length > 0 ? parts : null;
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
			const parts = parsed.filter((item) => item.trim() !== "");
			return parts.length > 0 ? parts : null;
		}
	} catch {
		// Non-JSON command strings use the same whitespace splitting as existing config.
	}
	const parts = trimmed.split(/\s+/).filter((item) => item !== "");
	return parts.length > 0 ? parts : null;
}

// ---------------------------------------------------------------------------
// Unified config path resolver with full traceability
// ---------------------------------------------------------------------------

export type ConfigPathSource =
	| "cli-flag"
	| "env-codemem-config"
	| "env-runtime-root"
	| "env-workspace-id"
	| "legacy-global";

export interface ConfigPathResolution {
	path: string;
	source: ConfigPathSource;
	reason: string;
	exists: boolean;
	/** Whether this candidate is structurally valid (absolute path, safe workspace id, etc.). */
	valid: boolean;
}

export interface ConfigResolutionResult {
	resolved: ConfigPathResolution;
	fallbackChain: ConfigPathResolution[];
}

/**
 * Resolve the codemem config path with full traceability.
 *
 * Every candidate in the precedence chain is evaluated and recorded.
 * The `resolved` field is the winner; `fallbackChain` holds all rejected candidates
 * with a reason string explaining why each was skipped.
 *
 * @param cliConfigPath - explicit --config flag value (highest precedence)
 * @param mode - 'read' checks existence and falls back; 'write' takes first match
 */
export function resolveCodememConfigPath(
	cliConfigPath?: string,
	mode: "read" | "write" = "read",
): ConfigResolutionResult {
	const candidates: ConfigPathResolution[] = [];

	// 1. CLI flag (highest precedence)
	if (cliConfigPath?.trim()) {
		const path = expandUserPath(cliConfigPath.trim());
		candidates.push({
			path,
			source: "cli-flag",
			reason: `--config ${cliConfigPath}`,
			exists: existsSync(path),
			valid: true,
		});
	}

	// 2. CODEMEM_CONFIG env
	const envConfig = process.env.CODEMEM_CONFIG?.trim();
	if (envConfig) {
		const path = expandUserPath(envConfig);
		candidates.push({
			path,
			source: "env-codemem-config",
			reason: `CODEMEM_CONFIG='${envConfig}'`,
			exists: existsSync(path),
			valid: true,
		});
	}

	// 3. CODEMEM_RUNTIME_ROOT env (must be absolute after expandUser)
	const runtimeRoot = process.env.CODEMEM_RUNTIME_ROOT?.trim();
	if (runtimeRoot) {
		const expandedRoot = expandUserPath(runtimeRoot);
		const absolute = isAbsolute(expandedRoot);
		const path = join(expandedRoot, "config", "codemem.json");
		candidates.push({
			path,
			source: "env-runtime-root",
			reason: absolute
				? `CODEMEM_RUNTIME_ROOT='${runtimeRoot}'`
				: `CODEMEM_RUNTIME_ROOT='${runtimeRoot}' is relative, not absolute`,
			exists: absolute ? existsSync(path) : false,
			valid: absolute,
		});
	}

	// 4. CODEMEM_WORKSPACE_ID env (must pass isSafeWorkspaceId)
	const workspaceId = process.env.CODEMEM_WORKSPACE_ID?.trim();
	if (workspaceId) {
		const safe = isSafeWorkspaceId(workspaceId);
		const path = safe
			? getWorkspaceCodememConfigPath(workspaceId)
			: join(codememHomeDir(), ".codemem", "workspaces", workspaceId, "config", "codemem.json");
		candidates.push({
			path,
			source: "env-workspace-id",
			reason: safe
				? `CODEMEM_WORKSPACE_ID='${workspaceId}'`
				: `CODEMEM_WORKSPACE_ID='${workspaceId}' failed safety check`,
			exists: safe ? existsSync(path) : false,
			valid: safe,
		});
	}

	// 5. Legacy global config (~/.config/codemem/config.json{c})
	const legacyPath = getLegacyCodememConfigPath();
	candidates.push({
		path: legacyPath,
		source: "legacy-global",
		reason: "legacy global config",
		exists: existsSync(legacyPath),
		valid: true,
	});

	// Explicit overrides (cli-flag, env-codemem-config) are authoritative:
	// they win in both read and write mode regardless of file existence.
	// This matches the original getCodememConfigPath behavior where
	// CODEMEM_CONFIG is returned immediately without an existence check.
	const isAuthoritative = (c: ConfigPathResolution): boolean =>
		c.source === "cli-flag" || c.source === "env-codemem-config";

	// Select the winner based on mode.
	// Validity is determined structurally via the `valid` flag on each candidate,
	// not by inspecting the `reason` string.
	let resolvedIndex: number;
	if (mode === "write") {
		// Write mode: first valid candidate regardless of existence
		resolvedIndex = candidates.findIndex((c) => c.valid);
	} else {
		// Read mode: authoritative sources win immediately; otherwise first existing candidate
		const authoritativeIndex = candidates.findIndex((c) => isAuthoritative(c) && c.valid);
		if (authoritativeIndex >= 0) {
			resolvedIndex = authoritativeIndex;
		} else {
			const existingIndex = candidates.findIndex((c) => c.valid && c.exists);
			// If none exist, fall back to first valid candidate (matches getCodememConfigPath behavior)
			resolvedIndex = existingIndex >= 0 ? existingIndex : candidates.findIndex((c) => c.valid);
		}
	}

	// Should always find at least the legacy candidate, but guard anyway
	if (resolvedIndex < 0) resolvedIndex = candidates.length - 1;

	const resolved = candidates[resolvedIndex] ?? candidates[candidates.length - 1];
	if (!resolved) {
		throw new Error("No config path candidates were generated");
	}
	const fallbackChain = candidates.filter((_, i) => i !== resolvedIndex);

	// Annotate skipped candidates with why they were not selected
	for (const entry of fallbackChain) {
		if (entry.source === "env-runtime-root" && entry.reason.includes("is relative")) {
			// Already has a descriptive reason
		} else if (
			entry.source === "env-workspace-id" &&
			entry.reason.includes("failed safety check")
		) {
			// Already has a descriptive reason
		} else if (mode === "read" && !entry.exists) {
			entry.reason += " (does not exist)";
		}
	}

	return { resolved, fallbackChain };
}

/**
 * Resolve codemem config path with precedence:
 * 1. explicit CODEMEM_CONFIG override
 * 2. workspace-scoped config via CODEMEM_RUNTIME_ROOT or CODEMEM_WORKSPACE_ID
 * 3. legacy global config under ~/.config/codemem/
 */
export function getCodememConfigPath(): string {
	return resolveCodememConfigPath(undefined, "read").resolved.path;
}

/** Read codemem config file with the same JSON/JSONC behavior as Python. */
export function readCodememConfigFile(): Record<string, unknown> {
	const configPath = getCodememConfigPath();
	return readCodememConfigFileAtPath(configPath);
}

export function readCodememConfigFileAtPath(configPath: string): Record<string, unknown> {
	const resolvedPath = expandUserPath(configPath);
	if (!existsSync(resolvedPath)) return {};

	let text: string;
	try {
		text = readFileSync(resolvedPath, "utf-8");
	} catch {
		return {};
	}

	if (!text.trim()) return {};

	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// fall through to JSONC
	}

	try {
		const cleaned = stripTrailingCommas(stripJsonComments(text));
		const parsed = JSON.parse(cleaned) as unknown;
		return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export type CodememConfigReadOutcome =
	| { status: "missing"; path: string; revision: "missing" }
	| {
			status: "valid";
			path: string;
			data: Record<string, unknown>;
			revision: string;
			mode: number;
			uid: number;
			gid: number;
	  }
	| { status: "invalid"; path: string; reason: "empty" | "non_object" | "parse_error" }
	| { status: "unreadable"; path: string };

export type CodememConfigMutationResult = {
	path: string;
	mutationPath: string;
	data: Record<string, unknown>;
	revision: string;
};

type ConfigFileMetadata = { mode: number; uid: number; gid: number };

export class CodememConfigMutationError extends Error {
	readonly code: "busy" | "changed" | "invalid" | "unreadable";

	constructor(code: CodememConfigMutationError["code"], message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CodememConfigMutationError";
		this.code = code;
	}
}

type AtomicConfigFileOperations = {
	open: typeof openSync;
	close: typeof closeSync;
	chown?: typeof fchownSync;
	chmod: typeof fchmodSync;
	sync: typeof fsyncSync;
	write: typeof writeFileSync;
	rename: typeof renameSync;
	unlink: typeof unlinkSync;
};

type ConfigLockCleanupOperations = Pick<AtomicConfigFileOperations, "close" | "unlink">;

const atomicConfigFileOperations: AtomicConfigFileOperations = {
	open: openSync,
	close: closeSync,
	chown: fchownSync,
	chmod: fchmodSync,
	sync: fsyncSync,
	write: writeFileSync,
	rename: renameSync,
	unlink: unlinkSync,
};

const configLockCleanupOperations: ConfigLockCleanupOperations = {
	close: closeSync,
	unlink: unlinkSync,
};

function configRevision(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function parseConfigText(
	text: string,
):
	| { status: "valid"; data: Record<string, unknown> }
	| { status: "invalid"; reason: "empty" | "non_object" | "parse_error" } {
	if (!text.trim()) return { status: "invalid", reason: "empty" };
	for (const candidate of [text, stripTrailingCommas(stripJsonComments(text))]) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
				return { status: "valid", data: parsed as Record<string, unknown> };
			}
			return { status: "invalid", reason: "non_object" };
		} catch {
			// Try JSONC before reporting invalid syntax.
		}
	}
	return { status: "invalid", reason: "parse_error" };
}

/** Read a config for mutation without treating damaged input as an empty object. */
export function readCodememConfigFileForMutation(configPath?: string): CodememConfigReadOutcome {
	const path = configPath ? expandUserPath(configPath) : getCodememConfigWritePath();
	if (!existsSync(path)) return { status: "missing", path, revision: "missing" };
	let text: string;
	let metadata: { mode: number; uid: number; gid: number };
	try {
		text = readFileSync(path, "utf8");
		const stats = statSync(path);
		metadata = { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
	} catch {
		return { status: "unreadable", path };
	}
	const parsed = parseConfigText(text);
	if (parsed.status === "invalid") return { ...parsed, path };
	return { ...parsed, path, revision: configRevision(text), ...metadata };
}

function unlinkIfPresent(path: string, unlink: typeof unlinkSync): void {
	try {
		unlink(path);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "";
		if (code !== "ENOENT") throw error;
	}
}

function cleanupReplacementTempFile(
	tempPath: string,
	unlink: typeof unlinkSync,
	renameCommitted: boolean,
): void {
	try {
		unlinkIfPresent(tempPath, unlink);
	} catch (error) {
		if (!renameCommitted) throw error;
	}
}

function resolveConfigMutationTarget(path: string): string {
	const seen = new Set<string>();
	let current = path;
	while (true) {
		if (seen.has(current)) {
			throw new CodememConfigMutationError(
				"unreadable",
				`Cannot update config because ${path} contains a symbolic-link cycle.`,
			);
		}
		seen.add(current);
		try {
			return realpathSync(current);
		} catch {
			// Follow broken link chains until reaching the intended missing target.
		}
		try {
			if (lstatSync(current).isSymbolicLink()) {
				const target = readlinkSync(current);
				current = isAbsolute(target) ? target : resolve(dirname(current), target);
				continue;
			}
			return current;
		} catch {
			try {
				return join(realpathSync(dirname(current)), basename(current));
			} catch {
				return current;
			}
		}
	}
}

function syncConfigDirectory(targetPath: string, operations: AtomicConfigFileOperations): void {
	let directoryFd: number | null = null;
	try {
		directoryFd = operations.open(dirname(targetPath), "r");
		operations.sync(directoryFd);
	} catch {
		// The rename already committed. Directory sync is best-effort on filesystems
		// that reject or fail it, so callers must not mistake this for an uncommitted save.
	} finally {
		if (directoryFd != null) {
			try {
				operations.close(directoryFd);
			} catch {
				// Closing after a committed rename cannot safely turn success into failure.
			}
		}
	}
}

/** Internal fault-injection seam used by config persistence tests. */
export function atomicReplaceConfigFile(
	targetPath: string,
	text: string,
	metadata: ConfigFileMetadata | number | undefined,
	operations: AtomicConfigFileOperations = atomicConfigFileOperations,
	verifyBeforeRename?: () => void,
): void {
	const replacementPath = resolveConfigMutationTarget(targetPath);
	const tempPath = `${replacementPath}.tmp-${process.pid}-${randomUUID()}`;
	let tempFd: number | null = null;
	let renameCommitted = false;
	try {
		const mode = typeof metadata === "number" ? metadata : metadata?.mode;
		tempFd = operations.open(tempPath, "wx", mode ?? 0o600);
		if (typeof metadata === "object" && process.platform !== "win32") {
			operations.chown?.(tempFd, metadata.uid, metadata.gid);
		}
		if (mode != null) operations.chmod(tempFd, mode);
		operations.write(tempFd, text, "utf8");
		operations.sync(tempFd);
		const completedFd = tempFd;
		tempFd = null;
		operations.close(completedFd);
		verifyBeforeRename?.();
		operations.rename(tempPath, replacementPath);
		renameCommitted = true;
		syncConfigDirectory(replacementPath, operations);
	} finally {
		try {
			if (tempFd != null) operations.close(tempFd);
		} finally {
			cleanupReplacementTempFile(tempPath, operations.unlink, renameCommitted);
		}
	}
}

function assertMutationInput(outcome: CodememConfigReadOutcome): Record<string, unknown> {
	if (outcome.status === "missing") return {};
	if (outcome.status === "valid") return outcome.data;
	if (outcome.status === "unreadable") {
		throw new CodememConfigMutationError(
			"unreadable",
			`Cannot update config because ${outcome.path} could not be read.`,
		);
	}
	throw new CodememConfigMutationError(
		"invalid",
		`Cannot update config because ${outcome.path} is not a valid JSON object.`,
	);
}

function currentRevision(path: string): string | "missing" | "unreadable" {
	if (!existsSync(path)) return "missing";
	try {
		return configRevision(readFileSync(path, "utf8"));
	} catch {
		return "unreadable";
	}
}

function currentMetadata(path: string): ConfigFileMetadata | "missing" | "unreadable" {
	if (!existsSync(path)) return "missing";
	try {
		const stats = statSync(path);
		return { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
	} catch {
		return "unreadable";
	}
}

function configMetadataMatches(
	current: ReturnType<typeof currentMetadata>,
	expected: ConfigFileMetadata,
): boolean {
	return (
		typeof current !== "string" &&
		current.mode === expected.mode &&
		current.uid === expected.uid &&
		current.gid === expected.gid
	);
}

function configMetadata(outcome: CodememConfigReadOutcome): ConfigFileMetadata | undefined {
	if (outcome.status !== "valid") return undefined;
	return { mode: outcome.mode, uid: outcome.uid, gid: outcome.gid };
}

function acquireConfigLock(targetPath: string): { fd: number; path: string } {
	const path = `${targetPath}.lock`;
	try {
		return { fd: openSync(path, "wx", 0o600), path };
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "";
		if (code === "EEXIST") {
			throw new CodememConfigMutationError(
				"busy",
				`Cannot update config because another writer is updating ${targetPath}. Retry the save; if no save is active, remove the stale lock at ${path}.`,
				{ cause: error },
			);
		}
		throw new CodememConfigMutationError(
			"unreadable",
			`Cannot update config because its writer lock could not be created at ${path}.`,
			{ cause: error },
		);
	}
}

function releaseConfigLock(
	lock: { fd: number; path: string },
	operations: ConfigLockCleanupOperations,
): void {
	let firstError: unknown;
	try {
		operations.close(lock.fd);
	} catch (error) {
		firstError = error;
	}
	try {
		unlinkIfPresent(lock.path, operations.unlink);
	} catch (error) {
		firstError ??= error;
	}
	if (firstError !== undefined) throw firstError;
}

function releaseConfigLocks(
	locks: Array<{ fd: number; path: string }>,
	operations: ConfigLockCleanupOperations = configLockCleanupOperations,
): void {
	let firstError: unknown;
	for (const lock of locks.reverse()) {
		try {
			releaseConfigLock(lock, operations);
		} catch (error) {
			firstError ??= error;
		}
	}
	if (firstError !== undefined) throw firstError;
}

function releaseConfigLocksAfterMutation(
	locks: Array<{ fd: number; path: string }>,
	committed: boolean,
	operations: ConfigLockCleanupOperations,
): void {
	try {
		releaseConfigLocks(locks, operations);
	} catch (error) {
		if (!committed) throw error;
	}
}

function acquireConfigLocks(targetPaths: string[]): Array<{ fd: number; path: string }> {
	const orderedPaths = [...new Set(targetPaths)].sort((left, right) => {
		if (left < right) return -1;
		if (left > right) return 1;
		return 0;
	});
	const locks: Array<{ fd: number; path: string }> = [];
	try {
		for (const path of orderedPaths) {
			mkdirSync(dirname(path), { recursive: true });
			locks.push(acquireConfigLock(path));
		}
		return locks;
	} catch (error) {
		try {
			releaseConfigLocks(locks);
		} catch {
			// Preserve the acquisition failure after attempting every cleanup.
		}
		throw error;
	}
}

type ConfigMutationOptions = {
	expectedMutationPath?: string;
	expectedRevision?: string;
	fallbackReadPath?: string;
	lockCleanupOperations?: ConfigLockCleanupOperations;
};

function acquireConfigMutationLocks(
	targetPath: string,
	usesImplicitPath: boolean,
	options: ConfigMutationOptions,
): {
	preliminaryTarget: CodememConfigReadOutcome;
	fallbackReadPath: string | undefined;
	targetMutationPath: string;
	fallbackMutationPath: string | undefined;
	locks: Array<{ fd: number; path: string }>;
} {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const preliminaryTarget = readCodememConfigFileForMutation(targetPath);
		const fallbackReadPath =
			options.fallbackReadPath ?? (usesImplicitPath ? getCodememConfigPath() : undefined);
		const targetMutationPath = options.expectedMutationPath
			? expandUserPath(options.expectedMutationPath)
			: resolveConfigMutationTarget(targetPath);
		const fallbackMutationPath =
			preliminaryTarget.status === "missing" && fallbackReadPath != null
				? resolveConfigMutationTarget(expandUserPath(fallbackReadPath))
				: undefined;
		const locks = acquireConfigLocks([targetMutationPath]);
		const targetIdentityStable = resolveConfigMutationTarget(targetPath) === targetMutationPath;
		const fallbackIdentityStable =
			fallbackMutationPath === undefined ||
			resolveConfigMutationTarget(expandUserPath(fallbackReadPath ?? targetPath)) ===
				fallbackMutationPath;
		if (targetIdentityStable && fallbackIdentityStable) {
			return {
				preliminaryTarget,
				fallbackReadPath,
				targetMutationPath,
				fallbackMutationPath,
				locks,
			};
		}
		releaseConfigLocks(locks);
	}
	throw new CodememConfigMutationError(
		"changed",
		`Cannot update config because ${targetPath} changed before the save. Retry the save.`,
	);
}

function assertTargetDidNotDisappear(
	preliminaryTarget: CodememConfigReadOutcome,
	outcome: CodememConfigReadOutcome,
	targetPath: string,
): void {
	if (preliminaryTarget.status === "missing" || outcome.status !== "missing") return;
	throw new CodememConfigMutationError(
		"changed",
		`Cannot update config because ${targetPath} changed before the save. Retry the save.`,
	);
}

function mutationInputOutcome(
	target: CodememConfigReadOutcome,
	targetPath: string,
	fallbackReadPath: string | undefined,
): CodememConfigReadOutcome {
	if (target.status !== "missing") return target;
	const readPath = fallbackReadPath ?? targetPath;
	return readPath === targetPath ? target : readCodememConfigFileForMutation(readPath);
}

function verifyConfigMutation(input: {
	targetPath: string;
	targetMutationPath: string;
	expectedRevision: string;
	expectedMetadata: ConfigFileMetadata | undefined;
	fallbackReadPath: string | undefined;
	fallbackMutationPath: string | undefined;
	inputOutcome: CodememConfigReadOutcome;
	inputRevision: string;
}): void {
	if (
		resolveConfigMutationTarget(input.targetPath) !== input.targetMutationPath ||
		currentRevision(input.targetMutationPath) !== input.expectedRevision ||
		(input.expectedMetadata !== undefined &&
			!configMetadataMatches(currentMetadata(input.targetMutationPath), input.expectedMetadata))
	) {
		throw new CodememConfigMutationError(
			"changed",
			`Cannot update config because ${input.targetPath} changed during the save. Retry the save.`,
		);
	}
	if (
		input.fallbackMutationPath !== undefined &&
		resolveConfigMutationTarget(expandUserPath(input.fallbackReadPath ?? input.targetPath)) !==
			input.fallbackMutationPath
	) {
		throw new CodememConfigMutationError(
			"changed",
			`Cannot update config because ${input.fallbackReadPath} changed during the save. Retry the save.`,
		);
	}
	if (
		input.inputOutcome.path !== input.targetMutationPath &&
		currentRevision(input.inputOutcome.path) !== input.inputRevision
	) {
		throw new CodememConfigMutationError(
			"changed",
			`Cannot update config because ${input.inputOutcome.path} changed during the save. Retry the save.`,
		);
	}
}

function assertExpectedRevision(targetPath: string, actual: string, expected?: string): void {
	if (expected == null || actual === expected) return;
	throw new CodememConfigMutationError(
		"changed",
		`Cannot update config because ${targetPath} changed before the save. Retry the save.`,
	);
}

/** Serialize a read-modify-write config update across cooperating processes. */
export function mutateCodememConfigFile(
	mutator: (
		data: Record<string, unknown>,
		outcome: CodememConfigReadOutcome,
	) => Record<string, unknown> | undefined,
	configPath?: string,
	options: ConfigMutationOptions = {},
): CodememConfigMutationResult {
	const targetPath = configPath ? expandUserPath(configPath) : getCodememConfigWritePath();
	const { preliminaryTarget, fallbackReadPath, targetMutationPath, fallbackMutationPath, locks } =
		acquireConfigMutationLocks(targetPath, configPath == null, options);
	let committed = false;
	try {
		const outcome = readCodememConfigFileForMutation(targetMutationPath);
		assertTargetDidNotDisappear(preliminaryTarget, outcome, targetPath);
		const readPath = fallbackMutationPath ?? fallbackReadPath;
		const inputOutcome = mutationInputOutcome(outcome, targetMutationPath, readPath);
		const expectedRevision = outcome.status === "valid" ? outcome.revision : "missing";
		assertExpectedRevision(targetPath, expectedRevision, options.expectedRevision);
		const current = { ...assertMutationInput(inputOutcome) };
		const data = mutator(current, outcome);
		if (data === undefined) {
			return {
				path: targetPath,
				mutationPath: targetMutationPath,
				data: current,
				revision: expectedRevision,
			};
		}
		const inputRevision =
			inputOutcome.status === "valid" ? inputOutcome.revision : inputOutcome.status;
		const text = `${JSON.stringify(data, null, 2)}\n`;
		atomicReplaceConfigFile(
			targetMutationPath,
			text,
			configMetadata(outcome),
			atomicConfigFileOperations,
			() =>
				verifyConfigMutation({
					targetPath,
					targetMutationPath,
					expectedRevision,
					expectedMetadata: configMetadata(outcome),
					fallbackReadPath,
					fallbackMutationPath,
					inputOutcome,
					inputRevision,
				}),
		);
		committed = true;
		return {
			path: targetPath,
			mutationPath: targetMutationPath,
			data,
			revision: configRevision(text),
		};
	} finally {
		releaseConfigLocksAfterMutation(
			locks,
			committed,
			options.lockCleanupOperations ?? configLockCleanupOperations,
		);
	}
}

/** Delete a config only when it still has the expected revision. */
export function deleteCodememConfigFile(
	configPath: string,
	expectedRevision: string,
	expectedMutationPath?: string,
	lockCleanupOperations: ConfigLockCleanupOperations = configLockCleanupOperations,
): void {
	const targetPath = expandUserPath(configPath);
	const replacementPath = expectedMutationPath ?? resolveConfigMutationTarget(targetPath);
	const lock = acquireConfigLock(replacementPath);
	let committed = false;
	try {
		if (
			resolveConfigMutationTarget(targetPath) !== replacementPath ||
			currentRevision(replacementPath) !== expectedRevision
		) {
			throw new CodememConfigMutationError(
				"changed",
				`Cannot restore config because ${targetPath} changed after the save.`,
			);
		}
		unlinkSync(replacementPath);
		committed = true;
		syncConfigDirectory(replacementPath, atomicConfigFileOperations);
	} finally {
		releaseConfigLocksAfterMutation([lock], committed, lockCleanupOperations);
	}
}

/** Persist the codemem config file as normalized JSON using atomic replacement. */
export function writeCodememConfigFile(data: Record<string, unknown>, configPath?: string): string {
	return mutateCodememConfigFile(() => data, configPath).path;
}

export function writeWorkspaceCodememConfigFile(
	workspaceId: string,
	data: Record<string, unknown>,
): string {
	return writeCodememConfigFile(data, getWorkspaceCodememConfigPath(workspaceId));
}

/** Return active env overrides for codemem config keys. */
export function getCodememEnvOverrides(): Record<string, string> {
	const overrides: Record<string, string> = {};
	for (const [key, envVar] of Object.entries(CODEMEM_CONFIG_ENV_OVERRIDES)) {
		const val = process.env[envVar];
		if (val != null && val !== "") overrides[key] = envVar;
	}
	return overrides;
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as AnyRecord)
		: null;
}

/** Get provider-specific config block from the opencode config. */
export function getOpenCodeProviderConfig(provider: string): AnyRecord {
	const config = loadOpenCodeConfig();
	const providerConfig = asRecord(config.provider);
	if (!providerConfig) return {};
	const data = asRecord(providerConfig[provider]);
	return data ?? {};
}

/** True when the opencode config has a provider block for this provider name. */
export function hasOpenCodeProviderConfig(provider: string): boolean {
	return Object.keys(getOpenCodeProviderConfig(provider)).length > 0;
}

/** List all custom provider keys from the opencode config. */
export function listCustomProviders(): Set<string> {
	const config = loadOpenCodeConfig();
	const providerConfig = asRecord(config.provider);
	if (!providerConfig) return new Set();
	return new Set(Object.keys(providerConfig));
}

const BUILTIN_MODEL_PREFIX_PROVIDERS = new Set(["openai", "anthropic", "opencode"]);

function extractProviderPrefix(value: unknown): string | null {
	if (typeof value !== "string" || !value.includes("/")) return null;
	const prefix = value.split("/")[0]?.trim().toLowerCase();
	return prefix ? prefix : null;
}

export function listConfiguredOpenCodeProviders(): Set<string> {
	const providers = listCustomProviders();
	const config = loadOpenCodeConfig();
	for (const key of ["model", "small_model"]) {
		const prefix = extractProviderPrefix(config[key]);
		if (prefix) providers.add(prefix);
	}
	return providers;
}

export function listObserverProviderOptions(): string[] {
	const providers = listConfiguredOpenCodeProviders();
	for (const provider of BUILTIN_MODEL_PREFIX_PROVIDERS) providers.add(provider);
	return Array.from(providers).sort((a, b) => a.localeCompare(b));
}

export function resolveBuiltInProviderFromModel(model: string): string | null {
	const prefix = extractProviderPrefix(model);
	return prefix && BUILTIN_MODEL_PREFIX_PROVIDERS.has(prefix) ? prefix : null;
}

export function resolveBuiltInProviderDefaultModel(provider: string): string | null {
	if (provider === "openai") return "gpt-5.4-mini";
	if (provider === "anthropic") return "claude-haiku-4-5";
	if (provider === "opencode") return "opencode/gpt-5.4-mini";
	return null;
}

export function resolveBuiltInProviderModel(
	provider: string,
	modelName: string,
): [baseUrl: string | null, modelId: string | null, headers: Record<string, string>] {
	if (provider !== "opencode") {
		return [null, modelName || resolveBuiltInProviderDefaultModel(provider), {}];
	}
	const name = modelName || resolveBuiltInProviderDefaultModel(provider) || "";
	const prefix = `${provider}/`;
	const shortName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
	return ["https://opencode.ai/zen/v1", shortName || null, {}];
}

/** Extract provider prefix from a model string like `"myprovider/model-name"`. */
export function resolveCustomProviderFromModel(
	model: string,
	providers: Set<string>,
): string | null {
	if (!model?.includes("/")) return null;
	const prefix = model.split("/")[0] ?? "";
	return prefix && providers.has(prefix) ? prefix : null;
}

// ---------------------------------------------------------------------------
// Placeholder resolution
// ---------------------------------------------------------------------------

/**
 * Expand `$ENV_VAR` / `${ENV_VAR}` references and `{file:/path}` placeholders.
 *
 * Environment variable expansion mirrors Python's `os.path.expandvars`.
 * File placeholders read the file content and substitute it inline.
 */
export function resolvePlaceholder(value: string): string {
	const expanded = expandEnvVars(value);
	return resolveFilePlaceholder(expanded);
}

/** Expand `$VAR` and `${VAR}` environment variable references. */
function expandEnvVars(value: string): string {
	let result = "";
	for (let i = 0; i < value.length; i++) {
		if (value[i] !== "$" || i === value.length - 1) {
			result += value[i];
			continue;
		}
		if (value[i + 1] === "{") {
			const end = value.indexOf("}", i + 2);
			if (end > i + 2) {
				const name = value.slice(i + 2, end);
				result += process.env[name] ?? value.slice(i, end + 1);
				i = end;
				continue;
			}
		}
		const start = i + 1;
		let end = start;
		while (end < value.length) {
			const code = value.charCodeAt(end);
			const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
			const isDigit = code >= 48 && code <= 57;
			if (!isLetter && !isDigit && code !== 95) break;
			end++;
		}
		const name = value.slice(start, end);
		if (!name || !Number.isNaN(Number(name[0]))) {
			result += "$";
			continue;
		}
		result += process.env[name] ?? value.slice(i, end);
		i = end - 1;
	}
	return result;
}

/** Expand `{file:path}` placeholders by reading the referenced file. */
function resolveFilePlaceholder(value: string): string {
	if (!value.includes("{file:")) return value;
	let result = "";
	let index = 0;
	while (index < value.length) {
		const start = value.indexOf("{file:", index);
		if (start < 0) {
			result += value.slice(index);
			break;
		}
		const end = value.indexOf("}", start + 6);
		if (end < 0) {
			result += value.slice(index);
			break;
		}
		result += value.slice(index, start);
		const match = value.slice(start, end + 1);
		const rawPath = value.slice(start + 6, end);
		const trimmed = rawPath.trim();
		if (!trimmed) {
			result += match;
			index = end + 1;
			continue;
		}
		const expanded = expandEnvVars(trimmed);
		const resolved = expanded.startsWith("~")
			? `${codememHomeDir()}${expanded.slice(1)}`
			: expanded;
		try {
			result += readFileSync(resolved, "utf-8").trim();
		} catch {
			result += match;
		}
		index = end + 1;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Provider option extraction
// ---------------------------------------------------------------------------

/** Extract the `options` sub-object from a provider config block. */
export function getProviderOptions(providerConfig: AnyRecord): AnyRecord {
	const options = asRecord(providerConfig.options);
	return options ?? {};
}

/** Extract `baseURL` / `baseUrl` / `base_url` from provider config. */
export function getProviderBaseUrl(providerConfig: AnyRecord): string | null {
	const options = getProviderOptions(providerConfig);
	// Use || (not ??) so empty strings fall through to the next candidate (matches Python's `or`)
	const baseUrl = options.baseURL || options.baseUrl || options.base_url || providerConfig.base_url;
	return typeof baseUrl === "string" && baseUrl ? baseUrl : null;
}

/** Extract and resolve headers (with placeholder expansion) from provider config. */
export function getProviderHeaders(providerConfig: AnyRecord): Record<string, string> {
	const options = getProviderOptions(providerConfig);
	const headers = asRecord(options.headers);
	if (!headers) return {};
	const parsed: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof key !== "string" || typeof value !== "string") continue;
		parsed[key] = resolvePlaceholder(value);
	}
	return parsed;
}

/** Extract API key from provider config (direct value or env-var reference). */
export function getProviderApiKey(providerConfig: AnyRecord): string | null {
	const options = getProviderOptions(providerConfig);
	// Use || (not ??) so empty strings fall through (matches Python's `or`)
	const apiKey = options.apiKey || providerConfig.apiKey;
	if (typeof apiKey === "string" && apiKey) {
		return resolvePlaceholder(apiKey);
	}
	const apiKeyEnv = (options.apiKeyEnv ?? options.api_key_env) as string | undefined;
	if (typeof apiKeyEnv === "string" && apiKeyEnv) {
		const value = process.env[apiKeyEnv];
		if (value) return value;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Custom provider model resolution
// ---------------------------------------------------------------------------

/** Find the default model for a custom provider. */
export function resolveCustomProviderDefaultModel(provider: string): string | null {
	const providerConfig = getOpenCodeProviderConfig(provider);
	const options = getProviderOptions(providerConfig);
	const defaultModel =
		options.defaultModel ??
		options.default_model ??
		providerConfig.defaultModel ??
		providerConfig.default_model;
	if (typeof defaultModel === "string" && defaultModel) {
		return defaultModel.startsWith(`${provider}/`) ? defaultModel : `${provider}/${defaultModel}`;
	}
	const models = asRecord(providerConfig.models);
	if (models) {
		const firstKey = Object.keys(models)[0];
		if (typeof firstKey === "string" && firstKey) {
			return `${provider}/${firstKey}`;
		}
	}
	return null;
}

/**
 * Resolve base_url, model_id, and headers for a custom provider model.
 *
 * Returns `[baseUrl, modelId, headers]`.
 */
export function resolveCustomProviderModel(
	provider: string,
	modelName: string,
): [baseUrl: string | null, modelId: string | null, headers: Record<string, string>] {
	const providerConfig = getOpenCodeProviderConfig(provider);
	const baseUrl = getProviderBaseUrl(providerConfig);
	const headers = getProviderHeaders(providerConfig);

	let name = modelName;
	if (!name) {
		name = resolveCustomProviderDefaultModel(provider) ?? "";
	}

	const prefix = `${provider}/`;
	const shortName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

	const models = asRecord(providerConfig.models);
	let modelId: string | null = shortName;
	if (models) {
		const modelConfig = asRecord(models[shortName]);
		if (modelConfig && typeof modelConfig.id === "string") {
			modelId = modelConfig.id;
		}
	}

	if (typeof modelId !== "string" || !modelId) {
		modelId = null;
	}

	return [baseUrl, modelId, headers];
}
