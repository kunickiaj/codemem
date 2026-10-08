import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { matchesBiomeGlob } from "./biome-glob.js";

// Compatibility oracle: the replaced parser, used only with short patterns.
function oldDelimitedToken(pattern: string, index: number): { source: string; end: number } {
	const current = pattern[index];
	const closing = pattern.indexOf(current === "[" ? "]" : "}", index + 1);
	if (closing === -1) return { source: `\\${current}`, end: index };
	const content = pattern.slice(index + 1, closing);
	if (current === "[") {
		return {
			source: `[${content.startsWith("!") ? `^${content.slice(1)}` : content}]`,
			end: closing,
		};
	}
	return { source: `(?:${content.split(",").map(oldSource).join("|")})`, end: closing };
}

function oldToken(pattern: string, index: number): { source: string; end: number } {
	const current = pattern[index] ?? "";
	if (current === "[" || current === "{") return oldDelimitedToken(pattern, index);
	if (current === "?") return { source: "[^/]", end: index };
	if (current !== "*") {
		return { source: current.replace(/[\\^$+.()|]/gu, "\\$&"), end: index };
	}
	if (pattern[index + 1] !== "*") return { source: "[^/]*", end: index };
	const slash = pattern[index + 2] === "/";
	return { source: slash ? "(?:.*/)?" : ".*", end: index + (slash ? 2 : 1) };
}

function oldSource(pattern: string): string {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const token = oldToken(pattern, index);
		source += token.source;
		index = token.end;
	}
	return source;
}

describe("matchesBiomeGlob", () => {
	it("matches the old parser for short combinations of tokens", () => {
		// CR02: mix wildcard and empty alternatives with surrounding tokens.
		const tokens = [
			"",
			"a",
			"/",
			"*",
			"?",
			"**",
			"**/",
			"[ab]",
			"[!a]",
			"{a,b}",
			"{,a}",
			"{*a,b}",
			"{**,b}",
			"{?,*}",
			"{,*/}",
		];
		const paths = [
			"",
			"a",
			"b",
			"/",
			"aa",
			"ab",
			"xa",
			"xb",
			"x/yb",
			"x/ya",
			"x/",
			"a/b",
			"a/a/b",
			"\n",
			"a\n",
			"😀",
			"a/😀",
		];
		for (const first of tokens) {
			for (const second of tokens) {
				// Arrange
				const pattern = `${first}${second}`;
				const expression = new RegExp(`^${oldSource(pattern)}$`, "u");
				for (const path of paths) {
					// Act
					const actual = matchesBiomeGlob(pattern, path);
					// Assert
					expect(actual, `${pattern}: ${JSON.stringify(path)}`).toBe(expression.test(path));
				}
			}
		}
	});

	// CR01: consuming a wildcard must not re-enter a sibling brace alternative.
	it.each([
		{ pattern: "{*a,b}", matches: ["a", "xa", "b"], nonmatches: ["xb", "ab"] },
		{ pattern: "a{*b,c}", matches: ["ab", "axb", "ac"], nonmatches: ["axc"] },
		{ pattern: "{**a,b}", matches: ["a", "x/ya", "b"], nonmatches: ["x/yb"] },
		{ pattern: "{,*😀a}", matches: ["", "😀a", "x😀a"], nonmatches: ["b!!"] },
	])("isolates wildcard branches in $pattern", ({ pattern, matches, nonmatches }) => {
		// Arrange
		const paths = [...matches, ...nonmatches];
		// Act
		const actual = paths.map((path) => matchesBiomeGlob(pattern, path));
		// Assert
		expect(actual).toEqual([...matches.map(() => true), ...nonmatches.map(() => false)]);
	});
});

