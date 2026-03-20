/**
 * Observer authentication: credential resolution, caching, and header rendering.
 *
 * Mirrors codemem/observer_auth.py — resolves auth tokens from explicit values,
 * environment variables, OAuth caches, files, or external commands. Supports
 * template-based header rendering with `${auth.token}` / `${auth.type}` / `${auth.source}`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";

// Inline version to avoid circular import (index.ts re-exports from this module).
// Keep in sync with the VERSION constant in index.ts.
const PACKAGE_VERSION = "0.0.1";

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACT_PATTERNS = [/sk-[A-Za-z0-9]{10,}/g, /Bearer\s+[A-Za-z0-9._-]{10,}/g];

/** Redact API keys and bearer tokens in text. Truncates at `limit` chars. */
export function redactText(text: string, limit = 400): string {
	let redacted = text;
	for (const pattern of REDACT_PATTERNS) {
		redacted = redacted.replace(new RegExp(pattern.source, pattern.flags), "[redacted]");
	}
	return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

// ---------------------------------------------------------------------------
// Auth material
// ---------------------------------------------------------------------------

export interface ObserverAuthMaterial {
	token: string | null;
	authType: string;
	source: string;
}

function noAuth(): ObserverAuthMaterial {
	return { token: null, authType: "none", source: "none" };
}

// ---------------------------------------------------------------------------
// OAuth cache (OpenCode's auth.json)
// ---------------------------------------------------------------------------

function getOpenCodeAuthPath(): string {
	return join(homedir(), ".local", "share", "opencode", "auth.json");
}

/** Load the OpenCode OAuth token cache from `~/.local/share/opencode/auth.json`. */
export function loadOpenCodeOAuthCache(): Record<string, unknown> {
	const authPath = getOpenCodeAuthPath();
	if (!existsSync(authPath)) return {};
	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		return data != null && typeof data === "object" && !Array.isArray(data) ? data : {};
	} catch {
		return {};
	}
}

/** Determine OAuth provider from configured provider name or model prefix. */
export function resolveOAuthProvider(configured: string | null | undefined, model: string): string {
	if (configured && ["openai", "anthropic"].includes(configured.toLowerCase())) {
		return configured.toLowerCase();
	}
	return model.toLowerCase().startsWith("claude") ? "anthropic" : "openai";
}

type OAuthEntry = Record<string, unknown>;

function getOAuthEntry(cache: Record<string, unknown>, provider: string): OAuthEntry | null {
	const entry = cache[provider];
	return entry != null && typeof entry === "object" && !Array.isArray(entry)
		? (entry as OAuthEntry)
		: null;
}

/** Extract access token from OAuth cache for a given provider. */
export function extractOAuthAccess(
	cache: Record<string, unknown>,
	provider: string,
): string | null {
	const entry = getOAuthEntry(cache, provider);
	if (!entry) return null;
	const access = entry.access;
	return typeof access === "string" && access ? access : null;
}

/** Extract API key from auth cache for a given provider. */
export function extractProviderApiKey(
	cache: Record<string, unknown>,
	provider: string,
): string | null {
	const entry = getOAuthEntry(cache, provider);
	if (!entry) return null;
	const key = entry.key;
	return typeof key === "string" && key ? key : null;
}

/** Probe which credential sources are currently available per built-in provider. */
export function probeAvailableCredentials(): Record<
	string,
	{ oauth: boolean; api_key: boolean; env_var: boolean }
> {
	const cache = loadOpenCodeOAuthCache();
	const now = Date.now();
	const explicitApiKey = Boolean(process.env.CODEMEM_OBSERVER_API_KEY);
	const providers = [
		["openai", "OPENAI_API_KEY"],
		["anthropic", "ANTHROPIC_API_KEY"],
		["opencode", null],
	] as const;
	const result: Record<string, { oauth: boolean; api_key: boolean; env_var: boolean }> = {};
	for (const [provider, envVar] of providers) {
		const oauthAccess = extractOAuthAccess(cache, provider);
		const oauthExpires = extractOAuthExpires(cache, provider);
		const oauthValid =
			provider === "opencode"
				? Boolean(extractProviderApiKey(cache, provider))
				: Boolean(oauthAccess) && (oauthExpires == null || oauthExpires > now);
		result[provider] = {
			oauth: oauthValid,
			api_key: explicitApiKey,
			env_var: envVar ? Boolean(process.env[envVar]) : false,
		};
	}
	return result;
}

