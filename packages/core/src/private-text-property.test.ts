import { describe, expect, it } from "vitest";
import { stripPrivate } from "./private-text.js";

/*
 * Seeded property test for the private-text lexer, run against core and against the
 * copy each plugin ships. A failure prints the seed, the case number and the input,
 * so the case can be replayed with the same seed.
 */

const SEED = 0x5eed_2026;
const CASES = 4_000;
const LARGE_INPUT_CHARS = 1_000_000;
const LARGE_INPUT_BOUND_MS = 2_000;

type Strip = (text: string) => string;

const copies: Array<[string, string]> = [
	["claude", "plugins/claude/scripts/codemem-private-text.mjs"],
	["codex", "plugins/codex/scripts/codemem-private-text.mjs"],
	["opencode", "packages/opencode-plugin/.opencode/lib/private-text.mjs"],
];

async function implementations(): Promise<Array<[string, Strip]>> {
	const loaded: Array<[string, Strip]> = [["core", stripPrivate]];
	for (const [name, path] of copies) {
		const copy = await import(new URL(`../../../${path}`, import.meta.url).href);
		loaded.push([name, copy.stripPrivate as Strip]);
	}
	return loaded;
}

/** Mulberry32: small, fast and deterministic for a fixed seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const OPENERS = [
	"<private>",
	"<PRIVATE>",
	"< private >",
	'<private reason="a > b">',
	"<private note='</private>'>",
	'<Private data-x="<private>">',
];
const CLOSERS = ["</private>", "</PRIVATE>", "</ private >", '</private note=">">'];
const SELF_CLOSING = [
	"<private/>",
	"<private />",
	'<private note="</private>"/>',
	"<private note='<private>' />",
];
/** Non-private tags, comments and CDATA whose quoted parts or bodies look like markers. */
const OTHER_TAGS = [
	'<span title="</private>">',
	"<a href='<private>'>",
	'<b data-x="1 > 0">',
	"</span>",
	"<br/>",
	"<i class='x' title=\"</private>\">",
	"<!-- </private> -->",
	"<![CDATA[ </private> ]]>",
];
const ENTITY_LIKE = ["&lt;private&gt;", "&lt;/private&gt;", "&amp;", "\\u003c/private\\u003e"];
/** Text outside tags; quotes and `>` there are ordinary characters. */
const LOOSE = [">", '"', "'", " > ", "plain ", "x = 1; "];
/** A `<` starting no tag. Inside a block it is placed only right before another tag. */
const STRAY_LESS_THAN = ["<", "< ", "<3 "];

function pick<T>(next: () => number, items: readonly T[]): T {
	return items[Math.floor(next() * items.length)] as T;
}

/** Block content: plain text with the sentinel, nested blocks, tags and loose characters. */
function inner(next: () => number, sentinel: string, depth: number): string {
	let text = "";
	const count = 1 + Math.floor(next() * 6);
	for (let part = 0; part < count; part += 1) {
		const roll = next();
		if (roll < 0.2) text += ` ${sentinel} `;
		else if (roll < 0.32 && depth < 3) text += block(next, sentinel, depth + 1);
		else if (roll < 0.44) text += pick(next, SELF_CLOSING);
		else if (roll < 0.62) text += pick(next, OTHER_TAGS);
		else if (roll < 0.72) text += pick(next, ENTITY_LIKE);
		else if (roll < 0.82) text += `${pick(next, STRAY_LESS_THAN)}${pick(next, OTHER_TAGS)}`;
		else text += pick(next, LOOSE);
	}
	return `${text} ${sentinel}`;
}

function block(next: () => number, sentinel: string, depth: number): string {
	return `${pick(next, OPENERS)}${inner(next, sentinel, depth)}${pick(next, CLOSERS)}`;
}

/** Text around a block, without the sentinel. */
function outside(next: () => number): string {
	const parts = [...LOOSE, ...ENTITY_LIKE, "<span>", "</span>", "word ", "<", "< ", "<3"];
	let text = "";
	const count = Math.floor(next() * 4);
	for (let part = 0; part < count; part += 1) text += pick(next, parts);
	return text;
}

/** Values with no private marker: the word, other tag names, escapes and `<private/>`. */
function markerFree(next: () => number): string {
	const parts = [
		...LOOSE,
		"keep private data ",
		"privately ",
		"<private-notes>",
		"</private-notes>",
		'<private_note x="1">',
		"<private/>",
		"&lt;private&gt;",
		'<span title="x > y">',
		"< ",
		"<3",
		"<!-- note -->",
	];
	let text = "";
	const count = 1 + Math.floor(next() * 8);
	for (let part = 0; part < count; part += 1) text += pick(next, parts);
	return text;
}

/** True when `output` is `input` with characters removed and nothing added or moved. */
function isSubsequence(output: string, input: string): boolean {
	let at = 0;
	for (const char of output) {
		at = input.indexOf(char, at);
		if (at === -1) return false;
		at += 1;
	}
	return true;
}

function failure(name: string, index: number, input: string, output: string): string {
	return `${name} seed=0x${SEED.toString(16)} case=${index} input=${JSON.stringify(input)} output=${JSON.stringify(output)}`;
}

const loaded = await implementations();

describe("private-text lexer properties", () => {
	it.each(loaded)("%s never keeps text written inside a block", (name, strip) => {
		const next = random(SEED);
		for (let index = 0; index < CASES; index += 1) {
			const sentinel = `SENTINEL${index}Z`;
			const input = `${outside(next)}${block(next, sentinel, 1)}${outside(next)}`;
			const output = strip(input);

			expect(output.includes(sentinel), failure(name, index, input, output)).toBe(false);
			expect(isSubsequence(output, input), failure(name, index, input, output)).toBe(true);
		}
	});

	it.each(loaded)("%s returns a value without markers unchanged", (name, strip) => {
		const next = random(SEED ^ 0x1234_5678);
		for (let index = 0; index < CASES; index += 1) {
			const input = markerFree(next);

			expect(strip(input), failure(name, index, input, strip(input))).toBe(input);
		}
	});

	const largeInputs: Array<[string, string]> = [
		["quoted closers in other tags", `<private>${'<span title="</private>">'.repeat(40_000)}`],
		["deep nesting", `${"<private>".repeat(50_000)}${"</private>".repeat(50_000)}`],
		["bare < inside a block", `<private>${"<".repeat(LARGE_INPUT_CHARS)}`],
		["unclosed quotes in openers", "<private x='".repeat(LARGE_INPUT_CHARS / 12)],
		["unterminated comments", `<private>${"<!--".repeat(LARGE_INPUT_CHARS / 4)}`],
		["self-closing tags", "<private/>".repeat(LARGE_INPUT_CHARS / 10)],
		["long tag names", `${"<privat".repeat(LARGE_INPUT_CHARS / 7)}private`],
		["spaced openers", "< private ".repeat(LARGE_INPUT_CHARS / 10)],
	];

	it.each(loaded)("%s finishes 1 MB adversarial inputs within the bound", (name, strip) => {
		for (const [shape, input] of largeInputs) {
			const started = performance.now();
			strip(input);
			const elapsed = performance.now() - started;

			expect(elapsed, `${name}: ${shape} took ${Math.round(elapsed)} ms`).toBeLessThan(
				LARGE_INPUT_BOUND_MS,
			);
		}
	});
});
