import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const supportsGitStableTags = true;

function stableVersion(tag) {
	const match = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(tag);
	return match?.slice(1).map((part) => BigInt(part));
}

function isHigherVersion(candidate, current) {
	for (let index = 0; index < current.length; index += 1) {
		if (candidate[index] !== current[index]) return candidate[index] > current[index];
	}
	return false;
}

export function npmDistTagForReleaseTag(releaseTag, { stableTags = [] } = {}) {
	if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.+-]+)?$/.test(releaseTag)) {
		throw new Error(`Invalid release tag: ${releaseTag}`);
	}
	const prereleaseChannel = /^v\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(releaseTag)?.[1];
	if (!prereleaseChannel) {
		const current = stableVersion(releaseTag);
		if (!current) throw new Error(`Invalid stable release tag: ${releaseTag}`);
		const hasNewerStable = stableTags.some((tag) => {
			const candidate = stableVersion(tag);
			return candidate && isHigherVersion(candidate, current);
		});
		if (hasNewerStable) return `maintenance-${current[0]}.${current[1]}`;
		return "latest";
	}
	if (["alpha", "beta", "rc"].includes(prereleaseChannel)) return prereleaseChannel;
	throw new Error(`Unsupported release channel: ${prereleaseChannel}`);
}

if (
	process.argv[1] &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
	try {
		let stableTags = [];
		if (process.argv.includes("--from-git")) {
			stableTags = execFileSync("git", ["tag", "--list"], { encoding: "utf8" })
				.trim()
				.split(/\r?\n/);
		}
		process.stdout.write(`tag=${npmDistTagForReleaseTag(process.argv[2] ?? "", { stableTags })}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "Invalid release tag"}\n`);
		process.exitCode = 1;
	}
}
