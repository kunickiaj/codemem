import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = process.cwd();
const workspaceRoot = resolve(packageRoot, "..", "..");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const packageVersion = String(packageJson.version);
const tempDir = mkdtempSync(join(tmpdir(), "codemem-packed-artifact-"));

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
	if (result.status !== 0) {
		fail(`Command failed: ${command} ${args.join(" ")}`, result);
	}
	return result;
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

try {
	const coreTarball = run("pnpm", ["pack", "--pack-destination", tempDir], resolve(workspaceRoot, "packages/core"))
		.stdout.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	const mcpTarball = run("pnpm", ["pack", "--pack-destination", tempDir], resolve(workspaceRoot, "packages/mcp-server"))
		.stdout.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	const serverTarball = run("pnpm", ["pack", "--pack-destination", tempDir], resolve(workspaceRoot, "packages/viewer-server"))
		.stdout.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	const packResult = run("pnpm", ["pack", "--pack-destination", tempDir]);
	const packedTarball = packResult.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);

	assert(Boolean(coreTarball), "pnpm pack did not report a core tarball path");
	assert(Boolean(mcpTarball), "pnpm pack did not report an mcp tarball path");
	assert(Boolean(serverTarball), "pnpm pack did not report a server tarball path");
	assert(Boolean(packedTarball), "pnpm pack did not report a tarball path");
	assert(existsSync(coreTarball), `Packed core tarball not found: ${coreTarball}`);
	assert(existsSync(mcpTarball), `Packed mcp tarball not found: ${mcpTarball}`);
	assert(existsSync(serverTarball), `Packed server tarball not found: ${serverTarball}`);
	assert(existsSync(packedTarball), `Packed tarball not found: ${packedTarball}`);

	const tarListing = run("tar", ["-tf", packedTarball]).stdout;
	assert(tarListing.includes("package/dist/index.js"), "Packed artifact is missing dist/index.js");
	assert(tarListing.includes("package/README.md"), "Packed artifact is missing README.md");

	const installDir = join(tempDir, "install");
	run("npm", ["install", "--prefix", installDir, coreTarball, mcpTarball, serverTarball, packedTarball]);

	const installedPackageRoot = join(installDir, "node_modules", "codemem");
	const cliBin = join(installDir, "node_modules", ".bin", process.platform === "win32" ? "codemem.cmd" : "codemem");

	assert(existsSync(cliBin), "Installed artifact is missing the codemem binary");
	assert(existsSync(join(installedPackageRoot, "dist", "index.js")), "Installed artifact is missing dist/index.js");
	assert(
		existsSync(join(installedPackageRoot, "README.md")),
		"Installed artifact is missing README.md",
	);

	const helpOutput = run(cliBin, ["--help"]).stdout;
	assert(helpOutput.includes("persistent memory for AI coding agents"), "Installed CLI help output is missing expected text");

	const versionOutput = run(cliBin, ["version"]).stdout.trim();
	assert(versionOutput === packageVersion, `Installed CLI reported ${versionOutput}, expected ${packageVersion}`);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
