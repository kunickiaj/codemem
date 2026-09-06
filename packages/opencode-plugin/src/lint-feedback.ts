import { createRequire } from "node:module";
import { LintFeedbackPlugin } from "./lint-feedback-core.js";

const biomeEntrypoint = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

export default ((input) =>
	LintFeedbackPlugin(input, {
		command: [process.execPath, biomeEntrypoint, "lint", "--reporter=json"],
		timeoutMs: 10_000,
	})) satisfies typeof LintFeedbackPlugin;
