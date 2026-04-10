import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logHookFailure, pluginLogPath } from "./claude-hook-plugin-log.js";

describe("claude-hook-plugin-log", () => {
	let baseDir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "codemem-cli-plugin-log-"));
		for (const key of ["CODEMEM_PLUGIN_LOG_PATH", "CODEMEM_PLUGIN_LOG"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(baseDir, { recursive: true, force: true });
	});

	describe("pluginLogPath", () => {
		it("returns the expanded default when no env override is set", () => {
			expect(pluginLogPath().endsWith("/.codemem/plugin.log")).toBe(true);
		});

		it("uses CODEMEM_PLUGIN_LOG_PATH when it points at a real path", () => {
			const target = join(baseDir, "custom.log");
			process.env.CODEMEM_PLUGIN_LOG_PATH = target;
			expect(pluginLogPath()).toBe(target);
		});

		it("treats boolean-shaped CODEMEM_PLUGIN_LOG values as toggles, not paths", () => {
			for (const value of ["1", "0", "true", "false", "yes", "no", "on", "off", ""]) {
				process.env.CODEMEM_PLUGIN_LOG = value;
				expect(pluginLogPath().endsWith("/.codemem/plugin.log")).toBe(true);
			}
		});

		it("CODEMEM_PLUGIN_LOG_PATH takes precedence over CODEMEM_PLUGIN_LOG", () => {
			const target = join(baseDir, "preferred.log");
			process.env.CODEMEM_PLUGIN_LOG_PATH = target;
			process.env.CODEMEM_PLUGIN_LOG = join(baseDir, "ignored.log");
			expect(pluginLogPath()).toBe(target);
		});
	});

	describe("logHookFailure", () => {
		it("appends a timestamped line to the configured log path", () => {
			const target = join(baseDir, "logs", "plugin.log");
			process.env.CODEMEM_PLUGIN_LOG_PATH = target;

			logHookFailure("first failure");
			logHookFailure("second failure");

			expect(existsSync(target)).toBe(true);
			const content = readFileSync(target, "utf8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z first failure$/);
			expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z second failure$/);
		});

		it("creates parent directories on first write", () => {
			const target = join(baseDir, "deep", "nested", "plugin.log");
			process.env.CODEMEM_PLUGIN_LOG_PATH = target;
			logHookFailure("nested write");
			expect(existsSync(target)).toBe(true);
		});

		it("swallows errors when the path is unwritable", () => {
			// Pointing the log at a path whose parent is a regular file forces
			// an EEXIST/ENOTDIR on mkdirSync. The function must not throw.
			const blocker = join(baseDir, "blocker");
			writeFileSync(blocker, "not a dir", "utf8");
			process.env.CODEMEM_PLUGIN_LOG_PATH = join(blocker, "plugin.log");
			expect(() => logHookFailure("should not throw")).not.toThrow();
		});
	});
});
