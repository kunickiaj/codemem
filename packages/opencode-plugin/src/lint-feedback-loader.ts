import type LintFeedbackPlugin from "./lint-feedback.js";
import type LintFeedbackV2Plugin from "./lint-feedback-v2.js";

const MISSING_PACKAGE_PATTERN = /Cannot find (?:package|module) ['"]([^'"]+)['"]/;

export interface LintFeedbackAdapters {
	server: typeof LintFeedbackPlugin;
	setup: (typeof LintFeedbackV2Plugin)["setup"];
}

type ImportAdapter = (specifier: "./lint-feedback.js" | "./lint-feedback-v2.js") => Promise<{
	default: unknown;
}>;

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const missing = message.match(MISSING_PACKAGE_PATTERN)?.[1];
	// Relative module failures are source bugs, not an incomplete dependency install.
	if (!missing || missing.startsWith(".") || missing.startsWith("/")) return undefined;
	return missing;
}

export function lintFeedbackLoadError(error: unknown): unknown {
	const packageName = missingPackageName(error);
	if (!packageName) return error;
	return new Error(
		`[lint-feedback] ${packageName} is not installed in this codemem checkout. ` +
			"Run `pnpm install --frozen-lockfile` from the repository root, then reload OpenCode. " +
			"If OpenCode still reports the missing package, run `opencode service restart`.",
		{ cause: error },
	);
}

export async function loadLintFeedbackAdapters(
	importAdapter: ImportAdapter = (specifier) => import(specifier),
): Promise<LintFeedbackAdapters> {
	try {
		const [v1, v2] = await Promise.all([
			importAdapter("./lint-feedback.js"),
			importAdapter("./lint-feedback-v2.js"),
		]);
		return {
			server: v1.default as LintFeedbackAdapters["server"],
			setup: (v2.default as typeof LintFeedbackV2Plugin).setup,
		};
	} catch (error) {
		throw lintFeedbackLoadError(error);
	}
}