/** Extract account ID from OAuth cache for a given provider. */
export function extractOAuthAccountId(
	cache: Record<string, unknown>,
	provider: string,
): string | null {
	const entry = getOAuthEntry(cache, provider);
	if (!entry) return null;
	const accountId = entry.accountId;
	return typeof accountId === "string" && accountId ? accountId : null;
}

/** Extract expiry timestamp (ms) from OAuth cache for a given provider. */
export function extractOAuthExpires(
	cache: Record<string, unknown>,
	provider: string,
): number | null {
	const entry = getOAuthEntry(cache, provider);
	if (!entry) return null;
	const expires = entry.expires;
	return typeof expires === "number" ? expires : null;
}

// ---------------------------------------------------------------------------
// Codex headers
// ---------------------------------------------------------------------------

/** Build OpenAI Codex transport headers from an OAuth access token. */
export function buildCodexHeaders(
	accessToken: string,
	accountId: string | null,
): Record<string, string> {
	const originator = process.env.CODEMEM_CODEX_ORIGINATOR ?? "opencode";
	const userAgent =
		process.env.CODEMEM_CODEX_USER_AGENT ??
		`codemem/${PACKAGE_VERSION} (${platform()} ${release()}; ${arch()})`;

	const headers: Record<string, string> = {
		authorization: `Bearer ${accessToken}`,
		originator,
		"User-Agent": userAgent,
		accept: "text/event-stream",
	};
	if (accountId) {
		headers["ChatGPT-Account-Id"] = accountId;
	}
	return headers;
}

// ---------------------------------------------------------------------------
// External auth: command execution & file reading
// ---------------------------------------------------------------------------

