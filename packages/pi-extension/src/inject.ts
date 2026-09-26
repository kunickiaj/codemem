/**
 * Cache-stable memory injection for pi's `context` event.
 *
 * Replays the exact framed bytes already decided for older user messages and
 * fetches at most one new pack for the latest undecided user message, appending
 * the block to that message only. Mutates the request copy in place and never
 * returns anything — a context handler that returns { messages } drops system
 * messages on Pi 0.84 and collapses them mid-conversation on Pi 0.87.
 *
 * Decisions live in memory for this extension instance only. A restart starts
 * with an empty cache and is not cache-safe; older messages replay again only
 * after new decisions build up.
 */

import type { PiCodememClient } from "./client.js";
import type { PiExtensionConfig } from "./config.js";
import {
	CODEMEM_MEMORIES_HEADER,
	extractMessageRole,
	extractMessageText,
	formatPiInjectionBlock,
	stableMessageEntryId,
} from "./payloads.js";

/** Structural view of a pi AgentMessage (pi-agent-core types are not a dependency). */
export type PiContextMessage = {
	role?: unknown;
	content?: unknown;
	timestamp?: unknown;
};

export type PiInjector = {
	/** Mutates the given request-copy messages in place; returns nothing. */
	inject(messages: PiContextMessage[], signal?: AbortSignal): Promise<void>;
	/**
	 * One-shot replay skip. Arm only after session_compact with willRetry.
	 * The next inject replays and does not fetch.
	 */
	noteCompaction(): void;
	/** Drop a replay skip that will not be the immediate resume. */
	clearCompaction(): void;
	/** Re-key decision identity on session_start. */
	rekey(sessionId: string): void;
};

type InjectDecision = {
	/** Framed block bytes attached for this message; "" records an inject-nothing decision. */
	block: string;
	/** Item fingerprints cut out of later packs; empty when spans were missing, malformed, or truncated. */
	fingerprints: string[];
};

type InjectUser = {
	message: PiContextMessage;
	text: string;
	key: string;
};

