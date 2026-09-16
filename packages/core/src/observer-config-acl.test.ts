import { execFileSync } from "node:child_process";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicReplaceConfigFile, mutateCodememConfigFile } from "./observer-config.js";

function commandExists(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("config replacement extended access metadata", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-acl-"));
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("leaves the original untouched when extended metadata cannot be copied", () => {
		const configPath = join(tmpHome, "copy-failure.json");
		writeFileSync(configPath, '{"existing":true}\n', "utf8");

		expect(() =>
			atomicReplaceConfigFile(
				configPath,
				'{"replacement":true}\n',
				{ mode: 0o640, uid: 501, gid: 20 },
				{
					open: openSync,
					close: closeSync,
					chmod: fchmodSync,
					sync: fsyncSync,
					write: writeSync,
					rename: renameSync,
					unlink: unlinkSync,
					seedMetadata: (_sourcePath, destinationFd) => {
						expect(destinationFd).toEqual(expect.any(Number));
						expect(readdirSync(tmpHome)).toHaveLength(2);
						throw new Error("injected metadata copy failure");
					},
				},
			),
		).toThrow("injected metadata copy failure");
		expect(readFileSync(configPath, "utf8")).toBe('{"existing":true}\n');
		expect(readdirSync(tmpHome)).toEqual(["copy-failure.json"]);
	});

	it.skipIf(process.platform !== "darwin")(
		"preserves a macOS named ACL during config mutation",
		() => {
			const configPath = join(tmpHome, "darwin-acl.json");
			writeFileSync(configPath, '{"existing":"content that must be truncated"}\n', "utf8");
			const aclEntry = `${userInfo().username} allow read`;
			execFileSync("/bin/chmod", ["+a", aclEntry, configPath]);

			mutateCodememConfigFile(() => ({ updated: true }), configPath);

			const metadata = execFileSync("/bin/ls", ["-lde", configPath], {
				encoding: "utf8",
			});
			expect(metadata).toContain(`user:${aclEntry}`);
			expect(readFileSync(configPath, "utf8")).toBe('{\n  "updated": true\n}\n');
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"rejects a concurrent named ACL change before replacing the config",
		() => {
			const configPath = join(tmpHome, "darwin-acl-race.json");
			const original = '{"existing":true}\n';
			writeFileSync(configPath, original, "utf8");
			const aclEntry = `${userInfo().username} allow read`;

			expect(() =>
				mutateCodememConfigFile(() => {
					execFileSync("/bin/chmod", ["+a", aclEntry, configPath]);
					return { updated: true };
				}, configPath),
			).toThrow("changed during the save");
			expect(readFileSync(configPath, "utf8")).toBe(original);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"clears copied immutable flags so a failed replacement can clean its temp file",
		() => {
			const configPath = join(tmpHome, "darwin-flags.json");
			writeFileSync(configPath, '{"existing":true}\n', "utf8");
			execFileSync("/usr/bin/chflags", ["uchg", configPath]);

			try {
				expect(() => mutateCodememConfigFile(() => ({ updated: true }), configPath)).toThrow();
			} finally {
				execFileSync("/usr/bin/chflags", ["nouchg", configPath]);
			}
			expect(readdirSync(tmpHome)).toEqual(["darwin-flags.json"]);
		},
	);

	it.skipIf(
		process.platform !== "linux" ||
			!commandExists("/bin/cp") ||
			!commandExists("getfacl") ||
			!commandExists("setfacl"),
	)("preserves a Linux named ACL during config mutation", () => {
		const configPath = join(tmpHome, "linux-acl.json");
		writeFileSync(configPath, '{"existing":"content that must be truncated"}\n', "utf8");
		const namedUser = userInfo().username;
		execFileSync("setfacl", ["-m", `u:${namedUser}:r`, configPath]);

		mutateCodememConfigFile(() => ({ updated: true }), configPath);

		const metadata = execFileSync("getfacl", ["--omit-header", configPath], {
			encoding: "utf8",
		});
		expect(metadata).toContain(`user:${namedUser}:r--`);
		expect(readFileSync(configPath, "utf8")).toBe('{\n  "updated": true\n}\n');
	});
});
