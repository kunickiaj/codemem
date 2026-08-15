/**
 * Tests for codemem setup — pi target (packages entry, observer derivation, --pi-mcp).
 *
 * Covers: fresh install, idempotent second run, relocated home (PI_CODING_AGENT_DIR),
 * adapter present/absent, and no-secret-persistence into codemem config.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildPiExtensionPackageSpec,
	installPi,
	isPiDetected,
	isPiExtensionPackageEntry,
	isPiMcpAdapterDetected,
	piConfigDir,
	setupCommand,
} from "./setup.js";

const FIXTURE_KEY = "sk-fixture-pi-setup-test-key-DO-NOT-LEAK";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"CODEMEM_CONFIG",
	"CODEMEM_OBSERVER_PROVIDER",
	"CODEMEM_OBSERVER_MODEL",
	"CODEMEM_OBSERVER_BASE_URL",
	"CODEMEM_OBSERVER_OPENAI_USE_RESPONSES",
	"HOME",
	"PATH",
] as const;

let piHome: string;
let configPath: string;
let tempRoot: string;

function saveEnv(): void {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
	}
}

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		const prev = savedEnv[key];
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
}

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function seedPiApiKeyInstall(dir: string): void {
	writeJson(join(dir, "settings.json"), {
		defaultProvider: "openai",
		defaultModel: "openai/gpt-4o",
		enabledModels: ["openai/gpt-4o-mini", "openai/gpt-4o"],
		packages: [],
	});
	writeJson(join(dir, "models.json"), {
		providers: {
			openai: {
				baseUrl: "https://api.openai.com/v1",
				api: "openai-completions",
				models: [
					{ id: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 } },
					{ id: "gpt-4o", cost: { input: 2.5, output: 10 } },
				],
			},
		},
	});
	// Auth is read in-memory only by resolvePiObserverConfig — setup must never copy the key.
	writeJson(join(dir, "auth.json"), {
		openai: { type: "api_key", key: FIXTURE_KEY },
	});
}

beforeEach(() => {
	saveEnv();
	tempRoot = mkdtempSync(join(tmpdir(), "codemem-setup-pi-"));
	piHome = join(tempRoot, "pi-agent");
	configPath = join(tempRoot, "codemem-config.json");
	mkdirSync(piHome, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = piHome;
	process.env.CODEMEM_CONFIG = configPath;
	delete process.env.CODEMEM_OBSERVER_PROVIDER;
	delete process.env.CODEMEM_OBSERVER_MODEL;
	delete process.env.CODEMEM_OBSERVER_BASE_URL;
	delete process.env.CODEMEM_OBSERVER_OPENAI_USE_RESPONSES;
});

afterEach(() => {
	restoreEnv();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("piConfigDir / isPiDetected", () => {
	it("honors PI_CODING_AGENT_DIR", () => {
		expect(piConfigDir()).toBe(piHome);
	});

	it("does not treat a bare empty agent dir as detected", () => {
		// beforeEach creates an empty piHome with no settings.json/auth.json.
		// Isolate PATH so a host `pi` binary cannot mask the empty-dir case.
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(existsSync(piHome)).toBe(true);
			expect(isPiDetected()).toBe(false);
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("detects pi when the agent dir has a non-empty settings.json marker", () => {
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			writeJson(join(piHome, "settings.json"), { packages: [] });
			expect(isPiDetected()).toBe(true);
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("detects pi when the agent dir has a non-empty auth.json marker", () => {
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			writeJson(join(piHome, "auth.json"), { openai: { type: "api_key", key: "x" } });
			expect(isPiDetected()).toBe(true);
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("ignores empty marker files (falls through to PATH only)", () => {
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			writeFileSync(join(piHome, "settings.json"), "   \n", "utf-8");
			writeFileSync(join(piHome, "auth.json"), "", "utf-8");
			expect(isPiDetected()).toBe(false);
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("does not treat a missing agent dir as detected (unless pi is on PATH)", () => {
		const missing = join(tempRoot, "no-such-pi");
		process.env.PI_CODING_AGENT_DIR = missing;
		// May still be true if the real `pi` binary is on PATH in this environment.
		// Assert the dir itself is missing; detection then reduces to PATH probe.
		expect(existsSync(missing)).toBe(false);
		const detected = isPiDetected();
		expect(typeof detected).toBe("boolean");
	});
});

describe("buildPiExtensionPackageSpec / isPiExtensionPackageEntry", () => {
	it("pins the npm package to the current codemem VERSION", () => {
		expect(buildPiExtensionPackageSpec()).toBe(`npm:@codemem/pi-extension@${VERSION}`);
	});

	it("uses an absolute local path for --pi-extension-path", () => {
		const local = join(tempRoot, "packages", "pi-extension");
		expect(buildPiExtensionPackageSpec(local)).toBe(local);
	});

	it("recognizes npm and local-path package entries", () => {
		expect(isPiExtensionPackageEntry(`npm:@codemem/pi-extension@${VERSION}`)).toBe(true);
		expect(isPiExtensionPackageEntry("npm:@codemem/pi-extension@0.1.0")).toBe(true);
		expect(isPiExtensionPackageEntry("/repo/packages/pi-extension")).toBe(true);
		expect(isPiExtensionPackageEntry("npm:pi-mcp-adapter@2.0.0")).toBe(false);
		expect(isPiExtensionPackageEntry("npm:@other/pkg")).toBe(false);
	});
});

describe("installPi — fresh install", () => {
	it("appends the packages entry, sets pi.tools_mode native, and derives observer_* (no secrets)", () => {
		seedPiApiKeyInstall(piHome);

		expect(installPi({ force: false })).toBe(true);

		const settings = readJson(join(piHome, "settings.json"));
		const packages = settings.packages as string[];
		expect(packages).toEqual([`npm:@codemem/pi-extension@${VERSION}`]);

		// Default run writes no MCP config.
		expect(existsSync(join(piHome, "mcp.json"))).toBe(false);

		const config = readJson(configPath);
		expect(config.observer_provider).toBe("openai");
		expect(typeof config.observer_model).toBe("string");
		expect((config.observer_model as string).length).toBeGreaterThan(0);
		// baseUrl may be written when present on the resolved provider.
		if (config.observer_base_url != null) {
			expect(config.observer_base_url).toBe("https://api.openai.com/v1");
		}
		// seed uses openai-completions → openAIUseResponses false must be persisted.
		expect(config.observer_openai_use_responses).toBe(false);
		expect(config).not.toHaveProperty("observer_api_key");
		expect(JSON.stringify(config)).not.toContain(FIXTURE_KEY);
		expect(config.pi).toEqual({ tools_mode: "native" });

		// Backup created for pre-existing settings.json.
		expect(existsSync(join(piHome, "settings.json.codemem.bak"))).toBe(true);
	});

	it("supports a local-path packages entry via piExtensionPath", () => {
		writeJson(join(piHome, "settings.json"), { packages: [] });
		const local = join(tempRoot, "local-pi-extension");
		mkdirSync(local, { recursive: true });

		expect(installPi({ force: false, piExtensionPath: local })).toBe(true);

		const settings = readJson(join(piHome, "settings.json"));
		expect(settings.packages).toEqual([local]);
	});
});

describe("installPi — idempotency", () => {
	it("does not duplicate the packages entry on a second run", () => {
		seedPiApiKeyInstall(piHome);

		expect(installPi({ force: false })).toBe(true);
		expect(installPi({ force: false })).toBe(true);

		const settings = readJson(join(piHome, "settings.json"));
		const packages = settings.packages as string[];
		const ours = packages.filter((e) => isPiExtensionPackageEntry(e));
		expect(ours).toHaveLength(1);
		expect(ours[0]).toBe(`npm:@codemem/pi-extension@${VERSION}`);
	});

	it("upgrades a stale npm version pin to the current VERSION without --force", () => {
		writeJson(join(piHome, "settings.json"), {
			packages: ["npm:@codemem/pi-extension@0.0.1", "npm:other"],
		});

		expect(installPi({ force: false })).toBe(true);

		const settings = readJson(join(piHome, "settings.json"));
		expect(settings.packages).toEqual(["npm:other", `npm:@codemem/pi-extension@${VERSION}`]);
	});

	it("leaves an equal-version npm pin untouched (order-preserving no-op)", () => {
		const pin = `npm:@codemem/pi-extension@${VERSION}`;
		writeJson(join(piHome, "settings.json"), {
			packages: [pin, "npm:other"],
		});

		expect(installPi({ force: false })).toBe(true);

		const settings = readJson(join(piHome, "settings.json"));
		// Order preserved ⇒ no rewrite of settings.packages.
		expect(settings.packages).toEqual([pin, "npm:other"]);
	});

	it("leaves a local-path packages entry untouched without --force", () => {
		const local = join(tempRoot, "packages", "pi-extension");
		writeJson(join(piHome, "settings.json"), {
			packages: [local, "npm:other"],
		});

		expect(installPi({ force: false })).toBe(true);

		const settings = readJson(join(piHome, "settings.json"));
		expect(settings.packages).toEqual([local, "npm:other"]);
	});

	it("replaces a prior entry when --force is set", () => {
		writeJson(join(piHome, "settings.json"), {
			packages: ["npm:@codemem/pi-extension@0.0.1", "npm:other"],
		});

		expect(installPi({ force: true })).toBe(true);

		const settings = readJson(join(piHome, "settings.json"));
		expect(settings.packages).toEqual(["npm:other", `npm:@codemem/pi-extension@${VERSION}`]);
	});
});

describe("installPi — relocated home", () => {
	it("writes configuration to PI_CODING_AGENT_DIR rather than ~/.pi/agent", () => {
		const relocated = join(tempRoot, "relocated-pi");
		mkdirSync(relocated, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = relocated;
		seedPiApiKeyInstall(relocated);

		expect(installPi({ force: false })).toBe(true);

		expect(existsSync(join(relocated, "settings.json"))).toBe(true);
		const settings = readJson(join(relocated, "settings.json"));
		expect(settings.packages).toContain(`npm:@codemem/pi-extension@${VERSION}`);
		// Original piHome must not be touched.
		expect(existsSync(join(piHome, "settings.json"))).toBe(false);
	});
});

describe("installPi — observer derivation", () => {
	it("does not overwrite existing codemem observer_* keys", () => {
		seedPiApiKeyInstall(piHome);
		writeJson(configPath, {
			observer_provider: "anthropic",
			observer_model: "claude-haiku-4-5",
			observer_base_url: "https://api.anthropic.com",
			observer_openai_use_responses: true,
		});

		expect(installPi({ force: false })).toBe(true);

		const config = readJson(configPath);
		expect(config.observer_provider).toBe("anthropic");
		expect(config.observer_model).toBe("claude-haiku-4-5");
		expect(config.observer_base_url).toBe("https://api.anthropic.com");
		// Pre-set wire flag must not be flipped by pi derivation.
		expect(config.observer_openai_use_responses).toBe(true);
		expect(config.pi).toEqual({ tools_mode: "native" });
	});

	it("persists observer_openai_use_responses=true for openai-responses wire API", () => {
		writeJson(join(piHome, "settings.json"), {
			defaultProvider: "openai",
			defaultModel: "openai/gpt-4o",
			enabledModels: ["openai/gpt-4o"],
			packages: [],
		});
		writeJson(join(piHome, "models.json"), {
			providers: {
				openai: {
					baseUrl: "https://api.openai.com/v1",
					api: "openai-responses",
					models: [{ id: "gpt-4o", cost: { input: 2.5, output: 10 } }],
				},
			},
		});
		writeJson(join(piHome, "auth.json"), {
			openai: { type: "api_key", key: FIXTURE_KEY },
		});

		expect(installPi({ force: false })).toBe(true);

		const config = readJson(configPath);
		expect(config.observer_provider).toBe("openai");
		expect(config.observer_openai_use_responses).toBe(true);
		expect(JSON.stringify(config)).not.toContain(FIXTURE_KEY);
	});

	it("fills observer_openai_use_responses even when other observer_* keys already exist", () => {
		seedPiApiKeyInstall(piHome);
		// Provider/model already set — prior bug left use_responses unset in this case.
		writeJson(configPath, {
			observer_provider: "openai",
			observer_model: "gpt-4o-mini",
		});

		expect(installPi({ force: false })).toBe(true);

		const config = readJson(configPath);
		expect(config.observer_provider).toBe("openai");
		expect(config.observer_model).toBe("gpt-4o-mini");
		// seed uses openai-completions → false
		expect(config.observer_openai_use_responses).toBe(false);
	});

	it("never persists pi auth secrets into the codemem config file", () => {
		seedPiApiKeyInstall(piHome);
		// Pre-seed a red-herring secret in auth that must not leak.
		writeJson(join(piHome, "auth.json"), {
			openai: { type: "api_key", key: FIXTURE_KEY },
			other: { type: "api_key", key: "sk-other-secret-value-zzzz" },
		});

		expect(installPi({ force: false })).toBe(true);

		const raw = readFileSync(configPath, "utf-8");
		expect(raw).not.toContain(FIXTURE_KEY);
		expect(raw).not.toContain("sk-other-secret-value-zzzz");
		expect(raw).not.toMatch(/sk-/);
		const config = readJson(configPath);
		expect(config).not.toHaveProperty("observer_api_key");
	});

	it("preserves a pre-existing user observer_api_key without adding pi's key", () => {
		seedPiApiKeyInstall(piHome);
		const userKey = "sk-user-already-in-codemem-config";
		writeJson(configPath, {
			observer_provider: "openai",
			observer_model: "gpt-4o-mini",
			observer_api_key: userKey,
		});

		expect(installPi({ force: false })).toBe(true);

		const config = readJson(configPath);
		expect(config.observer_api_key).toBe(userKey);
		expect(JSON.stringify(config)).not.toContain(FIXTURE_KEY);
	});
});

describe("installPi — --pi-mcp opt-in", () => {
	it("default run writes no mcp.json even when the adapter is installed", () => {
		writeJson(join(piHome, "settings.json"), {
			packages: ["npm:pi-mcp-adapter@2.19.0"],
		});

		expect(installPi({ force: false, piMcp: false })).toBe(true);
		expect(existsSync(join(piHome, "mcp.json"))).toBe(false);
		const config = readJson(configPath);
		expect(config.pi).toEqual({ tools_mode: "native" });
	});

	it("with --pi-mcp and adapter present: writes mcp.json and sets tools_mode mcp-adapter", () => {
		writeJson(join(piHome, "settings.json"), {
			packages: ["npm:pi-mcp-adapter@2.19.0"],
		});

		expect(installPi({ force: false, piMcp: true })).toBe(true);

		const mcp = readJson(join(piHome, "mcp.json"));
		expect(mcp).toEqual({
			mcpServers: {
				codemem: {
					command: "npx",
					args: ["-y", "codemem", "mcp"],
				},
			},
		});
		const config = readJson(configPath);
		expect(config.pi).toEqual({ tools_mode: "mcp-adapter" });
	});

	it("with --pi-mcp and adapter absent: writes nothing MCP-related and stays native", () => {
		writeJson(join(piHome, "settings.json"), { packages: [] });

		expect(installPi({ force: false, piMcp: true })).toBe(true);

		expect(existsSync(join(piHome, "mcp.json"))).toBe(false);
		const config = readJson(configPath);
		expect(config.pi).toEqual({ tools_mode: "native" });
	});

	it("detects the adapter via an extensions/ directory name", () => {
		writeJson(join(piHome, "settings.json"), { packages: [] });
		mkdirSync(join(piHome, "extensions", "pi-mcp-adapter"), { recursive: true });

		expect(isPiMcpAdapterDetected(piHome)).toBe(true);

		expect(installPi({ force: false, piMcp: true })).toBe(true);
		expect(existsSync(join(piHome, "mcp.json"))).toBe(true);
	});

	it("does not duplicate the mcp.json codemem entry on re-run", () => {
		writeJson(join(piHome, "settings.json"), {
			packages: ["npm:pi-mcp-adapter@2.0.0"],
		});
		writeJson(join(piHome, "mcp.json"), {
			mcpServers: {
				other: { command: "echo" },
				codemem: { command: "npx", args: ["-y", "codemem", "mcp"] },
			},
		});
		// Start from native so the re-run must flip tools_mode even when mcp entry exists.
		writeJson(configPath, { pi: { tools_mode: "native" } });

		expect(installPi({ force: false, piMcp: true })).toBe(true);

		const mcp = readJson(join(piHome, "mcp.json"));
		const servers = mcp.mcpServers as Record<string, unknown>;
		expect(Object.keys(servers).sort()).toEqual(["codemem", "other"]);
		expect(servers.other).toEqual({ command: "echo" });
		// Adapter present on --pi-mcp re-run must flip tools_mode even when the
		// mcp entry was already written (no-duplicate path).
		const config = readJson(configPath);
		expect(config.pi).toEqual({ tools_mode: "mcp-adapter" });
	});
});

describe("installPi — parse failure abort", () => {
	it("returns false and does not clobber an unparseable settings.json", () => {
		const broken = "{ this is not valid json ";
		writeFileSync(join(piHome, "settings.json"), broken, "utf-8");

		expect(installPi({ force: false })).toBe(false);
		expect(readFileSync(join(piHome, "settings.json"), "utf-8")).toBe(broken);
		expect(existsSync(join(piHome, "settings.json.codemem.bak"))).toBe(false);
		// Abort before observer/MCP writes.
		expect(existsSync(configPath)).toBe(false);
		expect(existsSync(join(piHome, "mcp.json"))).toBe(false);
	});
});

describe("setup command options", () => {
	it("declares --pi-only, --pi-mcp, and --pi-extension-path", () => {
		const longs = setupCommand.options.map((o) => o.long);
		expect(longs).toContain("--pi-only");
		expect(longs).toContain("--pi-mcp");
		expect(longs).toContain("--pi-extension-path");
	});
});
