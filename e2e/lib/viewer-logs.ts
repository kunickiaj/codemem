export function redactViewerLog(text: string): string {
	return text
		.replace(
			/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
			"[redacted private key]",
		)
		.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
		.replace(
			/((?:[\w-]*(?:secret|token|password)|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"'}]+)/gi,
			"$1[redacted]",
		)
		.replace(/e2e-admin-secret/g, "[redacted]")
		.replace(/\/(?:Users|home)\/[^\s"']+/g, "[home path]");
}

export function viewerLogReadScript(logPath: string): string {
	// Redact inside the synthetic container so raw log output never enters host artifacts.
	return `import { readFileSync } from 'node:fs';
const redact = ${redactViewerLog.toString()};
console.log(redact(readFileSync(${JSON.stringify(logPath)}, 'utf8')));`;
}

export function quoteShellArgument(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
