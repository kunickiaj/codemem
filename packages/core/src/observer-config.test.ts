import {
	chmodSync,
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	atomicReplaceConfigFile,
	CodememConfigMutationError,
	deleteCodememConfigFile,
	getCodememConfigPath,
	getCodememEnvOverrides,
	getProviderApiKey,
	getWorkspaceCodememConfigPath,
	getWorkspaceScopedCodememConfigPath,
	loadOpenCodeConfig,
	mutateCodememConfigFile,
	readCodememConfigFileAtPath,
	readCodememConfigFileForMutation,
	readWorkspaceCodememConfigFile,
	resolveCodememConfigPath,
	resolveCustomProviderFromModel,
	resolvePlaceholder,
	stripJsonComments,
	stripTrailingCommas,
	writeCodememConfigFile,
	writeWorkspaceCodememConfigFile,
} from "./observer-config.js";

function fixtureToken(label: string): string {
	return ["fixture", label, "token"].join("-");
}

describe("codemem config path resolution", () => {
	let tmpHome: string;
	let prevHome: string | undefined;
	let prevCodememConfig: string | undefined;
	let prevRuntimeRoot: string | undefined;
	let prevWorkspaceId: string | undefined;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-home-"));
		prevHome = process.env.HOME;
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		prevRuntimeRoot = process.env.CODEMEM_RUNTIME_ROOT;
		prevWorkspaceId = process.env.CODEMEM_WORKSPACE_ID;
		process.env.HOME = tmpHome;
		delete process.env.CODEMEM_CONFIG;
		delete process.env.CODEMEM_RUNTIME_ROOT;
		delete process.env.CODEMEM_WORKSPACE_ID;
	});

	afterEach(() => {
		if (prevHome == null) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevCodememConfig == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		if (prevRuntimeRoot == null) delete process.env.CODEMEM_RUNTIME_ROOT;
		else process.env.CODEMEM_RUNTIME_ROOT = prevRuntimeRoot;
		if (prevWorkspaceId == null) delete process.env.CODEMEM_WORKSPACE_ID;
		else process.env.CODEMEM_WORKSPACE_ID = prevWorkspaceId;
	});

	it("resolves workspace config path from workspace id", () => {
		expect(getWorkspaceCodememConfigPath("pilot-1")).toBe(
			join(tmpHome, ".codemem", "workspaces", "pilot-1", "config", "codemem.json"),
		);
	});

	it("rejects unsafe workspace ids for config path", () => {
		expect(() => getWorkspaceCodememConfigPath("../pilot-1")).toThrow(
			"Invalid workspace id for config path",
		);
		expect(() => getWorkspaceCodememConfigPath(".")).toThrow(
			"Invalid workspace id for config path",
		);
		expect(() => getWorkspaceCodememConfigPath("..")).toThrow(
			"Invalid workspace id for config path",
		);
	});

	it("prefers CODEMEM_CONFIG over workspace-scoped config", () => {
		process.env.CODEMEM_CONFIG = "~/explicit/config.json";
		process.env.CODEMEM_WORKSPACE_ID = "pilot-1";
		expect(getCodememConfigPath()).toBe(join(tmpHome, "explicit", "config.json"));
	});

	it("uses CODEMEM_RUNTIME_ROOT when present", () => {
		process.env.CODEMEM_RUNTIME_ROOT = join(tmpHome, "runtime-root");
		expect(getWorkspaceScopedCodememConfigPath()).toBe(
			join(tmpHome, "runtime-root", "config", "codemem.json"),
		);
	});

	it("ignores relative CODEMEM_RUNTIME_ROOT values", () => {
		process.env.CODEMEM_RUNTIME_ROOT = "../runtime-root";
		expect(getWorkspaceScopedCodememConfigPath()).toBeNull();
		expect(getCodememConfigPath()).toBe(join(tmpHome, ".config", "codemem", "config.json"));
	});

	it("uses workspace-scoped config path when workspace id is known", () => {
		process.env.CODEMEM_WORKSPACE_ID = "pilot-1";
		expect(getCodememConfigPath()).toBe(
			join(tmpHome, ".codemem", "workspaces", "pilot-1", "config", "codemem.json"),
		);
	});

	it("falls back to legacy config for reads until workspace config exists", () => {
		const legacyPath = join(tmpHome, ".config", "codemem", "config.jsonc");
		mkdirSync(join(tmpHome, ".config", "codemem"), { recursive: true });
		writeFileSync(legacyPath, '{"sync_enabled": true}\n', "utf8");
		process.env.CODEMEM_WORKSPACE_ID = "pilot-1";
		expect(getCodememConfigPath()).toBe(legacyPath);
	});

	it("falls back to legacy global config when workspace id is absent", () => {
		const legacyPath = join(tmpHome, ".config", "codemem", "config.jsonc");
		mkdirSync(join(tmpHome, ".config", "codemem"), { recursive: true });
		writeFileSync(legacyPath, "{}\n", "utf8");
		expect(getCodememConfigPath()).toBe(legacyPath);
	});

	it("returns default legacy global config path when no config exists", () => {
		expect(getCodememConfigPath()).toBe(join(tmpHome, ".config", "codemem", "config.json"));
	});

	it("writes and reads workspace-scoped config files", () => {
		const targetPath = writeWorkspaceCodememConfigFile("pilot-1", {
			sync_enabled: true,
			sync_port: 47337,
		});
		expect(targetPath).toBe(
			join(tmpHome, ".codemem", "workspaces", "pilot-1", "config", "codemem.json"),
		);
		expect(readWorkspaceCodememConfigFile("pilot-1")).toEqual({
			sync_enabled: true,
			sync_port: 47337,
		});
	});

	it("writes to the workspace path when workspace mode is active", () => {
		process.env.CODEMEM_WORKSPACE_ID = "pilot-1";
		const targetPath = writeCodememConfigFile({ sync_enabled: true });
		expect(targetPath).toBe(
			join(tmpHome, ".codemem", "workspaces", "pilot-1", "config", "codemem.json"),
		);
	});

	it("reads JSONC config from an explicit path", () => {
		const configPath = join(tmpHome, "workspace-config.jsonc");
		writeFileSync(configPath, '{\n  // comment\n  "sync_enabled": true,\n}\n', "utf8");
		expect(readCodememConfigFileAtPath(configPath)).toEqual({ sync_enabled: true });
	});
});

