import {
	closeSync,
	fchmodSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	atomicReplaceConfigFile,
	deleteCodememConfigFile,
	mutateCodememConfigFile,
} from "./observer-config.js";

describe("config replacement metadata", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-metadata-"));
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("applies existing ownership metadata to the replacement inode", () => {
		const configPath = join(tmpHome, "ownership.json");
		writeFileSync(configPath, '{"existing":true}\n', "utf8");
		const chown = vi.fn();

		atomicReplaceConfigFile(
			configPath,
			'{"replacement":true}\n',
			{ mode: 0o640, uid: 501, gid: 20 },
			{
				open: openSync,
				close: closeSync,
				chown,
				chmod: fchmodSync,
				sync: fsyncSync,
				write: writeFileSync,
				rename: renameSync,
				unlink: unlinkSync,
			},
		);

		expect(chown).toHaveBeenCalledWith(expect.any(Number), 501, 20);
	});

	it("rejects rollback deletion after a config symlink is retargeted", () => {
		const firstTarget = join(tmpHome, "first.json");
		const secondTarget = join(tmpHome, "second.json");
		const configPath = join(tmpHome, "linked.json");
		symlinkSync(firstTarget, configPath);
		const created = mutateCodememConfigFile(() => ({ created: true }), configPath);
		const createdText = readFileSync(firstTarget, "utf8");
		unlinkSync(configPath);
		writeFileSync(secondTarget, createdText, "utf8");
		symlinkSync(secondTarget, configPath);

		expect(() =>
			deleteCodememConfigFile(configPath, created.revision, created.mutationPath),
		).toThrow(expect.objectContaining({ code: "changed" }));
		expect(readFileSync(firstTarget, "utf8")).toBe(createdText);
		expect(readFileSync(secondTarget, "utf8")).toBe(createdText);
	});

	it("restores an existing config through its saved target after a symlink is retargeted", () => {
		const firstTarget = join(tmpHome, "existing-first.json");
		const secondTarget = join(tmpHome, "existing-second.json");
		const configPath = join(tmpHome, "existing-linked.json");
		const originalText = '{"existing":true}\n';
		writeFileSync(firstTarget, originalText, "utf8");
		symlinkSync(firstTarget, configPath);
		const saved = mutateCodememConfigFile(() => ({ saved: true }), configPath);
		const savedText = readFileSync(firstTarget, "utf8");
		unlinkSync(configPath);
		writeFileSync(secondTarget, savedText, "utf8");
		symlinkSync(secondTarget, configPath);

		mutateCodememConfigFile(() => ({ existing: true }), saved.mutationPath, {
			expectedMutationPath: saved.mutationPath,
			expectedRevision: saved.revision,
		});

		expect(readFileSync(firstTarget, "utf8")).toBe(
			`${JSON.stringify({ existing: true }, null, 2)}\n`,
		);
		expect(readFileSync(secondTarget, "utf8")).toBe(savedText);
	});

	it("rejects rollback after the saved target becomes a symlink", () => {
		const firstTarget = join(tmpHome, "swapped-first.json");
		const displacedTarget = join(tmpHome, "swapped-original.json");
		const secondTarget = join(tmpHome, "swapped-second.json");
		writeFileSync(firstTarget, '{"existing":true}\n', "utf8");
		const saved = mutateCodememConfigFile(() => ({ saved: true }), firstTarget);
		const savedText = readFileSync(firstTarget, "utf8");
		renameSync(firstTarget, displacedTarget);
		writeFileSync(secondTarget, savedText, "utf8");
		symlinkSync(secondTarget, firstTarget);

		expect(() =>
			mutateCodememConfigFile(() => ({ existing: true }), saved.mutationPath, {
				expectedMutationPath: saved.mutationPath,
				expectedRevision: saved.revision,
			}),
		).toThrow(expect.objectContaining({ code: "changed" }));
		expect(readFileSync(displacedTarget, "utf8")).toBe(savedText);
		expect(readFileSync(secondTarget, "utf8")).toBe(savedText);
	});
});
