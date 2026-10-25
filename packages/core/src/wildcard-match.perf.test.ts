import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { matchesWildcard } from "./wildcard-match.js";

function oldMatch(identity: string, pattern: string, unicode: boolean): boolean {
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.*]/gu, "\\$&");
	return new RegExp(
		`^${escaped.replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`,
		unicode ? "u" : "",
	).test(identity);
}

describe("matchesWildcard", () => {
	it("preserves both legacy regex dialects on small inputs", () => {
		const atoms = ["", "a", "*", "?", "/", ":", "😀", "\n", "\r", "\u2028", "[", "."];
		const patterns = atoms.flatMap((left) => atoms.map((right) => `${left}${right}`));
		const identities = [...patterns, "a/a", "a:a", "😀a", "a\n", "\ud83d", "\ude00"];
		for (const unicode of [false, true]) {
			for (const pattern of patterns) {
				for (const identity of identities) {
					expect(matchesWildcard(identity, pattern, { unicode })).toBe(
						oldMatch(identity, pattern, unicode),
					);
				}
			}
		}
	});

	it("rejects alternating-star adversarial nonmatches quickly", () => {
		const started = performance.now();
		for (const unicode of [false, true]) {
			expect(matchesWildcard(`/${"a".repeat(40)}`, `/${"*a".repeat(10)}b`, { unicode })).toBe(
				false,
			);
			expect(matchesWildcard(`/${"a".repeat(400)}`, `/${"*a".repeat(100)}b`, { unicode })).toBe(
				false,
			);
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("finishes the reported adversarial input before an independent process deadline", () => {
		const helper = new URL("./wildcard-match.ts", import.meta.url).href;
		const script = `import { matchesWildcard } from ${JSON.stringify(helper)};
			for (const unicode of [false, true]) {
				if (matchesWildcard('/' + 'a'.repeat(40), '/' + '*a'.repeat(10) + 'b', { unicode })) {
					process.exit(1);
				}
			}`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			timeout: 1500,
			encoding: "utf8",
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	});

	it("keeps code-unit scope matching distinct from code-point recipient matching", () => {
		expect(matchesWildcard("/😀", "/?", { unicode: false })).toBe(false);
		expect(matchesWildcard("/😀", "/??", { unicode: false })).toBe(true);
		expect(matchesWildcard("/😀", "/?", { unicode: true })).toBe(true);
		expect(matchesWildcard("/😀", "/??", { unicode: true })).toBe(false);
	});
});
