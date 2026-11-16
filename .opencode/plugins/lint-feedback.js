import { loadLintFeedbackAdapters } from "../../packages/opencode-plugin/src/lint-feedback-loader.ts";

// Dynamic adapter loading lets a missing contributor dependency report its install command.
const { server, setup } = await loadLintFeedbackAdapters();

export default Object.freeze({
	id: "codemem-lint-feedback",
	server,
	setup,
});
