import { describe, expect, it } from "vitest";
import { lintFeedbackLoadError, loadLintFeedbackAdapters } from "./lint-feedback-loader.js";

describe("loadLintFeedbackAdapters", () => {
	it("returns the OpenCode 1 server and OpenCode 2 setup adapters", async () => {
		const server = () => ({});
		const setup = async () => undefined;

		const adapters = await loadLintFeedbackAdapters(async (specifier) =>
			specifier === "./lint-feedback.js" ? { default: server } : { default: { setup } },
		);

		expect(adapters).toEqual({ server, setup });
	});

	it("names the install command when a contributor dependency is missing", async () => {
		const missing = new Error(
			"Cannot find package '@babel/parser' imported from /checkout/lint-diagnostics.ts",
		);

		const load = loadLintFeedbackAdapters(async () => {
			throw missing;
		});

		await expect(load).rejects.toMatchObject({
			message: expect.stringContaining("@babel/parser is not installed in this codemem checkout"),
			cause: missing,
		});
		await expect(load).rejects.toThrow("pnpm install --frozen-lockfile");
		await expect(load).rejects.toThrow("opencode service restart");
	});
});

describe("lintFeedbackLoadError", () => {
	it("keeps relative module failures unchanged because they are source errors", () => {
		const error = new Error("Cannot find module './lint-feedback-core.js' imported from x.ts");

		expect(lintFeedbackLoadError(error)).toBe(error);
	});

	it("keeps unrelated load failures unchanged", () => {
		const error = new SyntaxError("Unexpected token");

		expect(lintFeedbackLoadError(error)).toBe(error);
	});
});
