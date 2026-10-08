interface Transition {
	to: number;
	matches: (character: string) => boolean;
}

interface State {
	empty: number[];
	transitions: Transition[];
}

type Graph = State[];

const matchesDot = (character: string): boolean =>
	!["\n", "\r", "\u2028", "\u2029"].includes(character);
const matchesSegment = (character: string): boolean => character !== "/";

function addState(graph: Graph): number {
	graph.push({ empty: [], transitions: [] });
	return graph.length - 1;
}

function addTransition(
	graph: Graph,
	from: number,
	to: number,
	matches: Transition["matches"],
): void {
	graph[from]?.transitions.push({ to, matches });
}

function compileStar(
	graph: Graph,
	from: number,
	to: number,
	options: { globstar: boolean; slash: boolean },
): void {
	graph[from]?.empty.push(to);
	const loop = options.slash ? addState(graph) : from;
	if (options.slash) {
		graph[from]?.empty.push(loop);
		addTransition(graph, loop, to, (character) => character === "/");
	}
	addTransition(graph, loop, loop, options.globstar ? matchesDot : matchesSegment);
}

function compileClass(
	graph: Graph,
	pattern: string,
	index: number,
	from: number,
	to: number,
): number {
	const token = readClassToken(pattern, index);
	if (!token) {
		addTransition(graph, from, to, (character) => character === "[");
		return index;
	}
	// Only a single character class reaches RegExp, never wildcard quantifiers.
	const source = token.content.startsWith("!") ? `^${token.content.slice(1)}` : token.content;
	const expression = new RegExp(`^[${source}]$`, "u");
	addTransition(graph, from, to, (character) => expression.test(character));
	return token.end;
}

function isEscapedDelimiter(pattern: string, index: number): boolean {
	let backslashes = 0;
	for (let previous = index - 1; previous >= 0 && pattern[previous] === "\\"; previous -= 1) {
		backslashes += 1;
	}
	return backslashes % 2 === 1;
}

function readExtendedClass(
	pattern: string,
	opening: number,
	firstClosing: number,
): {
	content: string;
	end: number;
} {
	let suffix = "";
	for (let index = firstClosing + 1; index < pattern.length; index += 1) {
		const character = pattern[index] ?? "";
		if (character === "]") {
			return { content: pattern.slice(opening + 1, firstClosing + 1) + suffix, end: index };
		}
		// The old parser expanded these tokens while its regex class was still
		// open. Reject that ambiguous language instead of emitting regex syntax.
		if ("*?{}[\\".includes(character)) throw new SyntaxError("Ambiguous extended glob class");
		// Preserve the old outside-class literal escaping in the extended suffix.
		suffix += character.replace(/[\^$+.()|]/gu, "\\$&");
	}
	throw new SyntaxError("Unterminated glob class");
}

function readClassToken(pattern: string, index: number): { content: string; end: number } | null {
	const closing = pattern.indexOf("]", index + 1);
	if (closing === -1) return null;
	if (isEscapedDelimiter(pattern, closing)) return readExtendedClass(pattern, index, closing);
	return { content: pattern.slice(index + 1, closing), end: closing };
}

function compileAlternatives(
	graph: Graph,
	pattern: string,
	index: number,
	from: number,
	to: number,
): number {
	const closing = pattern.indexOf("}", index + 1);
	if (closing === -1) {
		addTransition(graph, from, to, (character) => character === "{");
		return index;
	}
	// Preserve the previous parser's first-closing-brace, comma-split language.
	for (const alternative of pattern.slice(index + 1, closing).split(",")) {
		compileSequence(graph, alternative, from, to);
	}
	return closing;
}

function compileToken(
	graph: Graph,
	pattern: string,
	index: number,
	from: number,
	to: number,
): number {
	const current = String.fromCodePoint(pattern.codePointAt(index) ?? 0);
	if (current === "[") return compileClass(graph, pattern, index, from, to);
	if (current === "{") return compileAlternatives(graph, pattern, index, from, to);
	if (current === "?") {
		addTransition(graph, from, to, matchesSegment);
		return index;
	}
	if (current === "*") {
		const globstar = pattern[index + 1] === "*";
		const slash = globstar && pattern[index + 2] === "/";
		compileStar(graph, from, to, { globstar, slash });
		return index + Number(globstar) + Number(slash);
	}
	// As before, unmatched closing delimiters are invalid Unicode regex syntax.
	if (current === "]" || current === "}") throw new SyntaxError("Invalid glob delimiter");
	addTransition(graph, from, to, (character) => character === current);
	return index + current.length - 1;
}

function compileSequence(graph: Graph, pattern: string, from: number, to: number): void {
	const lastClosing: Record<string, number> = {
		"[": pattern.lastIndexOf("]"),
		"{": pattern.lastIndexOf("}"),
	};
	// A branch's leading star must not loop on the shared alternative entry.
	// Otherwise it can consume input and then switch to a sibling alternative.
	let current = addState(graph);
	graph[from]?.empty.push(current);
	for (let index = 0; index < pattern.length; index += 1) {
		const next = addState(graph);
		const character = pattern[index] ?? "";
		const closing = lastClosing[character];
		// Avoid rescanning the entire suffix for each unmatched opening delimiter.
		if (closing !== undefined && index > closing) {
			addTransition(graph, current, next, (value) => value === character);
		} else {
			index = compileToken(graph, pattern, index, current, next);
		}
		current = next;
	}
	graph[current]?.empty.push(to);
}

function emptyClosure(graph: Graph, seeds: Set<number>): Set<number> {
	const reached = new Set(seeds);
	const pending = [...seeds];
	while (pending.length > 0) {
		const state = pending.pop();
		if (state === undefined) break;
		for (const next of graph[state]?.empty ?? []) {
			if (reached.has(next)) continue;
			reached.add(next);
			pending.push(next);
		}
	}
	return reached;
}

/** NFA simulation merges all paths at each character instead of backtracking.
 * Graph size is linear in pattern size (brace branches are not expanded into
 * combinations). Matching takes O(pattern × path) time and O(pattern) space.
 */
export function matchesBiomeGlob(pattern: string, path: string): boolean {
	const graph: Graph = [];
	const start = addState(graph);
	const end = addState(graph);
	compileSequence(graph, pattern, start, end);
	let active = emptyClosure(graph, new Set([start]));
	for (const character of path) {
		const next = new Set<number>();
		for (const state of active) {
			for (const transition of graph[state]?.transitions ?? []) {
				if (transition.matches(character)) next.add(transition.to);
			}
		}
		active = emptyClosure(graph, next);
		if (active.size === 0) return false;
	}
	return active.has(end);
}