const INJECT_NOTHING: InjectDecision = { block: "", fingerprints: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** ceil(chars / 4) — the OpenCode plugin's estimate, not a provider tokenizer. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * OpenCode resolveRetainedTokenBudget: unset, invalid, zero, and negative mean
 * no cap. Only an explicit positive integer (decimal digits) enables the ceiling.
 */
function resolveRetainedTokenBudget(value: string | undefined): number {
	const text = String(value ?? "").trim();
	const parsed = Number(text);
	return /^\d+$/.test(text) && Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: Number.POSITIVE_INFINITY;
}

/** Validate one rendered item's fingerprint and spans; null when malformed. */
function validatedItemSpans(
	packText: string,
	item: unknown,
	seen: Set<number>,
): { id: number; fingerprint: string; spans: Array<{ start: number; end: number }> } | null {
	if (
		!isRecord(item) ||
		typeof item.id !== "number" ||
		!Number.isSafeInteger(item.id) ||
		item.id <= 0 ||
		seen.has(item.id) ||
		!/^[a-f0-9]{64}$/.test(String(item.fingerprint)) ||
		!Array.isArray(item.spans) ||
		!item.spans.length
	) {
		return null;
	}
	const spans: Array<{ start: number; end: number }> = [];
	for (const span of item.spans) {
		if (
			!isRecord(span) ||
			typeof span.start !== "number" ||
			typeof span.end !== "number" ||
			!Number.isSafeInteger(span.start) ||
			!Number.isSafeInteger(span.end) ||
			span.start < 0 ||
			span.end <= span.start ||
			span.end > packText.length
		) {
			return null;
		}
		spans.push({ start: span.start, end: span.end });
	}
	return { id: item.id, fingerprint: String(item.fingerprint), spans };
}

/**
 * OpenCode filterRetainedPack span validation, narrowed to the fields the pi
 * client carries (rendered items + metrics.total_items). Missing or malformed
 * span data keeps the full text and records no fingerprints — never guess
 * which prose to cut.
 */
function filterRetainedPack(
	packText: string,
	renderedItems: unknown,
	itemCount: unknown,
	retained: Set<string>,
): { text: string; fingerprints: string[] } {
	const fallback = { text: packText, fingerprints: [] as string[] };
	if (!Array.isArray(renderedItems) || !renderedItems.length) return fallback;
	if (itemCount !== renderedItems.length) return fallback;
	const valid: Array<{ id: number; fingerprint: string }> = [];
	const spans: Array<{ start: number; end: number; omit: boolean }> = [];
	const seen = new Set<number>();
	for (const item of renderedItems) {
		const parsed = validatedItemSpans(packText, item, seen);
		if (!parsed) return fallback;
		seen.add(parsed.id);
		const omit = retained.has(`${parsed.id}:${parsed.fingerprint}`);
		for (const span of parsed.spans) spans.push({ ...span, omit });
		valid.push({ id: parsed.id, fingerprint: parsed.fingerprint });
	}
	spans.sort((a, b) => a.start - b.start);
	if (spans.some((span, index) => index > 0 && span.start < (spans[index - 1]?.end ?? 0))) {
		return fallback;
	}
	const kept = valid.filter((item) => !retained.has(`${item.id}:${item.fingerprint}`));
	let text = packText;
	for (const span of spans.reverse()) {
		if (span.omit) text = text.slice(0, span.start) + text.slice(span.end);
	}
	return {
		text: kept.length ? text : "",
		fingerprints: kept.map(({ id, fingerprint }) => `${id}:${fingerprint}`),
	};
}

/**
 * Append-only attachment: string content concatenates, array content pushes
 * one text block. Never converts a string message into blocks — that would
 * change the bytes a later replay must reproduce.
 */
function appendBlockToMessage(message: PiContextMessage, block: string): void {
	if (typeof message.content === "string") {
		message.content = `${message.content}\n\n${block}`;
		return;
	}
	if (Array.isArray(message.content)) {
		message.content.push({ type: "text", text: block });
	}
}

function collectUsers(
	messages: PiContextMessage[],
	sessionId: string,
	discriminator: (message: PiContextMessage) => string | number,
): InjectUser[] {
	return messages
		.filter((message) => extractMessageRole(message) === "user")
		.map((message) => {
			const text = extractMessageText(message);
			return {
				message,
				text,
				key: stableMessageEntryId(sessionId, "user", text, discriminator(message)),
			};
		});
}

/** Compaction: drop cache entries whose user messages are no longer present. */
function dropDecisionsForAbsentMessages(
	decisions: Map<string, InjectDecision>,
	users: InjectUser[],
): void {
	const present = new Set(users.map((user) => user.key));
	for (const key of [...decisions.keys()]) {
		if (!present.has(key)) decisions.delete(key);
	}
}

/** Attach one decided user message's block; returns its token estimate (0 when skipped). */
function replayDecision(
	decisions: Map<string, InjectDecision>,
	user: InjectUser,
	attached: Set<PiContextMessage>,
	retained: Set<string>,
): number {
	if (attached.has(user.message)) return 0;
	const decision = decisions.get(user.key);
	if (!decision) return 0;
	attached.add(user.message);
	if (!decision.block) return 0;
	appendBlockToMessage(user.message, decision.block);
	for (const fingerprint of decision.fingerprints) retained.add(fingerprint);
	return estimateTokens(decision.block);
}

/**
 * Retained-token ceiling (OpenCode parity): a full ceiling attaches nothing
 * new and must not spawn a pack fetch that cannot be attached. Null means skip.
 */
function packRequestBudget(
	config: PiExtensionConfig,
	retainedTokenBudget: number,
	headerTokens: number,
	retainedTokens: number,
): { allowance: number | null; packBudget: number } | null {
	if (retainedTokenBudget === Number.POSITIVE_INFINITY) {
		return { allowance: null, packBudget: config.injectTokenBudget };
	}
	const remaining = retainedTokenBudget - retainedTokens;
	if (!(remaining > 0)) return null;
	const allowance = Math.min(config.injectTokenBudget, remaining);
	const packBudget = allowance - headerTokens;
	// Never forward a non-positive pack budget; the header alone cannot fit.
	if (!(packBudget > 0)) return null;
	return { allowance, packBudget };
}

async function fetchDecision(
	client: PiCodememClient,
	config: PiExtensionConfig,
	query: string,
	allowance: number | null,
	packBudget: number,
	retained: Set<string>,
	signal?: AbortSignal,
): Promise<InjectDecision> {
	try {
		const pack = await client.fetchPackText(query, signal, { tokenBudget: packBudget });
		if (!pack.text.trim()) return INJECT_NOTHING;
		const dedup = filterRetainedPack(pack.text, pack.renderedItems, pack.itemCount, retained);
		if (!dedup.text.trim()) return INJECT_NOTHING;
		if (pack.preformatted) return { block: dedup.text, fingerprints: dedup.fingerprints };
		const block = formatPiInjectionBlock(dedup.text, config.injectMaxChars);
		const bodyMaxChars = config.injectMaxChars - CODEMEM_MEMORIES_HEADER.length;
		const truncated = bodyMaxChars <= 0 || dedup.text.trim().length > bodyMaxChars;
		if (truncated) return { block, fingerprints: [] };
		if (allowance != null && estimateTokens(block) > allowance) return INJECT_NOTHING;
		return { block, fingerprints: dedup.fingerprints };
	} catch {
		return INJECT_NOTHING;
	}
}

export function createPiInjector(options: {
	client: PiCodememClient;
	config: PiExtensionConfig;
	/**
	 * Timestamp when the message has one. When it does not, a fresh id that is
	 * not the ingest counter, so a missing timestamp is not cached.
	 */
	discriminator: (message: PiContextMessage) => string | number;
}): PiInjector {
	const { client, config, discriminator } = options;
	/** Decision key (stableMessageEntryId) → frozen decision. */
	const decisions = new Map<string, InjectDecision>();
	let compactionPending = false;
	let sessionId: string | null = null;
	const retainedTokenBudget = resolveRetainedTokenBudget(
		process.env.CODEMEM_INJECT_RETAINED_TOKEN_BUDGET,
	);
	const headerTokens = estimateTokens(CODEMEM_MEMORIES_HEADER);

	async function inject(messages: PiContextMessage[], signal?: AbortSignal): Promise<void> {
		if (!sessionId) return;
		const oneShotCompaction = compactionPending;
		compactionPending = false;

		const users = collectUsers(messages, sessionId, discriminator);
		if (oneShotCompaction) dropDecisionsForAbsentMessages(decisions, users);
		if (!users.length) return;

		const attached = new Set<PiContextMessage>();
		const retained = new Set<string>();
		let retainedTokens = 0;
		const replay = () => {
			for (const user of users) {
				retainedTokens += replayDecision(decisions, user, attached, retained);
			}
		};

		replay();
		if (oneShotCompaction) return;
		const latest = users[users.length - 1];
		if (!latest) return;
		if (decisions.has(latest.key)) return;

		const budget = packRequestBudget(config, retainedTokenBudget, headerTokens, retainedTokens);
		if (!budget) return;

		const decision = await fetchDecision(
			client,
			config,
			latest.text,
			budget.allowance,
			budget.packBudget,
			retained,
			signal,
		);
		decisions.set(latest.key, decision);
		replay(); // replay again after the await — attaches the new decision too
	}

	return {
		inject,
		noteCompaction() {
			compactionPending = true;
		},
		clearCompaction() {
			compactionPending = false;
		},
		rekey(nextSessionId: string) {
			sessionId = nextSessionId;
			decisions.clear();
			compactionPending = false;
		},
	};
}
