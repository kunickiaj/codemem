import {
	closeSync,
	fchmodSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicReplaceConfigFile } from "./observer-config.js";

describe("config replacement writes", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-write-"));
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("completes positional short writes before rename", () => {
		const configPath = join(tmpHome, "short-write.json");
		writeFileSync(configPath, '{"existing":true}\n', "utf8");
		const replacement = '{"replacement":"complete utf8: 🧠"}\n';

		atomicReplaceConfigFile(configPath, replacement, 0o640, {
			open: openSync,
			close: closeSync,
			chmod: fchmodSync,
			sync: fsyncSync,
			write: (fd, buffer, offset, length, position) =>
				writeSync(fd, buffer, offset, Math.min(length, 3), position),
			rename: renameSync,
			unlink: unlinkSync,
		});

		expect(readFileSync(configPath, "utf8")).toBe(replacement);
	});

	it("rejects zero-progress writes without replacing the original", () => {
		const configPath = join(tmpHome, "zero-write.json");
		const original = '{"existing":true}\n';
		writeFileSync(configPath, original, "utf8");

		expect(() =>
			atomicReplaceConfigFile(configPath, '{"replacement":true}\n', 0o640, {
				open: openSync,
				close: closeSync,
				chmod: fchmodSync,
				sync: fsyncSync,
				write: () => 0,
				rename: renameSync,
				unlink: unlinkSync,
			}),
		).toThrow("Config replacement write made no progress");
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});
});