/** Execute an external auth command and return the token (stdout, trimmed). */
export function runAuthCommand(command: string[], timeoutMs: number): string | null {
	const cmd = command[0];
	if (!cmd) return null;
	// execFileSync timeout is in milliseconds
	const effectiveTimeoutMs = Math.max(100, timeoutMs);
	try {
		const stdout = execFileSync(cmd, command.slice(1), {
			timeout: effectiveTimeoutMs,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const token = (stdout ?? "").trim();
		return token || null;
	} catch {
		return null;
	}
}

/** Read a token from a file path (supports `~` and `$ENV_VAR` expansion). */
export function readAuthFile(filePath: string | null): string | null {
	if (!filePath) return null;
	// Expand ~ and $ENV_VAR
	let resolved = filePath.replace(/^~/, homedir());
	resolved = resolved.replace(
		/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(match, braced, bare) => {
			const name = braced ?? bare;
			return process.env[name] ?? match;
		},
	);
	try {
		if (!existsSync(resolved) || !statSync(resolved).isFile()) return null;
		const token = readFileSync(resolved, "utf-8").trim();
		return token || null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Source normalization
// ---------------------------------------------------------------------------

const VALID_SOURCES = new Set(["", "auto", "env", "file", "command", "none"]);

function normalizeAuthSource(value: string | null | undefined): string {
	const normalized = (value ?? "").trim().toLowerCase();
	return VALID_SOURCES.has(normalized) ? normalized || "auto" : "auto";
}

// ---------------------------------------------------------------------------
// Auth adapter (credential cascade with caching)
// ---------------------------------------------------------------------------

export interface ObserverAuthResolveOptions {
	explicitToken?: string | null;
	envTokens?: string[];
	oauthToken?: string | null;
	forceRefresh?: boolean;
}

/**
 * Resolves auth credentials through a configurable cascade:
 * explicit → env → oauth → file → command.
 *
 * Results from file/command sources are cached for `cacheTtlS` seconds.
 */
export class ObserverAuthAdapter {
	readonly source: string;
	readonly filePath: string | null;
	readonly command: string[];
	readonly timeoutMs: number;
	readonly cacheTtlS: number;

	private cached: ObserverAuthMaterial = noAuth();
	private cachedAtMs = 0;

	constructor(opts?: {
		source?: string;
		filePath?: string | null;
		command?: string[];
		timeoutMs?: number;
		cacheTtlS?: number;
	}) {
		this.source = opts?.source ?? "auto";
		this.filePath = opts?.filePath ?? null;
		this.command = opts?.command ?? [];
		this.timeoutMs = opts?.timeoutMs ?? 1500;
		this.cacheTtlS = opts?.cacheTtlS ?? 300;
	}

	/** Resolve auth material through the credential cascade. */
	resolve(opts?: ObserverAuthResolveOptions): ObserverAuthMaterial {
		const source = normalizeAuthSource(this.source);
		const explicitToken = opts?.explicitToken ?? null;
		const envTokens = opts?.envTokens ?? [];
		const oauthToken = opts?.oauthToken ?? null;
		const forceRefresh = opts?.forceRefresh ?? false;

		if (source === "none") return noAuth();

		// Check cache for file/command sources
		if (!forceRefresh && (source === "command" || source === "file") && this.cacheTtlS > 0) {
			const ageMs = performance.now() - this.cachedAtMs;
			if (this.cachedAtMs > 0 && ageMs <= this.cacheTtlS * 1000) {
				return this.cached;
			}
		}

		let token: string | null = null;
		let tokenSource = "none";

		if (source === "auto") {
			if (explicitToken) {
				token = explicitToken;
				tokenSource = "explicit";
			}
			if (!token) {
				token = envTokens.find((t) => !!t) ?? null;
				if (token) tokenSource = "env";
			}
			if (!token && oauthToken) {
				token = oauthToken;
				tokenSource = "oauth";
			}
		} else if (source === "env") {
			token = envTokens.find((t) => !!t) ?? null;
			if (token) tokenSource = "env";
		}

		if ((source === "auto" || source === "file") && !token) {
			token = readAuthFile(this.filePath);
			if (token) tokenSource = "file";
		}

		if ((source === "auto" || source === "command") && !token) {
			token = runAuthCommand(this.command, this.timeoutMs);
			if (token) tokenSource = "command";
		}

		const resolved: ObserverAuthMaterial = token
			? { token, authType: "bearer", source: tokenSource }
			: noAuth();

		const shouldCache = source === "command" || source === "file";
		if (shouldCache && resolved.token) {
			this.cached = resolved;
			this.cachedAtMs = performance.now();
		} else if (shouldCache) {
			this.invalidateCache();
		}

		return resolved;
	}

	/** Clear the cached auth material. */
	invalidateCache(): void {
		this.cached = noAuth();
		this.cachedAtMs = 0;
	}
}

// ---------------------------------------------------------------------------
// Header rendering
// ---------------------------------------------------------------------------

const AUTH_TOKEN_RE = /\$\{auth\.token\}/g;
const AUTH_TYPE_RE = /\$\{auth\.type\}/g;
const AUTH_SOURCE_RE = /\$\{auth\.source\}/g;

/** Render observer headers with `${auth.token}`, `${auth.type}`, `${auth.source}` substitution. */
export function renderObserverHeaders(
	headers: Record<string, string>,
	auth: ObserverAuthMaterial,
): Record<string, string> {
	const token = auth.token ?? "";
	const rendered: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof key !== "string" || typeof value !== "string") continue;

		let candidate = value.replace(AUTH_TOKEN_RE, token);
		candidate = candidate.replace(AUTH_TYPE_RE, auth.authType);
		candidate = candidate.replace(AUTH_SOURCE_RE, auth.source);

		// Skip headers that reference auth.token when no token is available
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template pattern, not JS template literal
		if (value.includes("${auth.token}") && !token) continue;

		const cleaned = candidate.trim();
		if (!cleaned) continue;
		rendered[key] = cleaned;
	}
	return rendered;
}
