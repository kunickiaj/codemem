import type { DistillCandidate } from "./distill.js";

/**
 * Injected LLM call. Returns the model's raw text, or null when unavailable.
 * Kept abstract so core stays pure and testable; the CLI wires this to the
 * configured observer runtime (api_http / claude_sidecar / codex_sidecar).
 */
export type DistillRuleDrafter = (system: string, user: string) => Promise<string | null>;

export interface DistillDraftPrompt {
	system: string;
	user: string;
}

export interface DistillDraftResult {
	/** The drafted one-line rule, or null when the model declined (SKIP) or failed. */
	rule: string | null;
	/** Raw model output, for debugging/--json. */
	raw: string | null;
}

export interface DistillApplyResult {
	/** The new full file text after inserting the rule. */
	text: string;
	/** False when the rule was already present (no-op). */
	changed: boolean;
}

export const DISTILL_LESSONS_HEADING = "## Distilled lessons";
// codemem-owned markers so every distilled edit lives in one delimited block
// that is trivial to find, update, or rewrite (matches the repo's existing
// <!-- ...:begin/end --> convention).
export const DISTILL_BLOCK_BEGIN = "<!-- codemem:distilled:begin -->";
export const DISTILL_BLOCK_END = "<!-- codemem:distilled:end -->";
const MAX_RULE_CHARS = 200;
const MAX_EVIDENCE_FOR_PROMPT = 8;
const SKIP_TOKEN = "SKIP";

export function buildDistillDraftPrompt(candidate: DistillCandidate): DistillDraftPrompt {
	const system = [
		"You convert a recurring engineering lesson into a single durable rule for an AGENTS.md context file.",
		"Output exactly one line: an imperative rule with no preamble and no markdown bullet, at most 200 characters.",
		"It must be specific and actionable so an AI coding agent can follow it without the original evidence.",
		`If the evidence is too vague or generic to form a useful rule, output the single word: ${SKIP_TOKEN}.`,
	].join("\n");

	const evidence = candidate.evidence
		.slice(0, MAX_EVIDENCE_FOR_PROMPT)
		.map((item) => `- ${item}`)
		.join("\n");

	const user = [
		`Scope: ${candidate.scope}`,
		`Projects: ${candidate.projects.join(", ") || "(unknown)"}`,
		`Concepts: ${candidate.concepts.join(", ") || "(none)"}`,
		`Times observed: ${candidate.recurrence}`,
		"",
		"Recurring observations:",
		evidence || "(no evidence)",
	].join("\n");

	return { system, user };
}

/** Normalize a model response into a single clean rule line, or null. */
export function sanitizeRuleLine(text: string | null | undefined): string | null {
	if (!text) return null;
	const firstLine = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return null;

	let rule = firstLine
		.replace(/^[-*+]\s+/, "") // strip markdown bullet
		.replace(/^\d+[.)]\s+/, "") // strip numbered list marker
		.replace(/^["'`]+|["'`]+$/g, "") // strip surrounding quotes/backticks
		.replace(/\s+/g, " ")
		.trim();

	if (!rule || rule.toUpperCase() === SKIP_TOKEN) return null;
	if (rule.length > MAX_RULE_CHARS) rule = `${rule.slice(0, MAX_RULE_CHARS - 1).trimEnd()}…`;
	return rule;
}

export async function draftDistillRule(
	candidate: DistillCandidate,
	drafter: DistillRuleDrafter,
): Promise<DistillDraftResult> {
	const { system, user } = buildDistillDraftPrompt(candidate);
	const raw = await drafter(system, user);
	return { rule: sanitizeRuleLine(raw), raw: raw ?? null };
}

/**
 * Insert a rule bullet into the codemem-managed block of a context file.
 * Append-only and idempotent: if the rule already exists the file is unchanged.
 * All distilled edits stay inside the begin/end markers so the block is easy to
 * locate and rewrite later.
 */
export function applyDistillRule(currentText: string, rule: string): DistillApplyResult {
	const bullet = `- ${rule}`;
	const existing = currentText ?? "";

	const beginIdx = existing.indexOf(DISTILL_BLOCK_BEGIN);
	const endIdx = existing.indexOf(DISTILL_BLOCK_END);

	if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
		// Rebuild the managed block from its existing bullets plus the new one.
		const before = existing.slice(0, beginIdx + DISTILL_BLOCK_BEGIN.length);
		const inner = existing.slice(beginIdx + DISTILL_BLOCK_BEGIN.length, endIdx);
		const after = existing.slice(endIdx);
		const bullets = inner
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (bullets.includes(bullet)) return { text: existing, changed: false };
		const rebuilt = `\n${[...bullets, bullet].join("\n")}\n`;
		return { text: `${before}${rebuilt}${after}`, changed: true };
	}

	const managedBlock = `${DISTILL_LESSONS_HEADING}\n\n${DISTILL_BLOCK_BEGIN}\n${bullet}\n${DISTILL_BLOCK_END}\n`;
	const trimmed = existing.replace(/\s+$/, "");
	if (trimmed.length === 0) return { text: managedBlock, changed: true };
	return { text: `${trimmed}\n\n${managedBlock}`, changed: true };
}

function commonPrefix(a: string[], b: string[]): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) i += 1;
	return i;
}

function commonSuffix(a: string[], b: string[], used: number): number {
	const max = Math.min(a.length, b.length) - used;
	let i = 0;
	while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
	return i;
}

/**
 * Render a minimal single-hunk unified diff for a localized change (our edits
 * only insert lines, so one hunk is exact). Uses /dev/null for empty originals.
 */
export function renderUnifiedDiff(
	displayPath: string,
	oldText: string,
	newText: string,
	context = 3,
): string {
	if (oldText === newText) return "";

	const oldLines = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
	const newLines = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");

	const prefix = commonPrefix(oldLines, newLines);
	const suffix = commonSuffix(oldLines, newLines, prefix);

	const preStart = Math.max(0, prefix - context);
	const pre = oldLines.slice(preStart, prefix);
	const removed = oldLines.slice(prefix, oldLines.length - suffix);
	const added = newLines.slice(prefix, newLines.length - suffix);
	const postEnd = Math.min(oldLines.length, oldLines.length - suffix + context);
	const post = oldLines.slice(oldLines.length - suffix, postEnd);

	const oldStart = oldLines.length === 0 ? 0 : preStart + 1;
	const newStart = newLines.length === 0 ? 0 : preStart + 1;
	const oldCount = pre.length + removed.length + post.length;
	const newCount = pre.length + added.length + post.length;

	const header = [
		`--- ${oldText === "" ? "/dev/null" : `a/${displayPath}`}`,
		`+++ b/${displayPath}`,
		`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
	];
	const body = [
		...pre.map((line) => ` ${line}`),
		...removed.map((line) => `-${line}`),
		...added.map((line) => `+${line}`),
		...post.map((line) => ` ${line}`),
	];
	return [...header, ...body].join("\n");
}
