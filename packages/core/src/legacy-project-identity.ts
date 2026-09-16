export function normalizeLegacyProjectMappingIdentity(value: string): string {
	return value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
}

export function isFilesystemRootProjectIdentity(value: string): boolean {
	const normalized = value.trim().replaceAll("\\", "/");
	if (normalized === "/" || /^[A-Za-z]:\/?$/u.test(normalized)) return true;
	if (/^\/\/[^/]+\/[^/]+\/?$/u.test(normalized)) return true;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "file:") return false;
		if (parsed.pathname === "/" || parsed.pathname === "") return true;
		if (parsed.hostname === "" && /^\/[A-Za-z]:\/?$/u.test(parsed.pathname)) return true;
		if (parsed.hostname === "" && /^\/\/[^/]+\/[^/]+\/?$/u.test(parsed.pathname)) return true;
		return parsed.hostname !== "" && parsed.pathname.split("/").filter(Boolean).length === 1;
	} catch {
		return false;
	}
}
