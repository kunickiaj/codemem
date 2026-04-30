/**
 * Write-time secret scanner for the codemem store.
 *
 * Detects common secrets in memory write payloads (titles, bodies, narratives,
 * structured fields, and free-form metadata) and replaces them with
 * `[REDACTED:<kind>]` markers before persistence. There is no override flag:
 * codemem has no legitimate use case for storing live secrets, so any escape
 * hatch becomes the bypass that makes scanning theater.
 *
 * Scope of this foundation: the local-write chokepoint inside `MemoryStore.remember`.
 * Other writers into `memory_items` (sync-replication apply, sync-bootstrap
 * snapshot apply, AI/maintenance backfills of narrative/facts/concepts/tags)
 * are NOT scanned by this module yet — they are addressed by dependent bd
 * issues (codemem-hflk for sync-receive, codemem-tzrn for compaction/AI output,
 * codemem-vb2s for retroactive sweep over already-stored content). Workspace-level
 * rule overrides (codemem-ben8) and the test-fixture allowlist (codemem-jasn)
 * plug in via `ScannerOptions` without changing this module's shape.
 */

export interface SecretRule {
	/** Stable identifier surfaced in the redaction marker and detection log. */
	kind: string;
	/** Regex used to find candidate matches. Must be a global regex. */
	pattern: RegExp;
	/**
	 * Optional minimum Shannon entropy (bits/char) the matched substring must
	 * meet to be redacted. Filters out low-entropy false positives like
	 * common words that happen to look like a secret.
	 */
	minEntropy?: number;
	/**
	 * If set, only the indicated capture group (1-based) is replaced. Useful
	 * for context-aware rules where the match includes a known prefix that
	 * should be preserved.
	 */
	redactGroup?: number;
}

export interface ScanDetection {
	kind: string;
	count: number;
}

export interface ScanResult {
	redacted: string;
	detections: ScanDetection[];
}

export interface ScannerOptions {
	/** Additional rules merged with `DEFAULT_RULES`. */
	rules?: SecretRule[];
	/**
	 * Strings or regexes that bypass redaction even when matched. NOTE: string
	 * entries match by exact equality against the matched substring; regex
	 * entries are tested with `RegExp.test()` (partial match by default; use
	 * anchors for exact match).
	 */
	allowlist?: Array<string | RegExp>;
}

/** Field names whose string values should be treated as secret-bearing. */
const SECRET_BEARING_KEY =
	/^(?:secret|token|password|passwd|pwd|auth|bearer|credential|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|api[_-]?token)$/i;

/**
 * Built-in default rules. Conservative: prefer well-known prefixes and
 * structural patterns over raw entropy to keep the false-positive rate low.
 *
 * Rule precedence is order-dependent. More-specific rules MUST come before
 * more-general ones — see the OpenAI rule, which uses a negative lookahead to
 * avoid swallowing Anthropic keys regardless of order.
 */
