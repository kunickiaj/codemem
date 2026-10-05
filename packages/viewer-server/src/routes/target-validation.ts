import { resolve as resolvePath } from "node:path";
import type { ViewerIdentityTarget } from "@codemem/core";
import {
	buildViewerIdentityTarget,
	resolveCodememConfigPath,
	resolveDbPath,
	VIEWER_IDENTITY_TARGET_KEYS,
} from "@codemem/core";
import type { Context, Next } from "hono";

const IDENTITY_TARGET_KEYS = new Set<string>(VIEWER_IDENTITY_TARGET_KEYS);
const BOOLEAN_IDENTITY_TARGET_KEYS = new Set([
	"actor_id_present",
	"embedding_disabled",
	"embedding_offline",
]);

export type ViewerTargetValidation =
	| { ok: true }
	| { ok: false; status: 400 | 409; body: { error: { code: string; message: string } } };

export interface ViewerTargetStore {
	dbPath: string;
	hasCurrentIdentity(): boolean;
}

function invalidRequest(message: string): ViewerTargetValidation {
	return { ok: false, status: 400, body: { error: { code: "invalid_request", message } } };
}

function conflict(code: string, message: string): ViewerTargetValidation {
	return { ok: false, status: 409, body: { error: { code, message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

export function currentIdentityTarget(): ViewerIdentityTarget {
	return buildViewerIdentityTarget();
}

function requestedDbMatches(store: ViewerTargetStore, value: unknown): boolean | null {
	if (value == null) return true;
	if (typeof value !== "string" || !value.trim()) return null;
	return resolvePath(resolveDbPath(value.trim())) === resolvePath(store.dbPath);
}

function implicitConfigPath(): string | null {
	const { resolved, fallbackChain } = resolveCodememConfigPath();
	if (resolved.source !== "env-codemem-config") return resolvePath(resolved.path);
	// Older clients encode an omitted override as null. Resolve the same read
	// fallback without the viewer's explicit override, not a guessed global path.
	const candidates = fallbackChain.filter((candidate) => candidate.valid);
	const implicit = candidates.find((candidate) => candidate.exists) ?? candidates[0];
	return implicit ? resolvePath(implicit.path) : null;
}

function identityFieldMatches(
	key: string,
	requested: string | boolean | null,
	expected: string | boolean | null,
): boolean {
	if (requested === expected) return true;
	if (key !== "config_path" || (requested !== null && expected !== null)) return false;
	return (requested ?? expected) === implicitConfigPath();
}

function requestedIdentityMatches(value: unknown): boolean | null | "unsupported" {
	if (value == null) return true;
	if (!isRecord(value)) return null;
	if (
		Object.keys(value).length !== IDENTITY_TARGET_KEYS.size ||
		Object.keys(value).some((key) => !IDENTITY_TARGET_KEYS.has(key))
	)
		return "unsupported";
	const expected = currentIdentityTarget();
	for (const key of VIEWER_IDENTITY_TARGET_KEYS) {
		const requested = value[key];
		if (BOOLEAN_IDENTITY_TARGET_KEYS.has(key)) {
			if (typeof requested !== "boolean") return null;
		} else if (requested !== null && typeof requested !== "string") {
			return null;
		}
		if (!identityFieldMatches(key, requested, expected[key])) return false;
	}
	return true;
}

export function validateViewerTarget(
	store: ViewerTargetStore,
	payload: Record<string, unknown>,
	options: { requireCurrentIdentity?: boolean; requirePairedTargets?: boolean } = {},
): ViewerTargetValidation {
	if (options.requirePairedTargets) {
		const hasDbPath = Object.hasOwn(payload, "db_path");
		const hasIdentityTarget = Object.hasOwn(payload, "identity_target");
		if (hasDbPath !== hasIdentityTarget) {
			return invalidRequest("db_path and identity_target must be provided together");
		}
		if (hasDbPath && (payload.db_path == null || payload.identity_target == null)) {
			return invalidRequest("db_path and identity_target must be valid when provided");
		}
	}
	const dbMatches = requestedDbMatches(store, payload.db_path);
	if (dbMatches == null) return invalidRequest("db_path must be a non-empty string");
	if (!dbMatches) {
		return conflict("viewer_db_mismatch", "viewer database does not match request");
	}

	const identityMatches = requestedIdentityMatches(payload.identity_target);
	if (identityMatches === "unsupported") {
		return conflict("viewer_contract_unsupported", "viewer request contract is incompatible");
	}
	if (identityMatches == null) return invalidRequest("identity_target is invalid");
	if (!identityMatches) {
		return conflict("viewer_identity_mismatch", "viewer identity does not match request");
	}
	if (
		(options.requireCurrentIdentity || payload.identity_target != null) &&
		!store.hasCurrentIdentity()
	) {
		return conflict("viewer_identity_mismatch", "viewer identity does not match request");
	}
	return { ok: true };
}

/**
 * Middleware read of db_path / identity_target from the query string.
 * Native tools (pi extension) send targets as query params so a pre-handler
 * guard can reject a foreign viewer without consuming POST bodies. Lenient:
 * clients that omit targets (UI, MCP, curl) are unaffected.
 */
export function viewerTargetQueryGuard(getStore: () => ViewerTargetStore) {
	return async (c: Context, next: Next) => {
		const dbPath = c.req.query("db_path");
		const rawIdentity = c.req.query("identity_target");
		if (dbPath == null && rawIdentity == null) return next();
		let identityTarget: unknown;
		if (rawIdentity != null) {
			try {
				identityTarget = JSON.parse(rawIdentity);
			} catch {
				return c.json(
					{ error: { code: "invalid_request", message: "identity_target must be JSON" } },
					400,
				);
			}
		}
		const target = validateViewerTarget(getStore(), {
			db_path: dbPath ?? undefined,
			identity_target: identityTarget,
		});
		if (!target.ok) return c.json(target.body, target.status);
		return next();
	};
}
