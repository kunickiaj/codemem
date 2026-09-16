/**
 * True when the CLI process was invoked through the named top-level
 * compatibility alias (first non-flag token of the real argv). Forwarding
 * wrappers such as `memory export` re-parse the alias command with synthetic
 * argv, so this stays false for canonical invocations.
 */
export function invokedAsTopLevelAlias(
	name: string,
	argv: readonly string[] = process.argv.slice(2),
): boolean {
	for (const token of argv) {
		if (token === "--") return false;
		if (!token.startsWith("-")) return token === name;
	}
	return false;
}
