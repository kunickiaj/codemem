#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

async function branchExists({ url, headers, ref, fetchImpl }) {
	const response = await fetchImpl(url, { headers });
	if (response.status === 404) return false;
	if (response.status !== 200) {
		throw new Error(`Cannot read maintenance branch: HTTP ${response.status}`);
	}
	const payload = await response.json();
	if (payload.ref !== ref || payload.object?.type !== "commit" || !payload.object.sha) {
		throw new Error("GitHub returned an unexpected maintenance branch reference.");
	}
	return true;
}

export async function ensureMaintenanceBranch({
	tag,
	repository,
	commit,
	token,
	fetchImpl = fetch,
}) {
	const match = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.0$/.exec(tag ?? "");
	if (!match) return { status: "skipped" };
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
		throw new Error("GITHUB_REPOSITORY must be owner/repository.");
	}
	if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
		throw new Error("The release tag must resolve to a full commit SHA.");
	}
	if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required.");
	const branch = `release/${match[1]}.${match[2]}`;
	const ref = `refs/heads/${branch}`;
	const base = `https://api.github.com/repos/${repository}/git`;
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2026-03-10",
	};
	const lookup = { url: `${base}/ref/heads/${branch}`, headers, ref, fetchImpl };
	if (await branchExists(lookup)) return { status: "existing", branch };
	const response = await fetchImpl(`${base}/refs`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({ ref, sha: commit }),
	});
	if (response.status === 201) return { status: "created", branch };
	// A concurrent run can create the branch after our GET. Never update it.
	if ((response.status === 409 || response.status === 422) && (await branchExists(lookup))) {
		return { status: "existing", branch };
	}
	throw new Error(`Cannot create maintenance branch: HTTP ${response.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const tag = process.env.RELEASE_TAG;
		// Resolve the checked-out commit, not GITHUB_SHA (which differs on dispatch).
		const commit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
		const result = await ensureMaintenanceBranch({
			tag,
			repository: process.env.GITHUB_REPOSITORY,
			commit,
			token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
		});
		console.log(`Maintenance branch ${result.status}${result.branch ? `: ${result.branch}` : ""}`);
	} catch (error) {
		console.error(`Maintenance branch provisioning failed: ${error.message}`);
		process.exitCode = 1;
	}
}
