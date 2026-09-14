import LintFeedbackPlugin from "../../packages/opencode-plugin/src/lint-feedback.ts";

export default Object.freeze({
	id: "codemem-lint-feedback",
	server: LintFeedbackPlugin,
	setup: async () => undefined,
});
