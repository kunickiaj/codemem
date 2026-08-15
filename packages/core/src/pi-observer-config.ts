/**
 * Derive codemem observer (extraction LLM) settings from pi agent configuration.
 *
 * Reads pi's settings.json, models.json / models-store.json, and auth.json
 * (in memory only) and projects an API-key provider into the shape expected by
 * ObserverConfig / the HTTP observer client.
 *
 * Design D8 / pi-agent-observer-config:
 *  - API-key credentials only (OAuth is unsupported in v1)
 *  - Wire APIs: openai-completions | openai-responses | anthropic-messages
 *  - Cheap-first model selection; never prefer interactive defaultModel
 *  - Credentials stay in the returned object only — never written or logged
 *
 * Callers MUST prefer explicit codemem `observer_*` config/env over this
 * result (see {@link hasExplicitObserverEnvOverride}).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { stripJsonComments, stripTrailingCommas } from "./observer-config.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PiObserverResolveInput = {
	/** Override for the pi agent dir (default: PI_CODING_AGENT_DIR or ~/.pi/agent). */
	piDir?: string;
	/** Env view; defaults to process.env. Used for PI_CODING_AGENT_DIR + HOME. */
	env?: NodeJS.ProcessEnv;
};

export type PiObserverResolveOk = {
	ok: true;
	provider: string;
	model: string;
	baseUrl: string | null;
	/** API key material — memory only; never persist or log. */
	apiKey: string | null;
	openAIUseResponses: boolean;
	/** Pi wire API id: openai-completions | openai-responses | anthropic-messages */
	wireApi: string;
};

export type PiObserverResolveReason =
	| "not-configured"
	| "oauth-only"
	| "unsupported-api"
	| "no-api-key-provider";

export type PiObserverResolveErr = {
	ok: false;
	reason: PiObserverResolveReason;
	detail: string;
};

export type PiObserverResolveResult = PiObserverResolveOk | PiObserverResolveErr;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_WIRE_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
]);

/**
 * Name-pattern cost tiers (lower = cheaper). Used when models-store has no
 * numeric cost, and as a secondary signal alongside declared cost.
 *
 * Patterns match common small/fast model naming: mini, nano, haiku, flash,
 * lite, small. Premium interactive names (opus, sonnet, pro, max, ultra, …)
 * rank more expensive.
 */
const CHEAP_NAME_PATTERNS: Array<{ re: RegExp; tier: number }> = [
	{ re: /\b(nano|haiku|micro)\b/i, tier: 0 },
	{ re: /\b(mini|lite|flash|small|fast)\b/i, tier: 1 },
	{ re: /\b(base|standard|instant)\b/i, tier: 2 },
	{ re: /\b(sonnet|medium|plus)\b/i, tier: 5 },
	{ re: /\b(opus|pro|max|ultra|large|premier|heavy)\b/i, tier: 8 },
];

const DEFAULT_NAME_TIER = 4;

// ---------------------------------------------------------------------------
// Path + JSON helpers
// ---------------------------------------------------------------------------

function homeFromEnv(env: NodeJS.ProcessEnv): string {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim();
	return home || homedir();
}

/** Resolve the pi agent config directory. */
export function resolvePiAgentDir(input: PiObserverResolveInput = {}): string {
	if (input.piDir?.trim()) {
		const raw = input.piDir.trim();
		if (raw.startsWith("~/")) {
			return join(homeFromEnv(input.env ?? process.env), raw.slice(2));
		}
		return raw;
	}
	const env = input.env ?? process.env;
	const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv) {
		if (fromEnv.startsWith("~/")) {
			return join(homeFromEnv(env), fromEnv.slice(2));
		}
		return isAbsolute(fromEnv) ? fromEnv : join(homeFromEnv(env), fromEnv);
	}
	return join(homeFromEnv(env), ".pi", "agent");
}