describe("Biome glob escaped-closing compatibility", () => {
	// CR03: the old regex parser accepts classes containing an escaped closing bracket.
	it.each([
		{ pattern: "[a\\]b]", matches: ["a", "]", "b"], nonmatches: ["x", "ab", ""] },
		{ pattern: "[\\]]", matches: ["]"], nonmatches: ["a", "]]", ""] },
	])("preserves escaped closing brackets in $pattern", ({ pattern, matches, nonmatches }) => {
		// Arrange
		const paths = [...matches, ...nonmatches];
		const expression = new RegExp(`^${oldSource(pattern)}$`, "u");
		// Act
		const actual = paths.map((path) => matchesBiomeGlob(pattern, path));
		const legacy = paths.map((path) => expression.test(path));
		// Assert
		expect(legacy).toEqual([...matches.map(() => true), ...nonmatches.map(() => false)]);
		expect(actual).toEqual(legacy);
	});

	// CR03: preserve simple escaped closings without accepting ambiguous suffix syntax.
	it("rejects an escaped-closing wildcard suffix that the old parser rejects", () => {
		// Arrange
		const pattern = "[\\]a*]";
		// Act
		const compileLegacy = () => new RegExp(`^${oldSource(pattern)}$`, "u");
		const match = () => matchesBiomeGlob(pattern, "a");
		// Assert
		expect(compileLegacy).toThrow(SyntaxError);
		expect(match).toThrow(SyntaxError);
	});

	it.each(["[\\]{a,b}]", "[\\]a?]", "[\\]a{]", "[\\]a}]", "[\\]a[]", "[\\]a\\d]"])(
		"fails closed for unsupported escaped-closing suffix syntax: %s",
		(pattern) => {
			// Arrange
			const path = "a";
			// Act
			const match = () => matchesBiomeGlob(pattern, path);
			// Assert
			expect(match).toThrow(SyntaxError);
		},
	);
});

describe("Biome glob syntax and adversarial inputs", () => {
	it("preserves classes, brace wildcards, Unicode literals and escaped regex punctuation", () => {
		const patterns = [
			"src/**/{a*,b?}.[jt]s",
			"[a-z]",
			"[^a]",
			"[]",
			"[!]",
			"[",
			"{",
			"😀?",
			"(a)+.ts",
			"[\\d]",
		];
		const paths = ["src/a.js", "src/nested/b😀.ts", "z", "😀a", "(a)+.ts", "[", "{", "9", "\n"];
		for (const pattern of patterns) {
			const expression = new RegExp(`^${oldSource(pattern)}$`, "u");
			for (const path of paths) {
				expect(matchesBiomeGlob(pattern, path)).toBe(expression.test(path));
			}
		}
	});

	it("still rejects invalid class ranges and unmatched closing delimiters", () => {
		for (const pattern of ["[z-a]", "]", "}", "{a,{b,c}}", "[\\]"]) {
			expect(() => matchesBiomeGlob(pattern, "a")).toThrow(SyntaxError);
		}
	});

	it("treats repeated unmatched opening delimiters as literals", () => {
		for (const delimiter of ["[", "{"]) {
			const pattern = delimiter.repeat(2000);
			expect(matchesBiomeGlob(pattern, pattern)).toBe(true);
			expect(matchesBiomeGlob(pattern, "")).toBe(false);
		}
	});

	it("rejects repeated wildcard and alternative nonmatches without exploring partitions", () => {
		const started = performance.now();
		for (const pattern of ["*a".repeat(10), "**a".repeat(10), "{a,aa}*".repeat(10)]) {
			expect(matchesBiomeGlob(`${pattern}b`, "a".repeat(40))).toBe(false);
		}
		expect(matchesBiomeGlob(`${"{a,aa}*".repeat(100)}b`, "a".repeat(400))).toBe(false);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("finishes adversarial wildcard and brace inputs before an independent process deadline", () => {
		const helper = new URL("./biome-glob.ts", import.meta.url).href;
		const script = `import { matchesBiomeGlob } from ${JSON.stringify(helper)};
			for (const token of ['*a', '**a', '{a,aa}*']) {
				if (matchesBiomeGlob(token.repeat(10) + 'b', 'a'.repeat(40))) process.exit(1);
			}`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			timeout: 1500,
			encoding: "utf8",
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	});
});