export const DEFAULT_RULES: SecretRule[] = [
	// AWS — both halves of an access key pair
	{ kind: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	// AWS secret access key — 40 base64-ish chars; require entropy to filter FPs
	{
		kind: "aws_secret_access_key",
		pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
		minEntropy: 4.5,
	},

	// GitHub token family
	{ kind: "github_pat_classic", pattern: /\bghp_[A-Za-z0-9]{36}\b/g },
	{ kind: "github_pat_finegrained", pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
	{ kind: "github_oauth", pattern: /\bgho_[A-Za-z0-9]{36}\b/g },
	{ kind: "github_user_token", pattern: /\bghu_[A-Za-z0-9]{36}\b/g },
	{ kind: "github_server_token", pattern: /\bghs_[A-Za-z0-9]{36}\b/g },
	{ kind: "github_refresh_token", pattern: /\bghr_[A-Za-z0-9]{36}\b/g },

	// JWT — three base64url segments separated by dots, header begins with eyJ
	{ kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

	// Common provider keys
	{ kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: "stripe_live_key", pattern: /\bsk_live_[0-9a-zA-Z]{24,}\b/g },
	{ kind: "stripe_test_key", pattern: /\bsk_test_[0-9a-zA-Z]{24,}\b/g },
	{ kind: "anthropic_api_key", pattern: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}\b/g },
	// OpenAI keys: negative lookahead for `ant-` so Anthropic keys do not match here
	// even if rule order changes. Entropy floor avoids false-positive on internal
	// `sk-` prefixed identifiers that happen to be long enough.
	{
		kind: "openai_api_key",
		pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g,
		minEntropy: 3.5,
	},

	// PEM-encoded private keys (RSA/EC/DSA/OpenSSH/PGP). Note: PGP MESSAGE
	// blocks, SSH2 ENCRYPTED PRIVATE KEY, and PuTTY user-key files are NOT
	// matched by this rule and remain a known gap (deferred backlog).
	{
		kind: "pem_private_key",
		pattern:
			/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
	},

	// Context-aware generic secret: secret/token/password = "<value>"
	// Only the captured value (group 1) is redacted; the prefix is preserved.
	{
		kind: "generic_assigned_secret",
		pattern:
			/\b(?:secret|token|password|passwd|pwd|auth|bearer|credential|api[_-]?key|access[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|api[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9+/=_.-]{20,})["']?/gi,
		minEntropy: 3.5,
		redactGroup: 1,
	},
];

/** Shannon entropy in bits per character. */
function shannonEntropy(text: string): number {
	if (text.length === 0) return 0;
	const freq = new Map<string, number>();
	for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	let h = 0;
	for (const count of freq.values()) {
		const p = count / text.length;
		h -= p * Math.log2(p);
	}
	return h;
}

function ensureGlobal(re: RegExp): RegExp {
	if (re.flags.includes("g")) return re;
	return new RegExp(re.source, `${re.flags}g`);
}

function isAllowlisted(match: string, allowlist: Array<string | RegExp>): boolean {
	for (const entry of allowlist) {
		if (typeof entry === "string") {
			if (entry === match) return true;
		} else {
			// `RegExp.test()` advances `lastIndex` on regexes with `g` or `y`
			// flags, which would make repeated allowlist checks return
			// alternating results. Reset before testing so the decision is
			// stable across calls regardless of caller-supplied flags.
			if (entry.global || entry.sticky) entry.lastIndex = 0;
			if (entry.test(match)) return true;
		}
	}
	return false;
}

/**
 * Detect whether `value` is a "plain" object (`{}` literal or `Object.create(null)`),
 * vs a class instance / built-in like Date, Map, Set, RegExp, Buffer, typed array.
 * Plain objects are walked recursively; non-plain objects are returned as-is so
 * we don't silently corrupt them by reconstructing as `{}`.
 */
function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

export class SecretScanner {
	private readonly rules: SecretRule[];
	private readonly allowlist: Array<string | RegExp>;

	constructor(opts: ScannerOptions = {}) {
		this.rules = [...DEFAULT_RULES, ...(opts.rules ?? [])];
		this.allowlist = opts.allowlist ?? [];
	}

	/** Scan a single string. Returns the redacted form and per-kind detection counts. */
	scan(text: string): ScanResult {
		if (!text || typeof text !== "string") return { redacted: text, detections: [] };
		let redacted = text;
		const counts = new Map<string, number>();
		for (const rule of this.rules) {
			const re = ensureGlobal(rule.pattern);
			redacted = redacted.replace(re, (...args) => {
				// args = [match, ...groups, offset, fullString, groupsObj?]
				const match = args[0] as string;
				const target =
					rule.redactGroup != null ? ((args[rule.redactGroup] as string | undefined) ?? "") : match;
				if (!target) return match;
				if (isAllowlisted(target, this.allowlist)) return match;
				if (rule.minEntropy != null && shannonEntropy(target) < rule.minEntropy) return match;
				counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
				const marker = `[REDACTED:${rule.kind}]`;
				if (rule.redactGroup != null) {
					return match.replace(target, marker);
				}
				return marker;
			});
		}
		const detections = Array.from(counts.entries()).map(([kind, count]) => ({ kind, count }));
		return { redacted, detections };
	}

	/**
	 * Recursively walk a value, scanning every string. String values whose
	 * containing key name matches a secret-bearing field are redacted whole if
	 * non-trivial. Non-plain objects (Date, Map, Set, RegExp, Buffer, typed
	 * arrays, class instances) are returned as-is to avoid silent corruption.
	 * Cycles are detected via a `seen` set so misbehaving callers cannot
	 * stack-overflow the scanner.
	 */
	redactValue(value: unknown, parentKey?: string): { value: unknown; detections: ScanDetection[] } {
		return this.redactValueInternal(value, parentKey, new WeakSet());
	}

	private redactValueInternal(
		value: unknown,
		parentKey: string | undefined,
		seen: WeakSet<object>,
	): { value: unknown; detections: ScanDetection[] } {
		if (typeof value === "string") {
			if (parentKey && SECRET_BEARING_KEY.test(parentKey) && this.looksLikeSecretValue(value)) {
				if (isAllowlisted(value, this.allowlist)) {
					return { value, detections: [] };
				}
				return {
					value: "[REDACTED:context_secret]",
					detections: [{ kind: "context_secret", count: 1 }],
				};
			}
			const result = this.scan(value);
			return { value: result.redacted, detections: result.detections };
		}
		if (Array.isArray(value)) {
			if (seen.has(value)) return { value, detections: [] };
			seen.add(value);
			const out: unknown[] = [];
			const merged = new Map<string, number>();
			for (const item of value) {
				const r = this.redactValueInternal(item, parentKey, seen);
				out.push(r.value);
				for (const d of r.detections) merged.set(d.kind, (merged.get(d.kind) ?? 0) + d.count);
			}
			return { value: out, detections: aggregateMap(merged) };
		}
		if (value !== null && typeof value === "object") {
			if (seen.has(value)) return { value, detections: [] };
			if (!isPlainObject(value)) {
				// Non-plain objects (Date, Map, Set, RegExp, Buffer, typed arrays,
				// class instances) are returned unchanged. Walking them would
				// silently strip prototype methods and corrupt state.
				return { value, detections: [] };
			}
			seen.add(value);
			const obj = value as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			const merged = new Map<string, number>();
			for (const [k, v] of Object.entries(obj)) {
				const r = this.redactValueInternal(v, k, seen);
				out[k] = r.value;
				for (const d of r.detections) merged.set(d.kind, (merged.get(d.kind) ?? 0) + d.count);
			}
			return { value: out, detections: aggregateMap(merged) };
		}
		return { value, detections: [] };
	}

	private looksLikeSecretValue(text: string): boolean {
		// Threshold of 8 chars filters obvious placeholders ("n/a", "true", short
		// human values) while still catching anything long enough to plausibly
		// be a secret. URL values get a free pass since auth callback URLs are
		// commonly stored under "auth"-named keys.
		if (text.length < 8) return false;
		if (/^(?:https?|ftp|file):\/\//i.test(text)) return false;
		if (/^(?:\[REDACTED:|<.*>|\{\{.*\}\}|null|undefined)$/i.test(text.trim())) return false;
		return true;
	}
}

function aggregateMap(map: Map<string, number>): ScanDetection[] {
	return Array.from(map.entries()).map(([kind, count]) => ({ kind, count }));
}

/** Merge multiple detection lists into a single per-kind summary. */
export function mergeDetections(...lists: ScanDetection[][]): ScanDetection[] {
	const merged = new Map<string, number>();
	for (const list of lists) {
		for (const d of list) merged.set(d.kind, (merged.get(d.kind) ?? 0) + d.count);
	}
	return aggregateMap(merged);
}