function readJsonObject(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	if (!text.trim()) return null;

	const tryParse = (raw: string): Record<string, unknown> | null => {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	};

	const plain = tryParse(text);
	if (plain) return plain;
	return tryParse(stripTrailingCommas(stripJsonComments(text)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Explicit observer_* env override detection (caller short-circuit)
// ---------------------------------------------------------------------------

/**
 * True when codemem already has an explicit observer provider/model via
 * environment variables (`CODEMEM_OBSERVER_PROVIDER` / `CODEMEM_OBSERVER_MODEL`).
 *
 * Name is deliberately env-scoped: file-based `observer_provider`/`observer_model`
 * in codemem config are checked by callers separately. Use this only for the
 * env half of the "explicit config/env > pi-derived" precedence rule.
 */
export function hasExplicitObserverEnvOverride(env: NodeJS.ProcessEnv = process.env): boolean {
	const provider = env.CODEMEM_OBSERVER_PROVIDER?.trim();
	const model = env.CODEMEM_OBSERVER_MODEL?.trim();
	return Boolean(provider || model);
}

// ---------------------------------------------------------------------------
// Auth (in-memory only)
// ---------------------------------------------------------------------------

type PiAuthEntry = { kind: "api_key"; key: string } | { kind: "oauth" } | { kind: "other" };

function loadPiAuth(piDir: string): {
	byProvider: Map<string, PiAuthEntry>;
	sawOAuth: boolean;
	sawApiKey: boolean;
} {
	const byProvider = new Map<string, PiAuthEntry>();
	let sawOAuth = false;
	let sawApiKey = false;
	const raw = readJsonObject(join(piDir, "auth.json"));
	if (!raw) return { byProvider, sawOAuth, sawApiKey };

	for (const [provider, value] of Object.entries(raw)) {
		const entry = asRecord(value);
		if (!entry) continue;
		const type = asString(entry.type)?.toLowerCase();
		if (type === "api_key" || type === "api-key") {
			const key = asString(entry.key);
			if (key) {
				byProvider.set(provider, { kind: "api_key", key });
				sawApiKey = true;
			}
		} else if (type === "oauth") {
			byProvider.set(provider, { kind: "oauth" });
			sawOAuth = true;
		} else if (type) {
			byProvider.set(provider, { kind: "other" });
		}
	}
	return { byProvider, sawOAuth, sawApiKey };
}

// ---------------------------------------------------------------------------
// Models catalog (models.json + models-store.json)
// ---------------------------------------------------------------------------

type PiModelCandidate = {
	provider: string;
	modelId: string;
	baseUrl: string | null;
	wireApi: string;
	apiKey: string | null;
	/** Declared input+output cost when known; null → fall back to name tier. */
	declaredCost: number | null;
	nameTier: number;
	/** True when listed in settings.enabledModels. */
	enabled: boolean;
	/** True when this is settings.defaultModel. */
	isDefault: boolean;
};

function nameCostTier(modelId: string): number {
	for (const { re, tier } of CHEAP_NAME_PATTERNS) {
		if (re.test(modelId)) return tier;
	}
	return DEFAULT_NAME_TIER;
}

function declaredCostOf(model: Record<string, unknown>): number | null {
	const cost = asRecord(model.cost);
	if (!cost) return null;
	const input = typeof cost.input === "number" ? cost.input : null;
	const output = typeof cost.output === "number" ? cost.output : null;
	if (input == null && output == null) return null;
	// Weight input more heavily (extraction is prompt-heavy).
	return (input ?? 0) * 2 + (output ?? 0);
}

function loadModelsJsonProviders(piDir: string): Map<
	string,
	{
		baseUrl: string | null;
		api: string | null;
		apiKey: string | null;
		models: Array<Record<string, unknown>>;
	}
> {
	const out = new Map<
		string,
		{
			baseUrl: string | null;
			api: string | null;
			apiKey: string | null;
			models: Array<Record<string, unknown>>;
		}
	>();
	const root = readJsonObject(join(piDir, "models.json"));
	if (!root) return out;
	const providers = asRecord(root.providers) ?? root;
	for (const [name, value] of Object.entries(providers)) {
		// Skip non-provider keys if the file used a bare object without `providers`
		if (name === "providers" || name === "modelOverrides") continue;
		const prov = asRecord(value);
		if (!prov) continue;
		const modelsRaw = prov.models;
		const models = Array.isArray(modelsRaw)
			? modelsRaw.filter((m): m is Record<string, unknown> => asRecord(m) != null)
			: [];
		out.set(name, {
			baseUrl: asString(prov.baseUrl),
			api: asString(prov.api),
			apiKey: asString(prov.apiKey),
			models,
		});
	}
	return out;
}

function loadModelsStoreProviders(
	piDir: string,
): Map<string, { models: Array<Record<string, unknown>> }> {
	const out = new Map<string, { models: Array<Record<string, unknown>> }>();
	const root = readJsonObject(join(piDir, "models-store.json"));
	if (!root) return out;

	// models-store.json is { <provider>: { models: [...] } } (no providers wrapper)
	// but also accept a wrapped shape for fixtures.
	const providers = asRecord(root.providers) ?? root;
	for (const [name, value] of Object.entries(providers)) {
		const prov = asRecord(value);
		if (!prov) continue;
		const modelsRaw = prov.models;
		if (!Array.isArray(modelsRaw)) continue;
		const models = modelsRaw.filter((m): m is Record<string, unknown> => asRecord(m) != null);
		out.set(name, { models });
	}
	return out;
}

function buildCandidates(
	piDir: string,
	auth: ReturnType<typeof loadPiAuth>,
	settings: {
		enabledModels: Set<string>;
		defaultModel: string | null;
	},
): {
	candidates: PiModelCandidate[];
	sawSupportedApi: boolean;
	sawUnsupportedOnly: boolean;
} {
	const fromJson = loadModelsJsonProviders(piDir);
	const fromStore = loadModelsStoreProviders(piDir);
	const providerNames = new Set([...fromJson.keys(), ...fromStore.keys()]);

	const candidates: PiModelCandidate[] = [];
	let sawSupportedApi = false;
	let sawAnyModelApi = false;
	let sawUnsupportedApi = false;

	for (const provider of providerNames) {
		const jsonProv = fromJson.get(provider);
		const storeProv = fromStore.get(provider);
		const authEntry = auth.byProvider.get(provider);

		// Credential: auth.json api_key wins, else models.json apiKey.
		// OAuth-only providers are skipped entirely.
		let apiKey: string | null = null;
		if (authEntry?.kind === "api_key") {
			apiKey = authEntry.key;
		} else if (jsonProv?.apiKey) {
			apiKey = jsonProv.apiKey;
		} else if (authEntry?.kind === "oauth") {
			// Tracked for oauth-only diagnosis; skip models.
			continue;
		} else {
			// No credential for this provider — skip.
			continue;
		}

		// Merge models: models.json first (user-defined), then store catalog ids not already present.
		const seenIds = new Set<string>();
		const mergedModels: Array<{
			model: Record<string, unknown>;
			providerBaseUrl: string | null;
			providerApi: string | null;
		}> = [];

		for (const model of jsonProv?.models ?? []) {
			const id = asString(model.id);
			if (!id || seenIds.has(id)) continue;
			seenIds.add(id);
			mergedModels.push({
				model,
				providerBaseUrl: jsonProv?.baseUrl ?? null,
				providerApi: jsonProv?.api ?? null,
			});
		}
		for (const model of storeProv?.models ?? []) {
			const id = asString(model.id);
			if (!id || seenIds.has(id)) continue;
			seenIds.add(id);
			mergedModels.push({
				model,
				providerBaseUrl: jsonProv?.baseUrl ?? asString(model.baseUrl),
				providerApi: jsonProv?.api ?? null,
			});
		}

		// Provider with apiKey in models.json but empty models list: nothing to pick.
		for (const { model, providerBaseUrl, providerApi } of mergedModels) {
			const modelId = asString(model.id);
			if (!modelId) continue;
			const wireApi = asString(model.api) ?? providerApi;
			if (!wireApi) continue;
			sawAnyModelApi = true;
			if (!SUPPORTED_WIRE_APIS.has(wireApi)) {
				sawUnsupportedApi = true;
				continue;
			}
			sawSupportedApi = true;

			const baseUrl = asString(model.baseUrl) ?? providerBaseUrl;
			const ref = `${provider}/${modelId}`;
			const enabled = settings.enabledModels.size === 0 ? true : settings.enabledModels.has(ref);
			const isDefault = settings.defaultModel === ref || settings.defaultModel === modelId;

			candidates.push({
				provider,
				modelId,
				baseUrl,
				wireApi,
				apiKey,
				declaredCost: declaredCostOf(model),
				nameTier: nameCostTier(modelId),
				enabled,
				isDefault,
			});
		}
	}

	return {
		candidates,
		sawSupportedApi,
		sawUnsupportedOnly: sawAnyModelApi && !sawSupportedApi && sawUnsupportedApi,
	};
}

function compareCheapFirst(a: PiModelCandidate, b: PiModelCandidate): number {
	// Prefer enabledModels membership when the set is in use.
	if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;

	// Numeric cost when both known.
	if (a.declaredCost != null && b.declaredCost != null && a.declaredCost !== b.declaredCost) {
		return a.declaredCost - b.declaredCost;
	}
	// Prefer known cost over unknown.
	if (a.declaredCost != null && b.declaredCost == null) return -1;
	if (a.declaredCost == null && b.declaredCost != null) return 1;

	// Name-pattern tier.
	if (a.nameTier !== b.nameTier) return a.nameTier - b.nameTier;

	// Never prefer the interactive default when another candidate exists:
	// sort non-default first so cheap-equal ties avoid defaultModel.
	if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;

	// Deterministic tie-break.
	const prov = a.provider.localeCompare(b.provider);
	if (prov !== 0) return prov;
	return a.modelId.localeCompare(b.modelId);
}

function toOk(c: PiModelCandidate): PiObserverResolveOk {
	return {
		ok: true,
		provider: c.provider,
		model: c.modelId,
		baseUrl: c.baseUrl,
		apiKey: c.apiKey,
		openAIUseResponses: c.wireApi === "openai-responses",
		wireApi: c.wireApi,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve observer provider/model/credential from a pi agent installation.
 *
 * Credentials are returned only on the in-memory result object. This function
 * never writes files and never logs secret values.
 */
export function resolvePiObserverConfig(
	input: PiObserverResolveInput = {},
): PiObserverResolveResult {
	const piDir = resolvePiAgentDir(input);
	const settingsRaw = readJsonObject(join(piDir, "settings.json")) ?? {};
	const enabledModels = new Set<string>();
	const enabledRaw = settingsRaw.enabledModels;
	if (Array.isArray(enabledRaw)) {
		for (const entry of enabledRaw) {
			const s = asString(entry);
			if (s) enabledModels.add(s);
		}
	}
	const defaultModel = asString(settingsRaw.defaultModel);

	const auth = loadPiAuth(piDir);
	const hasModelsJson = existsSync(join(piDir, "models.json"));
	const hasModelsStore = existsSync(join(piDir, "models-store.json"));
	const hasSettings = existsSync(join(piDir, "settings.json"));
	const hasAuth = existsSync(join(piDir, "auth.json"));

	if (!hasSettings && !hasModelsJson && !hasModelsStore && !hasAuth) {
		return {
			ok: false,
			reason: "not-configured",
			detail: `No pi agent configuration found at ${piDir}`,
		};
	}

	const { candidates, sawSupportedApi, sawUnsupportedOnly } = buildCandidates(piDir, auth, {
		enabledModels,
		defaultModel,
	});

	if (candidates.length > 0) {
		const sorted = [...candidates].sort(compareCheapFirst);
		const pick = sorted[0];
		if (pick) return toOk(pick);
	}

	// Diagnosis when nothing eligible.
	if (auth.sawOAuth && !auth.sawApiKey) {
		// models.json may still embed apiKey — already considered above.
		// If we truly have no api-key path:
		const jsonProvs = loadModelsJsonProviders(piDir);
		let embeddedKey = false;
		for (const p of jsonProvs.values()) {
			if (p.apiKey) {
				embeddedKey = true;
				break;
			}
		}
		if (!embeddedKey) {
			return {
				ok: false,
				reason: "oauth-only",
				detail:
					"pi auth.json contains only OAuth providers; codemem v1 cannot refresh OAuth. Set observer_provider/observer_model explicitly with an API-key provider.",
			};
		}
	}

	if (sawUnsupportedOnly || (!sawSupportedApi && (hasModelsJson || hasModelsStore))) {
		// Providers exist but none speak a supported wire API (and no eligible candidates).
		if (!auth.sawApiKey) {
			// fall through
		} else {
			return {
				ok: false,
				reason: "unsupported-api",
				detail:
					"Authenticated pi providers use unsupported wire APIs (need openai-completions, openai-responses, or anthropic-messages).",
			};
		}
	}

	if (!auth.sawApiKey) {
		const jsonProvs = loadModelsJsonProviders(piDir);
		let embeddedKey = false;
		for (const p of jsonProvs.values()) {
			if (p.apiKey) {
				embeddedKey = true;
				break;
			}
		}
		if (!embeddedKey) {
			return {
				ok: false,
				reason: auth.sawOAuth ? "oauth-only" : "no-api-key-provider",
				detail: auth.sawOAuth
					? "pi auth.json contains only OAuth providers; codemem v1 cannot refresh OAuth. Set observer_provider/observer_model explicitly with an API-key provider."
					: "No API-key authenticated pi provider found in auth.json or models.json.",
			};
		}
	}

	return {
		ok: false,
		reason: "not-configured",
		detail: `No eligible API-key model found under ${piDir}`,
	};
}

/**
 * One-line redacted status for setup/status output. Never includes secrets.
 */
export function describePiObserverStatus(result: PiObserverResolveResult | undefined): string {
	if (result == null) {
		return "unconfigured (pi observer not resolved)";
	}
	if (result.ok) {
		return `pi:${result.provider}/${result.model} via ${result.wireApi} (api-key)`;
	}
	switch (result.reason) {
		case "oauth-only":
			return "unconfigured (oauth-only); set observer_provider/observer_model explicitly";
		case "unsupported-api":
			return "unconfigured (unsupported-api); set observer_provider/observer_model explicitly";
		case "no-api-key-provider":
			return "unconfigured (no-api-key-provider); set observer_provider/observer_model explicitly";
		default:
			return "unconfigured (not-configured)";
	}
}
