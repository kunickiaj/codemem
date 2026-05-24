/**
 * @codemem/mcp — privacy-safe OAuth audit events.
 *
 * Phase 1 single-user remote MCP needs operator-visible security events
 * (registration, authorize, OIDC callback, token issuance, revocation, bearer
 * verification) without ever logging bearer tokens, authorization codes,
 * client secrets, OIDC ID tokens, or private memory contents.
 */

export type OAuthAuditKind =
	| "registration"
	| "authorize"
	| "oidc_callback"
	| "token"
	| "refresh"
	| "rotation"
	| "revocation"
	| "bearer";

export type OAuthAuditOutcome = "success" | "denied" | "error";

export type BearerDenyReason =
	| "missing_authorization_header"
	| "malformed_authorization_header"
	| "unknown_token"
	| "expired_token"
	| "revoked_token";

export interface OAuthAuditEventBase {
	timestamp: string;
	outcome: OAuthAuditOutcome;
	reason?: string;
	clientId?: string;
	remoteAddress?: string;
}

export type OAuthAuditEvent = OAuthAuditEventBase & { kind: OAuthAuditKind };

export type OAuthAuditEmitter = (event: OAuthAuditEvent) => void;

// Canonicalized denylist — keys are compared after lowercasing and stripping
// non-alphanumeric separators, so `access_token`, `accessToken`, `ACCESS-TOKEN`
// and `access token` all reduce to `accesstoken` and are blocked uniformly.
// This codebase commonly uses camelCase identifiers, so a snake_case-only
// denylist would miss real leak vectors.
const FORBIDDEN_KEY_TOKENS = new Set([
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"code",
	"codeverifier",
	"codechallenge",
	"clientsecret",
	"authorization",
	"password",
	"secret",
]);

function canonicalizeAuditKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Build an audit event with redaction safety. Throws if a forbidden field
 * leaks in; callers should never need to pass token/code material here.
 */
export function buildOAuthAuditEvent(
	kind: OAuthAuditKind,
	fields: Omit<OAuthAuditEventBase, "timestamp"> & { now?: number },
): OAuthAuditEvent {
	for (const key of Object.keys(fields)) {
		if (FORBIDDEN_KEY_TOKENS.has(canonicalizeAuditKey(key))) {
			throw new Error(`OAuth audit event must not carry forbidden field: ${key}`);
		}
	}
	const { now, ...rest } = fields;
	return {
		kind,
		timestamp: new Date(now ?? Date.now()).toISOString(),
		...rest,
	};
}

/**
 * Wrap an audit emitter so any synchronous throw or stream-write failure stays
 * contained. Audit logging is best-effort observability and must never break
 * the OAuth/MCP request flow it observes. Failures are reported once per
 * process to `console.error` so they remain visible without flooding output.
 */
export function wrapAuditEmitterBestEffort(emit: OAuthAuditEmitter): OAuthAuditEmitter {
	let reportedFailure = false;
	return (event) => {
		try {
			emit(event);
		} catch (err) {
			if (!reportedFailure) {
				reportedFailure = true;
				console.error("codemem MCP OAuth audit emitter failed (further failures suppressed):", err);
			}
		}
	};
}

/**
 * Default audit emitter writes one JSON object per line to stderr. This keeps
 * MCP HTTP stdout reserved for protocol traffic and is greppable by operators
 * via `journalctl` or a redirected log file.
 */
export function createDefaultOAuthAuditEmitter(
	stream: NodeJS.WriteStream = process.stderr,
): OAuthAuditEmitter {
	return (event) => {
		stream.write(`${JSON.stringify({ source: "codemem-mcp-oauth-audit", ...event })}\n`);
	};
}

/**
 * No-op emitter, used when CODEMEM_MCP_AUDIT=0 or when callers explicitly
 * want to suppress audit output (for example, embedded tests).
 */
export function createSilentOAuthAuditEmitter(): OAuthAuditEmitter {
	return () => {};
}

/**
 * Resolve an emitter from environment configuration. `CODEMEM_MCP_AUDIT=0`,
 * `false`, or `no` disables audit logging; anything else (including unset)
 * uses the default stderr emitter.
 */
export function resolveOAuthAuditEmitterFromEnv(
	value = process.env.CODEMEM_MCP_AUDIT,
): OAuthAuditEmitter {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "0" || normalized === "false" || normalized === "no") {
		return createSilentOAuthAuditEmitter();
	}
	return createDefaultOAuthAuditEmitter();
}
