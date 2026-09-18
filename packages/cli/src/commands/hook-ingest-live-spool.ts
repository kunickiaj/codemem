import { randomInt } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logHookEvent } from "./claude-hook-plugin-log.js";

export function spoolLiveHookPayload(
	dir: string,
	payload: Record<string, unknown>,
	logPrefix: string,
): string | null {
	const startedAt = Date.now();
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		logHookEvent(`${logPrefix} failed to create spool dir`);
		return null;
	}

	const suffix = `${process.pid}-${randomInt(1000, 10000)}.json`;
	const tmpName = `.hook-tmp-live-${Date.now()}-${suffix}`;
	const finalName = `zz-hook-live-${Date.now()}-${suffix}`;
	const tmpPath = join(dir, tmpName);
	try {
		writeFileSync(tmpPath, JSON.stringify(payload), { encoding: "utf8" });
		renameSync(tmpPath, join(dir, finalName));
	} catch {
		try {
			unlinkSync(tmpPath);
		} catch {
			// best-effort
		}
		logHookEvent(`${logPrefix} failed to spool live payload`);
		return null;
	}
	logHookEvent(`${logPrefix} spooled live payload elapsed_ms=${Date.now() - startedAt}`);
	return finalName;
}

export function removeLiveHookPayload(dir: string, name: string): boolean {
	if (name.includes("/") || name.includes("\\") || !name.startsWith("zz-hook-live-")) return false;
	try {
		unlinkSync(join(dir, name));
		return true;
	} catch {
		return false;
	}
}