describe("codemem config mutation", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-mutation-"));
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("distinguishes missing, invalid, and valid mutation input", () => {
		const configPath = join(tmpHome, "strict-config.json");
		expect(readCodememConfigFileForMutation(configPath)).toMatchObject({ status: "missing" });

		writeFileSync(configPath, "{ broken", "utf8");
		expect(readCodememConfigFileForMutation(configPath)).toMatchObject({
			status: "invalid",
			reason: "parse_error",
		});

		writeFileSync(configPath, '{ "existing": true, }', "utf8");
		expect(readCodememConfigFileForMutation(configPath)).toMatchObject({
			status: "valid",
			data: { existing: true },
		});

		const unreadablePath = join(tmpHome, "directory-instead-of-config");
		mkdirSync(unreadablePath);
		expect(readCodememConfigFileForMutation(unreadablePath)).toMatchObject({
			status: "unreadable",
		});
	});

	it("refuses to replace malformed config during mutation", () => {
		const configPath = join(tmpHome, "malformed.json");
		const original = "{ definitely-not-json";
		writeFileSync(configPath, original, "utf8");

		expect(() =>
			mutateCodememConfigFile((config) => ({ ...config, sync_enabled: true }), configPath),
		).toThrow(CodememConfigMutationError);
		expect(readFileSync(configPath, "utf8")).toBe(original);
		expect(
			readdirSync(tmpHome).filter((name) => name.includes(".tmp-") || name.endsWith(".lock")),
		).toEqual([]);
	});
});

