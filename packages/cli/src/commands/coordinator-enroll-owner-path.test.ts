import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
	enrollmentModes,
	expandUserPath,
	mocks,
	parseSelected,
} from "./coordinator-enroll-owner.test-fixture.js";

it.each(
	[
		{ environment: "  fixture-keys\t", explicit: undefined, expected: "fixture-keys" },
		{ environment: "  fixture-keys\t", explicit: "fixture-keys", expected: "fixture-keys" },
		{ environment: "", explicit: undefined, expected: "fixture-keys" },
		{ environment: " \t ", explicit: undefined, expected: "fixture-keys" },
		{ environment: " \t ", explicit: "keys with spaces ", expected: "keys with spaces " },
		{ environment: "~/keys", explicit: "~/keys", expected: "~/keys" },
	].flatMap((path) => enrollmentModes.map((mode) => ({ ...path, ...mode }))),
)(
	"uses runtime-normalized keys environment and literal explicit paths during $mode (case %#)",
	async ({ environment, explicit, expected, args }) => {
		// Arrange: keys env matches runtime trim semantics; explicit filenames remain literal.
		vi.stubEnv("CODEMEM_KEYS_DIR", environment);
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const selected = [...args];
		if (explicit !== undefined) selected.push("--keys-dir", explicit);
		// Act: select keys without accessing the actual user key directory.
		await parseSelected("group", selected);
		// Assert: empty env uses defaults and tilde is not expanded for keys.
		expect(process.exitCode).toBeUndefined();
		expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ keysDir: expected }),
		);
	},
);
const normalizedPathCases = [
	{ variable: "CODEMEM_DB", value: "~/memory.sqlite", explicit: undefined },
	{ variable: "CODEMEM_DB", value: "", explicit: undefined },
	{ variable: "CODEMEM_DB", value: "", explicit: "selected.sqlite" },
	{ variable: "CODEMEM_DB", value: " spaced.sqlite ", explicit: " spaced.sqlite " },
	{ variable: "CODEMEM_CONFIG", value: "~/config.json", explicit: undefined },
	{ variable: "CODEMEM_CONFIG", value: "  ~/config.json  ", explicit: "~/config.json" },
	{ variable: "CODEMEM_CONFIG", value: "  fixture-config.json  ", explicit: "fixture-config.json" },
	{ variable: "CODEMEM_CONFIG", value: "", explicit: undefined },
	{ variable: "CODEMEM_CONFIG", value: "  ", explicit: "fixture-config.json" },
];
it.each(enrollmentModes)(
	"does not trim an explicit keys filename to bypass an env conflict during $mode",
	async ({ args }) => {
		// Arrange: runtime env trimming selects one directory; explicit trailing space names another.
		vi.stubEnv("CODEMEM_KEYS_DIR", " \tfixture-keys\t ");
		const json = vi.spyOn(console, "log").mockImplementation(() => {});
		// Act: explicit path whitespace must remain meaningful during override comparison.
		await parseSelected("group", [...args, "--keys-dir", "fixture-keys "]);
		// Assert: conflict remains a usage error before state or profile access.
		expect(process.exitCode).toBe(2);
		expect(JSON.stringify([json.mock.calls, mocks.log.error.mock.calls])).toContain(
			"CODEMEM_KEYS_DIR",
		);
		expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
	},
);

it.each(
	normalizedPathCases.flatMap((path) => enrollmentModes.map((mode) => ({ ...path, ...mode }))),
)(
	"accepts resolver-compatible $variable override during $mode (case %#)",
	async ({ variable, value, explicit, args }) => {
		// Arrange: simulate a home directory without reading real profiles or keys.
		vi.stubEnv("HOME", resolve("fixture-home"));
		vi.stubEnv(variable, value);
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		mocks.resolveCodememConfigPath.mockImplementation((selected?: string) => ({
			resolved: {
				path: expandUserPath(
					selected?.trim() || process.env.CODEMEM_CONFIG?.trim() || "fixture-config.json",
				),
			},
		}));
		mocks.resolveDbPath.mockImplementation((selected?: string) =>
			expandUserPath(selected || process.env.CODEMEM_DB || "fixture.sqlite"),
		);
		const selected = [...args];
		if (explicit !== undefined)
			selected.push(variable === "CODEMEM_DB" ? "--db-path" : "--config", explicit);
		const expectedDb =
			variable === "CODEMEM_DB"
				? expandUserPath(explicit || value || "fixture.sqlite")
				: "fixture.sqlite";
		const expectedConfig =
			variable === "CODEMEM_CONFIG"
				? expandUserPath(explicit?.trim() || value.trim() || "fixture-config.json")
				: "fixture-config.json";

		// Act: the raw check and effective-path check must agree with the real resolvers.
		await parseSelected("group", selected);

		// Assert: enrollment receives expanded paths, including legitimate DB whitespace.
		expect(process.exitCode).toBeUndefined();
		expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ dbPath: expectedDb, configPath: expectedConfig }),
		);
		expect(mocks.log.error).not.toHaveBeenCalled();
	},
);

