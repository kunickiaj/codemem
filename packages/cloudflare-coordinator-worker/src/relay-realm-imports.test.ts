import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_SRC = resolve(import.meta.dirname, "../../core/src");
const PACKAGE_ALIASES: Record<string, string> = {
	"@codemem/core/internal/relay-host": resolve(CORE_SRC, "internal/relay-host.ts"),
};
const RUNTIME_SPECIFIERS = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s*["']([^"']+)["']/gmu;
const SIDE_EFFECT_SPECIFIERS = /^\s*import\s*["']([^"']+)["']/gmu;

/** Runtime module graph of one entry. Type-only imports are erased, so they are skipped. */
function runtimeGraph(entry: string): { files: Set<string>; external: Set<string> } {
	const files = new Set<string>();
	const external = new Set<string>();
	const pending = [entry];
	for (let file = pending.pop(); file; file = pending.pop()) {
		if (files.has(file)) continue;
		files.add(file);
		const source = readFileSync(file, "utf8");
		const specifiers = [
			...source.matchAll(RUNTIME_SPECIFIERS),
			...source.matchAll(SIDE_EFFECT_SPECIFIERS),
		].map((match) => match[1] ?? "");
		for (const specifier of specifiers) {
			const aliased = PACKAGE_ALIASES[specifier];
			if (aliased) pending.push(aliased);
			else if (specifier.startsWith("."))
				pending.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
			else external.add(specifier);
		}
	}
	return { files, external };
}

/** Runtime names imported from one module, excluding `type` specifiers. */
function runtimeNames(files: Iterable<string>, module: string): string[] {
	const statement = new RegExp(
		`^\\s*import\\s+(?!type\\s)\\{([^}]*)\\}\\s*from\\s*["']${module}["']`,
		"gmu",
	);
	const names: string[] = [];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		if (new RegExp(`import\\s+(?!type\\s)[^{;]*\\bfrom\\s*["']${module}["']`).test(source))
			names.push("<default or namespace>");
		for (const match of source.matchAll(statement))
			for (const name of (match[1] ?? "").split(","))
				if (name.trim() && !name.trim().startsWith("type ")) names.push(name.trim());
	}
	return names;
}

function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("relay Durable Object module graph", () => {
	const graph = runtimeGraph(resolve(import.meta.dirname, "relay-realm.ts"));

	it("reaches no D1 or coordinator store code", () => {
		// Arrange
		const names = [...graph.files].map((file) => basename(file));
		// Act
		const coordinatorModules = names.filter(
			(name) =>
				name.startsWith("d1-") ||
				name.startsWith("coordinator-") ||
				name === "cloudflare-coordinator.ts" ||
				name === "index.ts",
		);
		// Assert
		expect(names).toEqual(expect.arrayContaining(["relay-server.ts", "relay-quota-sqlite.ts"]));
		expect(coordinatorModules).toEqual([]);
	});

	it("never reads the coordinator D1 binding and imports only Worker-safe externals", () => {
		// Arrange
		const sources = [...graph.files].map((file) => withoutComments(readFileSync(file, "utf8")));
		// Act
		const readsD1 = sources.filter((source) => /\bCOORDINATOR_DB\b|\bD1Database\b/.test(source));
		// Assert
		expect(readsD1).toEqual([]);
		expect([...graph.external].toSorted()).toEqual(["cloudflare:workers", "node:crypto"]);
	});

	it("imports only DurableObject at runtime from cloudflare:workers, so env cannot leak in", () => {
		// Act
		const names = runtimeNames(graph.files, "cloudflare:workers");
		// Assert
		expect(names).toEqual(["DurableObject"]);
	});
});
