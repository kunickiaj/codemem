const COMMAND_FAILURE_PREFIX = /^(?:command failed(?:\s|:)|error:\s|fatal:\s|git:\s)/iu;
const WRAPPED_GIT_FAILURE =
	/^(?:giterror|git error|git command failed):\s*(?:fatal:\s*)?(?:not a git repository|unknown revision or path|no such remote)\b/iu;

/** Return true when a discovery failure was supplied where Project identity was expected. */
export function isMalformedProjectIdentity(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const cleaned = value.trim();
	if (!cleaned) return false;
	if (cleaned.includes("\n") || cleaned.includes("\r")) return true;
	return COMMAND_FAILURE_PREFIX.test(cleaned) || WRAPPED_GIT_FAILURE.test(cleaned);
}

export function cleanProjectIdentity(value: string | null | undefined): string | null {
	const cleaned = value?.trim();
	if (!cleaned || isMalformedProjectIdentity(cleaned)) return null;
	return cleaned;
}
