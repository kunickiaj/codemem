import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compareChangedDiagnostics, parsePinnedBiomeReport } from "./biome-ratchet.js";
import { resolveRootBiomeEntrypoint } from "./biome-ratchet-cli.js";
import { getScopeIdentity } from "./lint-diagnostics.js";

function route(method: string, path: string, count: number, binding: string) {
	const branches = Array.from({ length: count }, (_, i) => `if (value === ${i}) act(${i});`).join(
		"\n",
	);
	return `app.${method}("${path}", (c) => {
const store = getStore();
return (async () => {
${branches}
const ${binding} = "text with } and app.get('/fake', () => {";
return ${binding};
})();
});`;
}

function compare(before: string, after: string) {
	const directory = mkdtempSync(join(tmpdir(), "ratchet-route-"));
	const entrypoint = resolveRootBiomeEntrypoint(process.cwd());
	try {
		writeFileSync(
			join(directory, "biome.json"),
			JSON.stringify({
				linter: {
					rules: {
						recommended: false,
						complexity: {
							noExcessiveCognitiveComplexity: {
								level: "warn",
								options: { maxAllowedComplexity: 15 },
							},
							noExcessiveLinesPerFunction: { level: "warn", options: { maxLines: 15 } },
						},
					},
				},
			}),
		);
		const reports = [before, after].map((source) => {
			writeFileSync(join(directory, "routes.ts"), source);
			const report = execFileSync(
				process.execPath,
				[entrypoint, "lint", "--reporter=json", "--max-diagnostics=none", "routes.ts"],
				{ cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
			return parsePinnedBiomeReport(report, () => source);
		});
		return compareChangedDiagnostics(reports[0] ?? [], reports[1] ?? [], [
			{ status: "modified", beforePath: "routes.ts", afterPath: "routes.ts" },
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const status = route("get", "/v1/status", 20, "statusResult");
const snapshot = route("get", "/v1/snapshot", 25, "message");
const ops = route("post", "/v1/ops", 22, "opsResult");

it("pairs snapshot improvements without confusing same-shaped IIFEs or unchanged ops", () => {
	expect(
		compare(status + snapshot + ops, status + route("get", "/v1/snapshot", 18, "page") + ops),
	).toEqual([]);
});

it("keeps worsened ops visible when snapshot improves and its last binding changes", () => {
	const regressions = compare(
		status + snapshot + ops,
		status + route("get", "/v1/snapshot", 18, "page") + route("post", "/v1/ops", 30, "opsResult"),
	);
	expect(regressions.length).toBeGreaterThan(0);
	expect(regressions.every((d) => d.scopeIdentity?.includes("/v1/ops"))).toBe(true);
});

it("reports a new route even when a larger old route disappears", () => {
	const regressions = compare(
		status + snapshot + ops,
		status + route("get", "/v1/new", 18, "page") + ops,
	);
	expect(regressions.length).toBeGreaterThan(0);
	expect(regressions.every((d) => d.scopeIdentity?.includes("/v1/new"))).toBe(true);
});

it("still fails closed for changed duplicate registrations of the same route", () => {
	expect(() =>
		compare(snapshot + snapshot, snapshot + route("get", "/v1/snapshot", 26, "message")),
	).toThrow("Ambiguous");
});

it("ends route ownership at its closing brace and ignores route-like strings and comments", () => {
	const source = `${snapshot}\n// app.post('/fake', () => {\nfunction outside() {\nreturn 1;\n}`;
	expect(getScopeIdentity(source, source.split("\n").length - 2)).toBe(":function:outside");
});
