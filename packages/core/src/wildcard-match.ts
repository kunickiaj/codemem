const matchesDot = (character: string): boolean =>
	!["\n", "\r", "\u2028", "\u2029"].includes(character);

function matchesSingle(token: string, character: string): boolean {
	return token === "?" ? matchesDot(character) : token === character;
}

function advanceWildcardRow(previous: Uint8Array, token: string, characters: string[]): Uint8Array {
	const next = new Uint8Array(characters.length + 1);
	if (token === "*") next[0] = previous[0] ?? 0;
	for (let index = 1; index <= characters.length; index += 1) {
		const character = characters[index - 1] ?? "";
		if (token === "*") {
			next[index] = previous[index] || (next[index - 1] && matchesDot(character)) ? 1 : 0;
		} else if (matchesSingle(token, character)) {
			next[index] = previous[index - 1] ?? 0;
		}
	}
	return next;
}

/** Match the legacy wildcard language without exploring wildcard partitions.
 * Each pattern/input pair is visited once: O(pattern × input) time,
 * O(pattern + input) space for tokens and the current/previous rows.
 * Scope resolution historically used UTF-16 units; recipient projection used /u.
 */
export function matchesWildcard(
	identity: string,
	pattern: string,
	options: { unicode: boolean },
): boolean {
	const characters = options.unicode ? Array.from(identity) : identity.split("");
	const tokens = options.unicode ? Array.from(pattern) : pattern.split("");
	let previous: Uint8Array = new Uint8Array(characters.length + 1);
	previous[0] = 1;
	for (const token of tokens) {
		previous = advanceWildcardRow(previous, token, characters);
	}
	return previous[characters.length] === 1;
}
