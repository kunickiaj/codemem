import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function npmDistTagForReleaseTag(releaseTag) {
	if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.+-]+)?$/.test(releaseTag)) {
		throw new Error(`Invalid release tag: ${releaseTag}`);
	}
	const prereleaseChannel = /^v\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(releaseTag)?.[1];
	if (!prereleaseChannel) return "latest";
	if (["alpha", "beta", "rc"].includes(prereleaseChannel)) return prereleaseChannel;
	throw new Error(`Unsupported release channel: ${prereleaseChannel}`);
}

if (
	process.argv[1] &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
	try {
		process.stdout.write(`tag=${npmDistTagForReleaseTag(process.argv[2] ?? "")}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "Invalid release tag"}\n`);
		process.exitCode = 1;
	}
}