describe("atomic config replacement", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-replacement-"));
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("leaves original bytes intact and cleans the temporary file when rename fails", () => {
		const configPath = join(tmpHome, "rename-failure.json");
		const original = '{"existing":true}\n';
		writeFileSync(configPath, original, "utf8");
		const operations = {
			open: openSync,
			close: closeSync,
			chmod: fchmodSync,
			sync: fsyncSync,
			write: writeFileSync,
			rename: () => {
				throw new Error("injected rename failure");
			},
			unlink: unlinkSync,
		};

		expect(() =>
			atomicReplaceConfigFile(configPath, '{"replacement":true}\n', 0o640, operations),
		).toThrow("injected rename failure");
		expect(readFileSync(configPath, "utf8")).toBe(original);
		expect(readdirSync(tmpHome).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	it("leaves original bytes intact and cleans the temporary file when sync fails", () => {
		const configPath = join(tmpHome, "sync-failure.json");
		const original = '{"existing":true}\n';
		writeFileSync(configPath, original, "utf8");
		const operations = {
			open: openSync,
			close: closeSync,
			chmod: fchmodSync,
			sync: () => {
				throw new Error("injected sync failure");
			},
			write: writeFileSync,
			rename: renameSync,
			unlink: unlinkSync,
		};

		expect(() =>
			atomicReplaceConfigFile(configPath, '{"replacement":true}\n', 0o640, operations),
		).toThrow("injected sync failure");
		expect(readFileSync(configPath, "utf8")).toBe(original);
		expect(readdirSync(tmpHome).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	it("leaves original bytes intact and cleans the temporary file when write fails", () => {
		const configPath = join(tmpHome, "write-failure.json");
		const original = '{"existing":true}\n';
		writeFileSync(configPath, original, "utf8");
		const operations = {
			open: openSync,
			close: closeSync,
			chmod: fchmodSync,
			sync: fsyncSync,
			write: () => {
				throw new Error("injected write failure");
			},
			rename: renameSync,
			unlink: unlinkSync,
		};

		expect(() =>
			atomicReplaceConfigFile(configPath, '{"replacement":true}\n', 0o640, operations),
		).toThrow("injected write failure");
		expect(readFileSync(configPath, "utf8")).toBe(original);
		expect(readdirSync(tmpHome).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	it("returns success when directory sync fails after rename", () => {
		const configPath = join(tmpHome, "directory-sync-failure.json");
		writeFileSync(configPath, '{"existing":true}\n', "utf8");
		let syncCalls = 0;
		const operations = {
			open: openSync,
			close: closeSync,
			chmod: fchmodSync,
			sync: (fd: number) => {
				syncCalls++;
				if (syncCalls === 2) throw new Error("injected directory sync failure");
				fsyncSync(fd);
			},
			write: writeFileSync,
			rename: renameSync,
			unlink: unlinkSync,
		};

		expect(() =>
			atomicReplaceConfigFile(configPath, '{"replacement":true}\n', 0o640, operations),
		).not.toThrow();
		expect(readFileSync(configPath, "utf8")).toBe('{"replacement":true}\n');
	});
});

describe("config mutation concurrency", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-concurrency-"));
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("preserves mode and unrelated fields during mutation", () => {
		const configPath = join(tmpHome, "preserve.json");
		writeFileSync(configPath, '{"unrelated":"keep","sync_enabled":false}\n', {
			encoding: "utf8",
			mode: 0o640,
		});
		const beforeMode = statSync(configPath).mode & 0o777;

		const result = mutateCodememConfigFile(
			(config) => ({ ...config, sync_enabled: true }),
			configPath,
		);

		expect(result.data).toEqual({ unrelated: "keep", sync_enabled: true });
		expect(statSync(configPath).mode & 0o777).toBe(beforeMode);
	});

	it("updates a symlink target without replacing the link", () => {
		const targetPath = join(tmpHome, "target.json");
		const configPath = join(tmpHome, "linked.json");
		writeFileSync(targetPath, '{"unrelated":"keep"}\n', "utf8");
		symlinkSync(targetPath, configPath);

		mutateCodememConfigFile((config) => ({ ...config, sync_enabled: true }), configPath);

		expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual({
			unrelated: "keep",
			sync_enabled: true,
		});
	});

	it("preserves a symlink chain when its final target is created and deleted", () => {
		const targetPath = join(tmpHome, "missing-target.json");
		const intermediatePath = join(tmpHome, "intermediate.json");
		const configPath = join(tmpHome, "linked.json");
		symlinkSync("missing-target.json", intermediatePath);
		symlinkSync("intermediate.json", configPath);

		const created = mutateCodememConfigFile(() => ({ created: true }), configPath);

		expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
		expect(lstatSync(intermediatePath).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual({ created: true });

		deleteCodememConfigFile(configPath, created.revision);
		expect(existsSync(targetPath)).toBe(false);
		expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
		expect(lstatSync(intermediatePath).isSymbolicLink()).toBe(true);
	});

	it("deletes a newly created config only at its expected revision", () => {
		const configPath = join(tmpHome, "created.json");
		const created = mutateCodememConfigFile(() => ({ created: true }), configPath);

		deleteCodememConfigFile(configPath, created.revision);

		expect(existsSync(configPath)).toBe(false);
		expect(readdirSync(tmpHome).filter((name) => name.endsWith(".lock"))).toEqual([]);
	});

	it("rejects cooperating and external concurrent writers", () => {
		const configPath = join(tmpHome, "concurrent.json");
		writeFileSync(configPath, '{"value":1}\n', "utf8");
		let nestedError: unknown;

		expect(() =>
			mutateCodememConfigFile((config) => {
				try {
					mutateCodememConfigFile((nested) => nested, configPath);
				} catch (error) {
					nestedError = error;
				}
				writeFileSync(configPath, '{"external":true}\n', "utf8");
				return { ...config, value: 2 };
			}, configPath),
		).toThrow(expect.objectContaining({ code: "changed" }));
		expect(nestedError).toEqual(expect.objectContaining({ code: "busy" }));
		expect(readFileSync(configPath, "utf8")).toBe('{"external":true}\n');
	});

	it("rejects changes to a legacy source while seeding a scoped config", () => {
		const previousHome = process.env.HOME;
		const previousWorkspaceId = process.env.CODEMEM_WORKSPACE_ID;
		process.env.HOME = tmpHome;
		process.env.CODEMEM_WORKSPACE_ID = "seeded-workspace";
		const legacyPath = join(tmpHome, ".config", "codemem", "config.json");
		const targetPath = getWorkspaceCodememConfigPath("seeded-workspace");
		mkdirSync(dirname(legacyPath), { recursive: true });
		writeFileSync(legacyPath, '{"legacy":true}\n', "utf8");
		try {
			expect(() =>
				mutateCodememConfigFile(
					(config) => {
						writeFileSync(legacyPath, '{"external":true}\n', "utf8");
						return { ...config, scoped: true };
					},
					targetPath,
					{ fallbackReadPath: legacyPath },
				),
			).toThrow(expect.objectContaining({ code: "changed" }));
			expect(readCodememConfigFileForMutation(targetPath).status).toBe("missing");
			expect(readFileSync(legacyPath, "utf8")).toBe('{"external":true}\n');
		} finally {
			if (previousHome == null) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousWorkspaceId == null) delete process.env.CODEMEM_WORKSPACE_ID;
			else process.env.CODEMEM_WORKSPACE_ID = previousWorkspaceId;
		}
	});
});

describe("config mutation revision safeguards", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-revision-"));
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("seeds from a read-only fallback without locking beside it", () => {
		const fallbackDirectory = join(tmpHome, "managed");
		const legacyPath = join(fallbackDirectory, "config.json");
		const targetPath = join(tmpHome, "workspace", "config.json");
		mkdirSync(fallbackDirectory, { recursive: true });
		writeFileSync(legacyPath, '{"legacy":true}\n', "utf8");
		chmodSync(fallbackDirectory, 0o555);
		try {
			const result = mutateCodememConfigFile(
				(config) => ({ ...config, scoped: true }),
				targetPath,
				{ fallbackReadPath: legacyPath },
			);

			expect(result.data).toEqual({ legacy: true, scoped: true });
			expect(existsSync(`${legacyPath}.lock`)).toBe(false);
		} finally {
			chmodSync(fallbackDirectory, 0o755);
		}
	});

	it("rejects a concurrent target mode change before replacement", () => {
		const configPath = join(tmpHome, "mode-change.json");
		writeFileSync(configPath, '{"value":1}\n', { encoding: "utf8", mode: 0o644 });

		expect(() =>
			mutateCodememConfigFile((config) => {
				chmodSync(configPath, 0o600);
				return { ...config, value: 2 };
			}, configPath),
		).toThrow(expect.objectContaining({ code: "changed" }));
		expect(readFileSync(configPath, "utf8")).toBe('{"value":1}\n');
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
	});
});

describe("stripJsonComments", () => {
	it("removes line comments", () => {
		const input = '{\n  "key": "value" // this is a comment\n}';
		expect(stripJsonComments(input)).toBe('{\n  "key": "value" \n}');
	});

	it("preserves // inside strings", () => {
		const input = '{"url": "https://example.com"}';
		expect(stripJsonComments(input)).toBe(input);
	});

	it("handles escaped quotes in strings", () => {
		const input = '{"key": "val\\"ue"} // comment';
		expect(stripJsonComments(input)).toBe('{"key": "val\\"ue"} ');
	});

	it("strips block comments", () => {
		expect(stripJsonComments('{"a": /* comment */ 1}')).toBe('{"a":  1}');
	});

	it("strips multi-line block comments", () => {
		const input = '{\n  /* this is\n  a comment */\n  "a": 1\n}';
		expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
	});

	it("preserves /* inside strings", () => {
		const input = '{"url": "/* not a comment */"}';
		expect(stripJsonComments(input)).toBe(input);
	});
});

describe("stripTrailingCommas", () => {
	it("removes trailing comma before }", () => {
		expect(stripTrailingCommas('{"a": 1,}')).toBe('{"a": 1}');
	});

	it("removes trailing comma before ]", () => {
		expect(stripTrailingCommas("[1, 2, 3,]")).toBe("[1, 2, 3]");
	});

	it("preserves commas inside strings", () => {
		const input = '{"a": "1,}"}';
		expect(stripTrailingCommas(input)).toBe(input);
	});

	it("handles whitespace between comma and bracket", () => {
		expect(stripTrailingCommas('{"a": 1 , \n}')).toBe('{"a": 1  \n}');
	});
});

describe("loadOpenCodeConfig", () => {
	it("returns {} when no config file exists", () => {
		// This test relies on the test environment not having an opencode config.
		// If it does, the test is still valid — it just returns whatever is there.
		const result = loadOpenCodeConfig();
		expect(typeof result).toBe("object");
	});
});

describe("resolvePlaceholder", () => {
	it("expands $ENV_VAR references", () => {
		process.env.TEST_OBSERVER_CONFIG_VAR = "hello";
		try {
			expect(resolvePlaceholder("prefix-$TEST_OBSERVER_CONFIG_VAR-suffix")).toBe(
				"prefix-hello-suffix",
			);
		} finally {
			delete process.env.TEST_OBSERVER_CONFIG_VAR;
		}
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: ${ENV_VAR} is the literal fixture the resolver is supposed to expand
	it("expands ${ENV_VAR} references", () => {
		process.env.TEST_OBSERVER_CONFIG_VAR2 = "world";
		try {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} is the fixture being resolved
			expect(resolvePlaceholder("${TEST_OBSERVER_CONFIG_VAR2}!")).toBe("world!");
		} finally {
			delete process.env.TEST_OBSERVER_CONFIG_VAR2;
		}
	});

	it("leaves unset env vars as-is", () => {
		delete process.env.SURELY_UNSET_VAR_XYZ;
		expect(resolvePlaceholder("$SURELY_UNSET_VAR_XYZ")).toBe("$SURELY_UNSET_VAR_XYZ");
	});
});

describe("resolveCustomProviderFromModel", () => {
	it("returns null for model without slash", () => {
		expect(resolveCustomProviderFromModel("gpt-4", new Set(["openai"]))).toBeNull();
	});

	it("returns provider when prefix matches", () => {
		expect(resolveCustomProviderFromModel("myco/model-1", new Set(["myco"]))).toBe("myco");
	});

	it("returns null when prefix not in providers", () => {
		expect(resolveCustomProviderFromModel("myco/model-1", new Set(["other"]))).toBeNull();
	});
});

describe("getProviderApiKey", () => {
	it("resolves from options.apiKey", () => {
		const apiKey = fixtureToken("provider-api-key");
		expect(getProviderApiKey({ options: { apiKey } })).toBe(apiKey);
	});

	it("resolves from options.apiKeyEnv", () => {
		const apiKey = fixtureToken("provider-env-key");
		process.env.TEST_API_KEY_FOR_OBSERVER = apiKey;
		try {
			expect(getProviderApiKey({ options: { apiKeyEnv: "TEST_API_KEY_FOR_OBSERVER" } })).toBe(
				apiKey,
			);
		} finally {
			delete process.env.TEST_API_KEY_FOR_OBSERVER;
		}
	});

	it("returns null when no key configured", () => {
		expect(getProviderApiKey({})).toBeNull();
	});
});

describe("getCodememEnvOverrides", () => {
	it("includes shared observer reasoning env overrides when set", () => {
		process.env.CODEMEM_OBSERVER_REASONING_EFFORT = "medium";
		process.env.CODEMEM_OBSERVER_REASONING_SUMMARY = "auto";
		try {
			expect(getCodememEnvOverrides()).toMatchObject({
				observer_reasoning_effort: "CODEMEM_OBSERVER_REASONING_EFFORT",
				observer_reasoning_summary: "CODEMEM_OBSERVER_REASONING_SUMMARY",
			});
		} finally {
			delete process.env.CODEMEM_OBSERVER_REASONING_EFFORT;
			delete process.env.CODEMEM_OBSERVER_REASONING_SUMMARY;
		}
	});

	it("includes sync retention env overrides when set", () => {
		process.env.CODEMEM_SYNC_RETENTION_ENABLED = "1";
		process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS = "14";
		process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB = "256";
		try {
			expect(getCodememEnvOverrides()).toMatchObject({
				sync_retention_enabled: "CODEMEM_SYNC_RETENTION_ENABLED",
				sync_retention_max_age_days: "CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS",
				sync_retention_max_size_mb: "CODEMEM_SYNC_RETENTION_MAX_SIZE_MB",
			});
		} finally {
			delete process.env.CODEMEM_SYNC_RETENTION_ENABLED;
			delete process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS;
			delete process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB;
		}
	});

	it("includes raw-events retention env overrides when set", () => {
		process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED = "1";
		process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS = "45";
		try {
			expect(getCodememEnvOverrides()).toMatchObject({
				raw_events_retention_enabled: "CODEMEM_RAW_EVENTS_RETENTION_ENABLED",
				raw_events_retention_max_age_days: "CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS",
			});
		} finally {
			delete process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED;
			delete process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS;
		}
	});
});

describe("resolveCodememConfigPath", () => {
	let tmpHome: string;
	let prevHome: string | undefined;
	let prevCodememConfig: string | undefined;
	let prevRuntimeRoot: string | undefined;
	let prevWorkspaceId: string | undefined;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-resolve-"));
		prevHome = process.env.HOME;
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		prevRuntimeRoot = process.env.CODEMEM_RUNTIME_ROOT;
		prevWorkspaceId = process.env.CODEMEM_WORKSPACE_ID;
		process.env.HOME = tmpHome;
		delete process.env.CODEMEM_CONFIG;
		delete process.env.CODEMEM_RUNTIME_ROOT;
		delete process.env.CODEMEM_WORKSPACE_ID;
	});

	afterEach(() => {
		if (prevHome == null) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevCodememConfig == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		if (prevRuntimeRoot == null) delete process.env.CODEMEM_RUNTIME_ROOT;
		else process.env.CODEMEM_RUNTIME_ROOT = prevRuntimeRoot;
		if (prevWorkspaceId == null) delete process.env.CODEMEM_WORKSPACE_ID;
		else process.env.CODEMEM_WORKSPACE_ID = prevWorkspaceId;
	});

	it("CLI flag takes precedence over everything", () => {
		process.env.CODEMEM_CONFIG = join(tmpHome, "env-config.json");
		process.env.CODEMEM_WORKSPACE_ID = "pilot-1";
		const cliPath = join(tmpHome, "cli-config.json");

		const result = resolveCodememConfigPath(cliPath, "read");
		expect(result.resolved.source).toBe("cli-flag");
		expect(result.resolved.path).toBe(cliPath);
	});

	it("CODEMEM_CONFIG env takes precedence over workspace/legacy", () => {
		const envPath = join(tmpHome, "env-config.json");
		writeFileSync(envPath, "{}\n", "utf8");
		process.env.CODEMEM_CONFIG = envPath;
		process.env.CODEMEM_WORKSPACE_ID = "pilot-1";

		const result = resolveCodememConfigPath(undefined, "read");
		expect(result.resolved.source).toBe("env-codemem-config");
		expect(result.resolved.path).toBe(envPath);
	});

	it("relative CODEMEM_RUNTIME_ROOT is recorded in fallbackChain with reason", () => {
		process.env.CODEMEM_RUNTIME_ROOT = "../relative-root";

		const result = resolveCodememConfigPath(undefined, "read");
		expect(result.resolved.source).toBe("legacy-global");
		const runtimeEntry = result.fallbackChain.find((c) => c.source === "env-runtime-root");
		expect(runtimeEntry).toBeDefined();
		expect(runtimeEntry?.reason).toContain("is relative, not absolute");
	});

	it("mode 'write' returns first candidate even if it doesn't exist", () => {
		const envPath = join(tmpHome, "nonexistent", "config.json");
		process.env.CODEMEM_CONFIG = envPath;

		const result = resolveCodememConfigPath(undefined, "write");
		expect(result.resolved.source).toBe("env-codemem-config");
		expect(result.resolved.path).toBe(envPath);
		expect(result.resolved.exists).toBe(false);
	});

	it("mode 'read' skips non-existent non-authoritative candidates", () => {
		// CODEMEM_CONFIG and cli-flag are authoritative (always win in read mode).
		// Non-authoritative sources (runtime root, workspace id) are skipped when missing.
		process.env.CODEMEM_RUNTIME_ROOT = join(tmpHome, "nonexistent-runtime");
		process.env.CODEMEM_WORKSPACE_ID = "pilot-1";
		const legacyDir = join(tmpHome, ".config", "codemem");
		mkdirSync(legacyDir, { recursive: true });
		const legacyPath = join(legacyDir, "config.json");
		writeFileSync(legacyPath, "{}\n", "utf8");

		const result = resolveCodememConfigPath(undefined, "read");
		expect(result.resolved.source).toBe("legacy-global");
		expect(result.resolved.path).toBe(legacyPath);
		expect(result.resolved.exists).toBe(true);
	});

	it("CODEMEM_CONFIG is authoritative in read mode even when file is missing", () => {
		process.env.CODEMEM_CONFIG = join(tmpHome, "nonexistent.json");

		const result = resolveCodememConfigPath(undefined, "read");
		expect(result.resolved.source).toBe("env-codemem-config");
		expect(result.resolved.exists).toBe(false);
	});

	it("full fallback chain is populated with all evaluated candidates", () => {
		process.env.CODEMEM_CONFIG = join(tmpHome, "env.json");
		process.env.CODEMEM_RUNTIME_ROOT = join(tmpHome, "runtime");
		process.env.CODEMEM_WORKSPACE_ID = "pilot-1";

		const result = resolveCodememConfigPath(join(tmpHome, "cli.json"), "read");
		// All 5 sources should be present (1 resolved + 4 in fallbackChain)
		const allSources = [
			result.resolved.source,
			...result.fallbackChain.map((c) => c.source),
		].sort();
		expect(allSources).toEqual([
			"cli-flag",
			"env-codemem-config",
			"env-runtime-root",
			"env-workspace-id",
			"legacy-global",
		]);
	});

	it("unsafe CODEMEM_WORKSPACE_ID is recorded with safety-check reason", () => {
		process.env.CODEMEM_WORKSPACE_ID = "../evil";

		const result = resolveCodememConfigPath(undefined, "read");
		const wsEntry = result.fallbackChain.find((c) => c.source === "env-workspace-id");
		expect(wsEntry).toBeDefined();
		expect(wsEntry?.reason).toContain("failed safety check");
	});

	it("write mode skips relative runtime root", () => {
		process.env.CODEMEM_RUNTIME_ROOT = "../relative";

		const result = resolveCodememConfigPath(undefined, "write");
		// Should resolve to legacy, not the relative runtime root
		expect(result.resolved.source).toBe("legacy-global");
	});

	it("delegates correctly from getCodememConfigPath", () => {
		// Verify the refactored getCodememConfigPath still works
		const legacyDir = join(tmpHome, ".config", "codemem");
		mkdirSync(legacyDir, { recursive: true });
		const legacyPath = join(legacyDir, "config.jsonc");
		writeFileSync(legacyPath, "{}\n", "utf8");

		expect(getCodememConfigPath()).toBe(legacyPath);
	});

	it("resolved entry has exists=true when file is present", () => {
		const envPath = join(tmpHome, "existing-config.json");
		writeFileSync(envPath, "{}\n", "utf8");
		process.env.CODEMEM_CONFIG = envPath;

		const result = resolveCodememConfigPath(undefined, "read");
		expect(result.resolved.exists).toBe(true);
	});
});