it.each(
	(["CODEMEM_DB", "CODEMEM_CONFIG", "CODEMEM_KEYS_DIR"] as const).flatMap((variable) =>
		enrollmentModes.map((mode) => ({ variable, ...mode })),
	),
)(
	"rejects genuinely different normalized $variable targets during $mode",
	async ({ variable, args }) => {
		// Arrange: tilde expansion cannot make two different private targets equivalent.
		vi.stubEnv("HOME", resolve("fixture-home"));
		vi.stubEnv(
			variable,
			variable === "CODEMEM_CONFIG" ? "  ~/private-environment  " : "~/private-environment",
		);
		const json = vi.spyOn(console, "log").mockImplementation(() => {});
		const flag = {
			CODEMEM_DB: "--db-path",
			CODEMEM_CONFIG: "--config",
			CODEMEM_KEYS_DIR: "--keys-dir",
		}[variable];

		// Act: compare selected and environment targets before profile resolution.
		await parseSelected("group", [...args, flag, "~/private-selected"]);

		// Assert: normalization preserves conflicts without echoing either target.
		expect(process.exitCode).toBe(2);
		expect(
			JSON.stringify([json.mock.calls, ...Object.values(mocks.log).map((log) => log.mock.calls)]),
		).not.toContain("private-");
		expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
	},
);
const profilePaths = [
	{ variable: "CODEMEM_CONFIG", flag: "--config", path: "fixture-config.json" },
	{ variable: "CODEMEM_DB", flag: "--db-path", path: "fixture.sqlite" },
	{ variable: "CODEMEM_DB", flag: "--db", path: "fixture.sqlite" },
	{ variable: "CODEMEM_KEYS_DIR", flag: "--keys-dir", path: "fixture-keys" },
];

it.each(profilePaths.flatMap((path) => enrollmentModes.map((mode) => ({ ...path, ...mode }))))(
	"rejects raw $flag conflict before $mode profile resolution",
	async ({ variable, flag, args, mode }) => {
		// Arrange: explicit and environment paths disagree; do not consult the profile.
		vi.stubEnv(variable, "private-environment-path");
		const json = vi.spyOn(console, "log").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		// Act: both database aliases use the shared raw option check.
		await parseSelected("group", [...args, flag, "private-selected-path"]);

		// Assert: only the variable and canonical flag appear in actionable usage guidance.
		expect(process.exitCode).toBe(2);
		const output = JSON.stringify([
			json.mock.calls,
			...Object.values(mocks.log).map((log) => log.mock.calls),
		]);
		expect(output).toContain(variable);
		expect(output).toContain(flag === "--db" ? "--db-path" : flag);
		expect(output).toMatch(/Unset.*match/);
		expect(output).not.toMatch(/private-|retry|retained|review_required/);
		if (mode === "prepare JSON") {
			expect(JSON.parse(String(json.mock.calls[0]?.[0])).error).toBe("usage_error");
			expect(mocks.log.error).not.toHaveBeenCalled();
		} else {
			expect(json).not.toHaveBeenCalled();
			expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
				output: process.stderr,
			});
		}
		expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
		expect(mocks.readCodememConfigFileAtPath).not.toHaveBeenCalled();
		expect(mocks.readCoordinatorSyncConfig).not.toHaveBeenCalled();
		expect(mocks.resolveDbPath).not.toHaveBeenCalled();
		expect(mocks.resolveKeyPaths).not.toHaveBeenCalled();
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(stdout).not.toHaveBeenCalled();
		expect(mocks.log.warn).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
	},
);

it.each(profilePaths.flatMap((path) => enrollmentModes.map((mode) => ({ ...path, ...mode }))))(
	"accepts normalized equivalent $flag environment path during $mode",
	async ({ variable, flag, path, args }) => {
		// Arrange: an absolute environment path matches a relative explicit selection.
		vi.stubEnv(variable, resolve(path));
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		mocks.resolveCodememConfigPath.mockReturnValueOnce({
			resolved: { path: "./fixture-config.json" },
		});

		// Act: normalization, rather than raw string equality, defines agreement.
		await parseSelected("group", [...args, flag, `./${path}`]);

		// Assert: the resolved profile remains available to core enrollment.
		expect(process.exitCode).toBeUndefined();
		expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				configPath: "./fixture-config.json",
				dbPath: variable === "CODEMEM_DB" ? "./fixture.sqlite" : "fixture.sqlite",
				keysDir: variable === "CODEMEM_KEYS_DIR" ? "./fixture-keys" : "fixture-keys",
			}),
		);
		expect(mocks.resolveCodememConfigPath).toHaveBeenCalledOnce();
		expect(mocks.log.error).not.toHaveBeenCalled();
	},
);

it.each(
	["CODEMEM_CONFIG", "CODEMEM_DB"].flatMap((variable) =>
		[false, true].flatMap((explicit) =>
			enrollmentModes.map((mode) => ({ variable, explicit, ...mode })),
		),
	),
)(
	"rechecks resolved $variable path during $mode (explicit: $explicit)",
	async ({ variable, explicit, args }) => {
		// Arrange: no explicit flag conflicts, but the resolver selects another profile.
		vi.stubEnv(variable, "private-environment-path");
		mocks.resolveCodememConfigPath.mockReturnValueOnce({
			resolved: { path: "private-resolved-config" },
		});
		mocks.resolveDbPath.mockReturnValueOnce("private-resolved-db");
		const json = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act: validate the effective paths after config and database resolution.
		const selected = [...args];
		if (explicit)
			selected.push(
				variable === "CODEMEM_CONFIG" ? "--config" : "--db-path",
				"private-environment-path",
			);
		await parseSelected("group", selected);

		// Assert: late disagreements still cannot reach adoption or reveal paths.
		expect(process.exitCode).toBe(2);
		expect(mocks.resolveCodememConfigPath).toHaveBeenCalledOnce();
		expect(mocks.resolveDbPath).toHaveBeenCalledOnce();
		const output = JSON.stringify([
			json.mock.calls,
			...Object.values(mocks.log).map((log) => log.mock.calls),
		]);
		expect(output).toContain(variable);
		expect(output).toMatch(/Unset.*match/);
		expect(output).not.toMatch(/private-|retry|retained|review_required/);
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
	},
);
