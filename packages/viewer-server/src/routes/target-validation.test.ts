import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VIEWER_IDENTITY_TARGET_KEYS } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentIdentityTarget, validateViewerTarget } from "./target-validation.js";

let home: string;
const store = { dbPath: "/test/memories.sqlite", hasCurrentIdentity: () => true };

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-target-validation-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", undefined);
	vi.stubEnv("CODEMEM_RUNTIME_ROOT", undefined);
	vi.stubEnv("CODEMEM_WORKSPACE_ID", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function createConfig(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{}");
}

function validateIdentity(overrides: Record<string, unknown>) {
	return validateViewerTarget(store, {
		db_path: store.dbPath,
		identity_target: { ...currentIdentityTarget(), ...overrides },
	});
}

describe("equivalent implicit config targets", () => {
	it.each(["implicit", "explicit"])("accepts the default config with an %s viewer", (viewer) => {
		const path = join(home, ".config", "codemem", "config.json");
		if (viewer === "explicit") vi.stubEnv("CODEMEM_CONFIG", path);
		const requested = viewer === "explicit" ? null : path;
		expect(validateIdentity({ config_path: requested })).toEqual({ ok: true });
		expect(currentIdentityTarget().config_path).toBe(viewer === "explicit" ? path : null);
	});

	it("uses the core default, not XDG_CONFIG_HOME", () => {
		const xdg = join(home, "xdg");
		vi.stubEnv("XDG_CONFIG_HOME", xdg);
		createConfig(join(xdg, "codemem", "config.json"));
		expect(
			validateIdentity({ config_path: join(home, ".config", "codemem", "config.json") }),
		).toEqual({ ok: true });
		expect(validateIdentity({ config_path: join(xdg, "codemem", "config.json") })).toMatchObject({
			status: 409,
			body: { error: { code: "viewer_identity_mismatch" } },
		});
	});

	it("selects legacy JSONC only when JSON is absent", () => {
		const json = join(home, ".config", "codemem", "config.json");
		const jsonc = `${json}c`;
		createConfig(jsonc);
		vi.stubEnv("CODEMEM_CONFIG", jsonc);
		expect(validateIdentity({ config_path: null })).toEqual({ ok: true });
		createConfig(json);
		expect(validateIdentity({ config_path: null })).toMatchObject({ status: 409 });
	});

	it.each(["runtime", "workspace"])("uses the %s config read fallback", (scope) => {
		let scoped: string;
		if (scope === "runtime") {
			const root = join(home, "runtime");
			vi.stubEnv("CODEMEM_RUNTIME_ROOT", root);
			scoped = join(root, "config", "codemem.json");
		} else {
			vi.stubEnv("CODEMEM_WORKSPACE_ID", "test-workspace");
			scoped = join(home, ".codemem", "workspaces", "test-workspace", "config", "codemem.json");
		}
		const global = join(home, ".config", "codemem", "config.json");
		createConfig(global);
		vi.stubEnv("CODEMEM_CONFIG", global);
		expect(validateIdentity({ config_path: null })).toEqual({ ok: true });
		createConfig(scoped);
		expect(validateIdentity({ config_path: null })).toMatchObject({ status: 409 });
		vi.stubEnv("CODEMEM_CONFIG", scoped);
		expect(validateIdentity({ config_path: null })).toEqual({ ok: true });
	});

	it.each(["relative", ".."])("ignores an invalid implicit scope %s", (scope) => {
		if (scope === "relative") vi.stubEnv("CODEMEM_RUNTIME_ROOT", scope);
		else vi.stubEnv("CODEMEM_WORKSPACE_ID", scope);
		vi.stubEnv("CODEMEM_CONFIG", join(home, ".config", "codemem", "config.json"));
		expect(validateIdentity({ config_path: null })).toEqual({ ok: true });
	});
});

describe("target rejection and compatibility", () => {
	it.each(["implicit", "explicit"])("rejects a different config for an %s viewer", (viewer) => {
		if (viewer === "explicit") vi.stubEnv("CODEMEM_CONFIG", join(home, "different.json"));
		const config = viewer === "explicit" ? null : join(home, "different.json");
		expect(validateIdentity({ config_path: config })).toMatchObject({
			status: 409,
			body: { error: { code: "viewer_identity_mismatch" } },
		});
	});

	it("does not equate different explicit configs", () => {
		vi.stubEnv("CODEMEM_CONFIG", join(home, "different.json"));
		expect(
			validateIdentity({ config_path: join(home, ".config", "codemem", "config.json") }),
		).toMatchObject({ status: 409 });
	});

	it.each(["", " ", "~/different.json", "relative.json", "bad\u0000path"])(
		"keeps malformed string path %j mismatched",
		(path) => {
			vi.stubEnv("CODEMEM_CONFIG", join(home, ".config", "codemem", "config.json"));
			expect(validateIdentity({ config_path: path })).toMatchObject({ status: 409 });
		},
	);

	it.each([undefined, 123, false, {}, []])("rejects non-string config path %j", (path) => {
		expect(validateIdentity({ config_path: path })).toMatchObject({
			status: 400,
			body: { error: { code: "invalid_request" } },
		});
	});

	it.each(VIEWER_IDENTITY_TARGET_KEYS.filter((key) => key !== "config_path"))(
		"still rejects a different %s after config equivalence",
		(key) => {
			vi.stubEnv("CODEMEM_CONFIG", join(home, ".config", "codemem", "config.json"));
			const value = currentIdentityTarget()[key];
			const changed = typeof value === "boolean" ? !value : "different";
			expect(validateIdentity({ config_path: null, [key]: changed })).toMatchObject({
				status: 409,
				body: { error: { code: "viewer_identity_mismatch" } },
			});
		},
	);

	it("still rejects unsupported contracts", () => {
		expect(validateIdentity({ future_field: "unsupported" })).toMatchObject({
			status: 409,
			body: { error: { code: "viewer_contract_unsupported" } },
		});
		const { config_path: _config, ...incomplete } = currentIdentityTarget();
		expect(validateViewerTarget(store, { identity_target: incomplete })).toMatchObject({
			status: 409,
			body: { error: { code: "viewer_contract_unsupported" } },
		});
	});

	it("preserves missing-target compatibility", () => {
		const staleStore = { ...store, hasCurrentIdentity: () => false };
		expect(validateViewerTarget(staleStore, {})).toEqual({ ok: true });
		expect(validateViewerTarget(staleStore, { identity_target: null })).toEqual({ ok: true });
	});

	it("still requires the current store identity for equivalent config targets", () => {
		vi.stubEnv("CODEMEM_CONFIG", join(home, ".config", "codemem", "config.json"));
		expect(
			validateViewerTarget(
				{ ...store, hasCurrentIdentity: () => false },
				{
					identity_target: { ...currentIdentityTarget(), config_path: null },
				},
			),
		).toMatchObject({ status: 409, body: { error: { code: "viewer_identity_mismatch" } } });
	});
});
