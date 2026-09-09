import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "codemem-opencode-plugin-packed-"));

function fail(message, result) {
	if (result) {
		if (result.stdout) process.stderr.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		if (result.error) process.stderr.write(`${result.error.stack ?? result.error.message}\n`);
	}
	throw new Error(message);
}

function run(command, args, cwd = packageRoot, env = process.env) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env,
	});
	if (result.status !== 0) fail(`Command failed: ${command} ${args.join(" ")}`, result);
	return result;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function stopHost(child) {
	if (child.exitCode !== null) return;
	const closed = once(child, "close");
	child.kill();
	const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
	try {
		await closed;
	} finally {
		clearTimeout(forceKill);
	}
}

async function exerciseV1Host(opencode, cwd, env, activationLog) {
	const child = spawn(opencode, ["serve", "--hostname", "127.0.0.1"], { cwd, env });
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});

	try {
		let baseURL;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (child.exitCode !== null) break;
			baseURL = output.match(/server listening on (http:\/\/\S+)/)?.[1];
			if (baseURL) break;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
		}
		if (!baseURL) return { activated: false, output };

		const probePaths = [
			"/global/health",
			"/config",
			"/provider",
			"/session",
			"/experimental/tool/ids",
		];
		const authorization = `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
		for (const path of probePaths) {
			try {
				await fetch(`${baseURL}${path}`, { headers: { Authorization: authorization } });
			} catch {
				// Continue probing until the server has initialized the plugin runtime.
			}
			if (existsSync(activationLog)) break;
		}
		const activationDeadline = Date.now() + 15_000;
		while (!existsSync(activationLog) && Date.now() < activationDeadline) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
		}
		return { activated: existsSync(activationLog), output };
	} finally {
		await stopHost(child);
	}
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
	assert(tarListing.includes("package/index.d.ts"), "Packed artifact is missing index.d.ts");
	assert(
		tarListing.includes("package/.opencode/plugins/codemem.js"),
		"Packed artifact is missing .opencode/plugins/codemem.js",
	);
	assert(
		tarListing.includes("package/.opencode/lib/runtime.js"),
		"Packed artifact is missing .opencode/lib/runtime.js",
	);
	assert(
		tarListing.includes("package/.opencode/lib/host-contract.js"),
		"Packed artifact is missing .opencode/lib/host-contract.js",
	);
	assert(
		tarListing.includes("package/.opencode/lib/compat.js"),
		"Packed artifact is missing .opencode/lib/compat.js",
	);
	assert(
		tarListing.includes("package/.opencode/lib/raw-event-spool.js"),
		"Packed artifact is missing .opencode/lib/raw-event-spool.js",
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
		existsSync(join(installedPackageRoot, "index.d.ts")),
		"Installed artifact is missing index.d.ts",
	);
	assert(
		existsSync(join(installedPackageRoot, ".opencode", "plugins", "codemem.js")),
		"Installed artifact is missing .opencode/plugins/codemem.js",
	);
	assert(
		existsSync(join(installedPackageRoot, ".opencode", "lib", "runtime.js")),
		"Installed artifact is missing .opencode/lib/runtime.js",
	);
	assert(
		existsSync(join(installedPackageRoot, ".opencode", "lib", "host-contract.js")),
		"Installed artifact is missing .opencode/lib/host-contract.js",
	);
	assert(
		existsSync(join(installedPackageRoot, ".opencode", "lib", "raw-event-spool.js")),
		"Installed artifact is missing .opencode/lib/raw-event-spool.js",
	);

	const packageJson = JSON.parse(readFileSync(join(installedPackageRoot, "package.json"), "utf8"));
	assert(packageJson.name === "@codemem/opencode-plugin", "Installed package name mismatch");
	assert(packageJson.types === "./index.d.ts", "Installed package is missing its type entrypoint");
	run("npm", ["install", "--prefix", installDir, "--save-dev", "@types/node@24"]);
	const typeConsumer = join(installDir, "consumer.ts");
	writeFileSync(
		typeConsumer,
		'import plugin from "@codemem/opencode-plugin";\nplugin.setup({ directory: "/tmp" });\nvoid plugin.server;\n',
	);
	run("pnpm", [
		"exec",
		"tsc",
		"--ignoreConfig",
		"--noEmit",
		"--strict",
		"--module",
		"NodeNext",
		"--moduleResolution",
		"NodeNext",
		"--target",
		"ES2022",
		"--types",
		"node",
		typeConsumer,
	]);

	run(process.execPath, [
		"--input-type=module",
		"-e",
		"const mod = await import('@codemem/opencode-plugin'); if (!mod.default || typeof mod.default !== 'object') throw new Error('default export is not an object'); if (mod.default.id !== 'codemem') throw new Error('default export has the wrong id'); if (typeof mod.default.server !== 'function') throw new Error('default server is not a function'); if (typeof mod.default.setup !== 'function') throw new Error('default setup is not a function'); if (typeof mod.CodememPlugin !== 'function') throw new Error('canonical named V1 export is not a function'); if (mod.default.server !== mod.CodememPlugin) throw new Error('default server is not the canonical V1 export'); if (mod.OpencodeMemPlugin !== mod.CodememPlugin) throw new Error('legacy V1 export is not a compatibility alias'); const result = await mod.default.setup({}); if (result !== undefined) throw new Error('V2 setup shell has behavior');",
	], installDir);

	const pinnedOpenCodeV1Version = "1.18.30";
	run("npm", ["install", "--prefix", installDir, `opencode-ai@${pinnedOpenCodeV1Version}`]);
	run(
		process.execPath,
		[join(installDir, "node_modules", "opencode-ai", "postinstall.mjs")],
		join(installDir, "node_modules", "opencode-ai"),
	);
	const v1ConfigPath = join(installDir, "opencode.json");
	const installedEntrypoint = pathToFileURL(join(installedPackageRoot, "index.js")).href;
	writeFileSync(v1ConfigPath, `${JSON.stringify({ plugin: [installedEntrypoint] }, null, 2)}\n`);
	const v1Home = join(tempDir, "v1-home");
	const v1ActivationLog = join(tempDir, "v1-activation.log");
	mkdirSync(v1Home, { recursive: true });
	const opencodeV1 = join(installDir, "node_modules", ".bin", "opencode");
	const v1Env = {
		...process.env,
		HOME: v1Home,
		XDG_CONFIG_HOME: join(v1Home, ".config"),
		CODEMEM_VIEWER: "0",
		CODEMEM_RAW_EVENTS: "0",
		CODEMEM_PLUGIN_LOG: v1ActivationLog,
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("base64url"),
	};
	const v1Version = run(opencodeV1, ["--version"], installDir, v1Env).stdout.trim();
	assert(v1Version === pinnedOpenCodeV1Version, `Unexpected OpenCode 1 host version: ${v1Version}`);
	const v1Host = await exerciseV1Host(opencodeV1, installDir, v1Env, v1ActivationLog);
	assert(
		v1Host.activated &&
			readFileSync(v1ActivationLog, "utf8").includes("plugin initialized"),
		`Pinned OpenCode 1 host did not invoke server() on the installed dual plugin\n${v1Host.output}`,
	);

	const brokenPluginRoot = join(tempDir, "broken-plugin");
	cpSync(installedPackageRoot, brokenPluginRoot, { recursive: true });
	writeFileSync(join(brokenPluginRoot, "index.js"), 'throw new Error("SABOTAGE_PLUGIN_LOAD");\n');
	writeFileSync(
		v1ConfigPath,
		`${JSON.stringify({ plugin: [pathToFileURL(join(brokenPluginRoot, "index.js")).href] }, null, 2)}\n`,
	);
	const brokenActivationLog = join(tempDir, "broken-v1-activation.log");
	const brokenHost = await exerciseV1Host(
		opencodeV1,
		installDir,
		{ ...v1Env, CODEMEM_PLUGIN_LOG: brokenActivationLog },
		brokenActivationLog,
	);
	assert(
		!brokenHost.activated && !existsSync(brokenActivationLog),
		"OpenCode 1 activation check did not reject a sabotaged plugin entrypoint",
	);

	const checkoutPluginUrl = pathToFileURL(join(packageRoot, ".opencode", "plugins", "codemem.js")).href;
	const duplicateHome = join(tempDir, "duplicate-home");
	mkdirSync(duplicateHome, { recursive: true });
	const duplicateEnv = {
		PATH: process.env.PATH ?? "",
		HOME: duplicateHome,
		XDG_CONFIG_HOME: join(duplicateHome, ".config"),
		CODEMEM_VIEWER: "0",
		CODEMEM_RAW_EVENTS: "0",
	};
	for (const name of ["TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) duplicateEnv[name] = process.env[name];
	}
	run(process.execPath, [
		"--input-type=module",
		"-e",
		"const checkoutPluginUrl = process.argv[1]; const installed = await import('@codemem/opencode-plugin'); const checkout = await import(checkoutPluginUrl); const firstLogs = []; const secondLogs = []; const context = { project: { name: 'packed-duplicate' }, directory: process.cwd(), worktree: process.cwd() }; const first = await installed.default.server({ ...context, client: { app: { log: async ({ body }) => firstLogs.push(body) }, tui: {} } }); const second = await checkout.default({ ...context, client: { app: { log: async ({ body }) => secondLogs.push(body) }, tui: {} } }); if (typeof first.event !== 'function') throw new Error('configured installed plugin did not activate'); if (Object.keys(second).length !== 0) throw new Error('checkout-local duplicate activated hooks'); if (!secondLogs.some((entry) => entry?.message === 'codemem duplicate plugin registration skipped')) throw new Error('checkout-local duplicate did not report the skip'); await first.dispose?.();",
		checkoutPluginUrl,
	], installDir, duplicateEnv);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
