import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseNotesForTag(changelog, tag) {
	const version = tag.replace(/^v/, "");
	if (version !== version.trim() || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version)) {
		throw new Error(`Invalid release tag: ${tag}`);
	}
	const lines = changelog.split(/\r?\n/);
	if (lines.filter((line) => line === `## ${version}`).length > 1) {
		throw new Error(`Duplicate changelog entry: ${version}`);
	}
	const start = lines.findIndex((line) => line === `## ${version}`);
	if (start < 0) return "";
	const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	return lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const tag = process.argv[2];
		if (!tag || process.argv.length !== 3) throw new Error("Usage: release-notes.mjs <release-tag>");
		const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
		const notes = releaseNotesForTag(changelog, tag);
		if (notes) process.stdout.write(`${notes}\n`);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}
