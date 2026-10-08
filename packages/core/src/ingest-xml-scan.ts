/** Literal, forward-only extraction for the intentionally permissive legacy XML contract. */
export const MAX_OBSERVER_XML_CHARACTERS = 1024 * 1024;

export function assertObserverXmlSize(raw: string): void {
	if (raw.length > MAX_OBSERVER_XML_CHARACTERS) {
		throw new RangeError("observer_output_too_large");
	}
}

export interface XmlOpening {
	index: number;
	end: number;
}

function foldTagCase(raw: string): string {
	// Unicode lowercasing can change string length and invalidate source offsets.
	return raw.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function tagOpenings(
	raw: string,
	tag: string,
	options: { caseSensitive?: boolean; prefix?: boolean } = {},
): XmlOpening[] {
	const source = options.caseSensitive ? raw : foldTagCase(raw);
	const needle = `<${tag}`;
	const openings: XmlOpening[] = [];
	let cursor = 0;
	let bracket = -1;
	while (cursor < source.length) {
		const index = source.indexOf(needle, cursor);
		if (index < 0) break;
		cursor = index + needle.length;
		if (!options.prefix && !/[\s/>]/.test(source[cursor] ?? "")) continue;
		if (bracket < cursor) bracket = source.indexOf(">", cursor);
		if (bracket < 0) break;
		openings.push({ index, end: bracket + 1 });
	}
	return openings;
}

export function completeTagBlocks(
	raw: string,
	tag: string,
	options: { caseSensitive?: boolean; prefix?: boolean } = {},
): Array<{ index: number; value: string }> {
	const source = options.caseSensitive ? raw : foldTagCase(raw);
	const closing = `</${tag}>`;
	const blocks: Array<{ index: number; value: string }> = [];
	let cursor = 0;
	for (const opening of tagOpenings(raw, tag, options)) {
		if (opening.index < cursor) continue;
		const end = source.indexOf(closing, opening.end);
		// No later opening can succeed without a closing tag either.
		if (end < 0) break;
		cursor = end + closing.length;
		blocks.push({ index: opening.index, value: raw.slice(opening.index, cursor) });
	}
	return blocks;
}

export function firstTagContent(raw: string, tag: string): string | null {
	const opening = tagOpenings(raw, tag)[0];
	if (!opening) return null;
	const end = foldTagCase(raw).indexOf(`</${tag}>`, opening.end);
	return end < 0 ? null : raw.slice(opening.end, end);
}

/** Find the first indexed position at or after a cursor without rescanning a suffix. */
export function positionAtOrAfter(positions: number[], cursor: number): number | undefined {
	return positions[positionIndexAtOrAfter(positions, cursor)];
}

export function positionIndexAtOrAfter(positions: number[], cursor: number): number {
	let low = 0;
	let high = positions.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((positions[middle] ?? 0) < cursor) low = middle + 1;
		else high = middle;
	}
	return low;
}

export function closingTagPositions(raw: string): Map<string, number[]> {
	const positions = new Map<string, number[]>();
	for (const match of raw.matchAll(/<\/([A-Za-z_][\w:.-]*)>/g)) {
		const tag = match[1]?.toLowerCase();
		if (!tag) continue;
		const indexes = positions.get(tag) ?? [];
		indexes.push(match.index);
		positions.set(tag, indexes);
	}
	return positions;
}

/**
 * Compute quote-aware opening ends backwards in one pass. An unmatched quote
 * falls back to the first bracket, matching legacy incomplete-attribute recovery.
 * Retaining only requested starts avoids allocating per-character tables.
 */
export function openingTagEnds(raw: string, starts: number[]): Map<number, number> {
	const requested = new Set(starts);
	const ends = new Map<number, number>();
	let unquoted = -1;
	let singleQuoted = -1;
	let doubleQuoted = -1;
	let bracket = -1;
	for (let index = raw.length - 1; index >= 0; index -= 1) {
		const character = raw[index];
		if (character === ">") {
			bracket = index;
			unquoted = index;
		} else if (character === "'") {
			[unquoted, singleQuoted] = [singleQuoted, unquoted];
		} else if (character === '"') {
			[unquoted, doubleQuoted] = [doubleQuoted, unquoted];
		}
		if (requested.has(index)) ends.set(index, unquoted < 0 ? bracket : unquoted);
	}
	return ends;
}
