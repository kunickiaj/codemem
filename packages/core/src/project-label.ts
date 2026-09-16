/** Normalize a raw label value to a plain project name (basename if path). */
export function normalizeProjectLabel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	// Strip trailing path separators with a linear scan rather than a regex.
	// Values can originate from uncontrolled host payloads.
	const trimmed = value.trim();
	let end = trimmed.length;
	while (end > 0) {
		const code = trimmed.charCodeAt(end - 1);
		if (code === 47 /* / */ || code === 92 /* \\ */) end -= 1;
		else break;
	}
	const cleaned = trimmed.slice(0, end);
	if (!cleaned) return null;
	if (cleaned.includes("/") || cleaned.includes("\\")) {
		const isWindows =
			cleaned.includes("\\") ||
			(cleaned.length >= 2 && cleaned[1] === ":" && /[a-zA-Z]/.test(cleaned[0] ?? ""));
		const parts = (isWindows ? cleaned.replaceAll("\\", "/") : cleaned).split("/");
		return parts[parts.length - 1] || null;
	}
	return cleaned;
}
