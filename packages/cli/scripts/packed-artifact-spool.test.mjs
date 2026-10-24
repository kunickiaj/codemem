import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAdapterNormalizers } from "../../../scripts/build-adapter-normalizers.mjs";
import { smokeCodexSpoolIsolation } from "./packed-artifact-smoke.mjs";

describe("packed Codex spool fixture project", () => {
	let fixture;

	afterEach(() => {
		vi.unstubAllEnvs();
		if (fixture) rmSync(fixture, { recursive: true, force: true });
	});

	it.each(["packed-fixture-project", undefined])(
		"preserves envelope bytes with parent project %s and an isolated child",
		async (project) => {
			// Arrange: the child omits ambient env; transport/fallbacks are mocked by the smoke helper.
			vi.stubEnv("CODEMEM_PROJECT", project);
			fixture = mkdtempSync(join(tmpdir(), "codemem-packed-spool-test-"));
			cpSync(
				resolve(import.meta.dirname, "../../../plugins/codex/scripts"),
				join(fixture, "plugins/codex/scripts"),
				{ recursive: true },
			);
			await buildAdapterNormalizers(fixture);

			// Act: exercise failed delivery, byte-exact spool persistence, and successful bounded drain.
			const result = smokeCodexSpoolIsolation(fixture);

			// Assert: retain every assertion in the exported packed smoke, including byte equality.
			await expect(result).resolves.toBeUndefined();
		},
	);
});
