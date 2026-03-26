import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "codemem-opencode-plugin-packed-"));

function fail(message, result) {
	if (result) {
		if (result.stdout) process.stderr.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
	}
	throw new Error(message);
}

function run(command, args, cwd = packageRoot) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: process.env,
	});
	if (result.status !== 0) fail(`Command failed: ${command} ${args.join(" ")}`, result);
	return result;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

try {
	const packedTarball = run("pnpm", ["pack", "--pack-destination", tempDir]).stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);

	assert(Boolean(packedTarball), "pnpm pack did not report a tarball path");
	assert(existsSync(packedTarball), `Packed tarball not found: ${packedTarball}`);

	const tarListing = run("tar", ["-tf", packedTarball]).stdout;
	assert(tarListing.includes("package/index.js"), "Packed artifact is missing index.js");
	assert(
		tarListing.includes("package/.opencode/plugins/codemem.js"),
		"Packed artifact is missing .opencode/plugins/codemem.js",
	);
	assert(
		tarListing.includes("package/.opencode/lib/compat.js"),
		"Packed artifact is missing .opencode/lib/compat.js",
	);
	assert(
		tarListing.includes("package/.opencode/package.json"),
		"Packed artifact is missing .opencode/package.json",
	);

	const installDir = join(tempDir, "install");
	run("npm", ["install", "--prefix", installDir, packedTarball]);

	const installedPackageRoot = join(installDir, "node_modules", "@codemem", "opencode-plugin");
	assert(existsSync(installedPackageRoot), "Installed artifact is missing @codemem/opencode-plugin");
	assert(existsSync(join(installedPackageRoot, "index.js")), "Installed artifact is missing index.js");
	assert(
		existsSync(join(installedPackageRoot, ".opencode", "plugins", "codemem.js")),
		"Installed artifact is missing .opencode/plugins/codemem.js",
	);

	const packageJson = JSON.parse(readFileSync(join(installedPackageRoot, "package.json"), "utf8"));
	assert(packageJson.name === "@codemem/opencode-plugin", "Installed package name mismatch");

	run(process.execPath, [
		"--input-type=module",
		"-e",
		"const mod = await import('@codemem/opencode-plugin'); if (typeof mod.default !== 'function') throw new Error('default export is not a function'); if (typeof mod.OpencodeMemPlugin !== 'function') throw new Error('named export is not a function');",
	], installDir);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
