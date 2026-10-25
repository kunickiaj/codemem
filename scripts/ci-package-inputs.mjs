import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const run = (root, command, args) =>
	execFileSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 32 * 1024 * 1024,
	});
const inside = (path) => path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
const under = (path, directory) => path === directory || path.startsWith(`${directory}/`);
const splitPaths = (output) => output.split("\0").filter(Boolean).sort();

function discoverPackages(root) {
	return JSON.parse(run(root, "pnpm", ["-r", "list", "--depth", "-1", "--json"]));
}

function packageDirectories(root, packages) {
	if (!Array.isArray(packages)) throw new Error("Invalid workspace discovery result");
	return packages
		.map((project) => {
			if (typeof project.path !== "string") throw new Error("Invalid workspace project path");
			const path = relative(root, realpathSync(resolve(root, project.path)));
			if (!inside(path)) throw new Error("Workspace project outside repository");
			return path.split(sep).join("/");
		})
		.filter(Boolean);
}

function readRecord(root, path) {
	const absolute = resolve(root, path);
	let stat;
	try {
		// Check ancestors before lstat: a replaced parent may itself point outside the checkout.
		if (!inside(relative(root, realpathSync(dirname(absolute))))) {
			throw new Error("Shared input ancestor outside repository");
		}
		stat = lstatSync(absolute);
	} catch (error) {
		if (error.code === "ENOENT") return { record: [path, "deleted"] };
		throw error;
	}
	const mode = stat.mode & 0o777;
	if (stat.isSymbolicLink()) {
		const target = readlinkSync(absolute);
		const destination = resolve(dirname(absolute), target);
		if (!inside(relative(root, destination))) throw new Error("Shared symlink outside repository");
		if (!inside(relative(root, realpathSync(destination)))) {
			throw new Error("Shared symlink resolves outside repository");
		}
		return {
			record: [path, "symlink", mode, target],
			target: relative(root, destination).split(sep).join("/"),
		};
	}
	if (!stat.isFile()) throw new Error("Unknown tracked shared input type");
	return { record: [path, "file", mode, hash(readFileSync(absolute))] };
}

function collectRecords(root, tracked, initial, untracked) {
	const pending = [...initial];
	const records = new Map();
	while (pending.length) {
		const path = pending.pop();
		if (records.has(path)) continue;
		const { record, target } = readRecord(root, path);
		records.set(path, record);
		if (target === undefined) continue;
		if (untracked.some((file) => !target || under(file, target))) {
			throw new Error("Untracked shared symlink target inputs");
		}
		const descendants = tracked.filter((file) => !target || under(file, target));
		if (!descendants.length) throw new Error("Shared symlink target has no tracked inputs");
		pending.push(...descendants);
	}
	return [...records.values()].sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
}

/** Synchronous; options.packages or options.listSource(root) supplies pnpm-shaped {path,name} projects.
 * Root documents conservatively invalidate every package. Package source stays in pnpm's native key.
 */
export function computeSharedInputs(root = process.cwd(), options = {}) {
	let files = [];
	try {
		root = realpathSync(root);
		const packages = options.packages ?? (options.listSource ?? discoverPackages)(root);
		const directories = packageDirectories(root, packages);
		const shared = (path) =>
			!directories.some((dir) => under(path, dir)) ||
			directories.some((dir) => path === `${dir}/package.json`);
		const tracked = splitPaths(run(root, "git", ["ls-files", "-z", "--cached"]));
		const untracked = splitPaths(
			run(root, "git", ["ls-files", "-z", "--others", "--exclude-standard"]),
		);
		files = tracked.filter(shared);
		if (untracked.some(shared)) throw new Error("Untracked shared inputs");
		const records = collectRecords(root, tracked, files, untracked);
		files = records.map(([path]) => path);
		return { digest: hash(JSON.stringify(records)), files, cacheable: true };
	} catch {
		// Do not expose command stderr or absolute paths in the public CLI result.
		return {
			digest: hash("uncertain-shared-inputs"),
			files,
			cacheable: false,
			reason: "Shared inputs could not be verified",
		};
	}
}

/** Runtime identity, not authentication. The CI caller must reject unknown runner image context. */
export function runtimeFingerprint(root, env = process.env) {
	return hash(
		JSON.stringify({
			node: process.version,
			pnpm: run(root, "pnpm", ["--version"]).trim(),
			platform: process.platform,
			arch: process.arch,
			abi: process.versions.modules,
			git: run(root, "git", ["--version"]).trim(),
			imageOS: env.CI ? (env.ImageOS ?? "unknown") : "local",
			imageVersion: env.CI ? (env.ImageVersion ?? "unknown") : "local",
			nodeOptions: env.NODE_OPTIONS ?? "",
			tz: env.TZ ?? "",
			lang: env.LANG ?? "",
		}),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const result = computeSharedInputs();
	try {
		process.stdout.write(
			`${JSON.stringify({ ...result, runtime: runtimeFingerprint(process.cwd()) })}\n`,
		);
	} catch {
		process.stdout.write(
			`${JSON.stringify({ ...result, cacheable: false, reason: "Runtime could not be verified", runtime: hash("unknown-runtime") })}\n`,
		);
	}
}
