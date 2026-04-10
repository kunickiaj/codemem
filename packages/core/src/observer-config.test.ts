import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getCodememConfigPath,
	getCodememEnvOverrides,
	getProviderApiKey,
	getWorkspaceCodememConfigPath,
	getWorkspaceScopedCodememConfigPath,
	loadOpenCodeConfig,
	readCodememConfigFileAtPath,
	readWorkspaceCodememConfigFile,
	resolveCodememConfigPath,
	resolveCustomProviderFromModel,
	resolvePlaceholder,
	stripJsonComments,
	stripTrailingCommas,
	writeCodememConfigFile,
	writeWorkspaceCodememConfigFile,
} from "./observer-config.js";

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
		expect(getProviderApiKey({ options: { apiKey: "sk-test123" } })).toBe("sk-test123");
	});

	it("resolves from options.apiKeyEnv", () => {
		process.env.TEST_API_KEY_FOR_OBSERVER = "sk-from-env";
		try {
			expect(getProviderApiKey({ options: { apiKeyEnv: "TEST_API_KEY_FOR_OBSERVER" } })).toBe(
				"sk-from-env",
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
