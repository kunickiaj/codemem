/**
 * Shared helpers for the `apply_patch` tool and Claude Code mutating tools.
 *
 * Both the CLI hook session-state tracker and the core raw-event flush path
 * need to (a) recognize which tool names represent file-mutation tools and
 * (b) parse paths out of an `apply_patch` patch text. Keeping one copy here
 * avoids drift between the two code paths.
 *
 * Only Add/Update/Delete markers are supported, matching the plugin-side
 * helper in `packages/opencode-plugin/.opencode/plugins/codemem.js`.
 */

/**
 * Tool names (lowercased) that mutate files.
 *
 * `apply_patch` is the OpenCode primary mutation tool; `edit`, `write`,
 * `multiedit`, and `notebookedit` are Claude Code's mutation tools. The
 * tool name is compared after lowercasing the raw payload value.
 */
export const MUTATING_TOOL_NAMES = new Set<string>([
	"edit",
	"write",
	"multiedit",
	"notebookedit",
	"apply_patch",
]);

/**
 * Extract file paths mentioned in an `apply_patch` patchText.
 *
 * The `apply_patch` tool encodes paths inline using the
 * `*** Add File: <path>` / `*** Update File: <path>` /
 * `*** Delete File: <path>` markers rather than a dedicated `filePath` arg.
 * This parser mirrors `extractApplyPatchPaths` in the OpenCode plugin so the
 * plugin's live context tracking and the core session-context rebuild agree.
 *
 * Returns paths in first-seen order, deduplicated. Handles both LF and CRLF
 * line endings. Silently ignores empty / non-patch input.
 */
export function extractApplyPatchPaths(patchText: string): string[] {
	if (!patchText) return [];
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const rawLine of patchText.split(/\r?\n/)) {
		const match = rawLine.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
		if (!match) continue;
		const path = (match[1] ?? "").trim();
		if (!path || seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
	}
	return paths;
}
