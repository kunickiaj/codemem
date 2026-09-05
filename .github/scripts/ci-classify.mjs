import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classifyCi } from "../../scripts/ci-stack-topology.mjs";

const FILES_PAGE_LIMIT = 30;
const PULLS_PAGE_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 10_000;

function normalizePullRequest(pullRequest) {
	const labels = pullRequest?.labels;
	const normalizedLabels = Array.isArray(labels) ? labels.map((label) => label?.name) : null;
	return {
		number: pullRequest?.number,
		baseRef: pullRequest?.base?.ref,
		headRef: pullRequest?.head?.ref,
		baseRepo: pullRequest?.base?.repo?.full_name,
		headRepo: pullRequest?.head?.repo?.full_name,
		labels: normalizedLabels,
	};
}

function changedFilePaths(files) {
	return files.flatMap((file) => {
		const paths = [file?.filename];
		if (typeof file?.previous_filename === "string") paths.push(file.previous_filename);
		return paths;
	});
}

async function fetchPage({ fetchImpl, url, token, requestTimeoutMs }) {
	const response = await fetchImpl(url, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: AbortSignal.timeout(requestTimeoutMs),
	});
	if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
	const body = await response.json();
	if (!Array.isArray(body)) throw new Error("GitHub API returned a non-array response");
	return body;
}

async function fetchAllPages({ fetchImpl, url, token, pageLimit, requestTimeoutMs }) {
	const items = [];
	for (let page = 1; page <= pageLimit; page += 1) {
		const separator = url.includes("?") ? "&" : "?";
		const pageItems = await fetchPage({
			fetchImpl,
			url: `${url}${separator}per_page=100&page=${page}`,
			token,
			requestTimeoutMs,
		});
		items.push(...pageItems);
		if (pageItems.length < 100) return items;
	}
	throw new Error(`GitHub API pagination reached the ${pageLimit}-page limit`);
}

function failOpen(reason = "metadata-error") {
	return { runFull: true, docsOnly: false, topology: "unknown", reason };
}

export async function classifyGitHubEvent({
	event,
	repository,
	apiUrl,
	token,
	fetchImpl = fetch,
	requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
	const eventName = event?.eventName;
	if (eventName !== "pull_request") return classifyCi({ eventName });
	if (!repository || !apiUrl || !token || !event.pullRequest?.number) return failOpen();

	try {
		const pullsUrl = `${apiUrl}/repos/${repository}/pulls?state=open&sort=created&direction=asc`;
		const filesUrl = `${apiUrl}/repos/${repository}/pulls/${event.pullRequest.number}/files`;
		const [openPullRequests, files] = await Promise.all([
			fetchAllPages({
				fetchImpl,
				url: pullsUrl,
				token,
				pageLimit: PULLS_PAGE_LIMIT,
				requestTimeoutMs,
			}),
			fetchAllPages({
				fetchImpl,
				url: filesUrl,
				token,
				pageLimit: FILES_PAGE_LIMIT,
				requestTimeoutMs,
			}),
		]);
		return classifyCi({
			eventName,
			pullRequest: normalizePullRequest(event.pullRequest),
			openPullRequests: openPullRequests.map(normalizePullRequest),
			changedFiles: changedFilePaths(files),
			defaultBranch: event.pullRequest?.base?.repo?.default_branch,
		});
	} catch {
		return failOpen();
	}
}

export function formatGitHubOutputs(result) {
	return [`run_full=${String(result.runFull)}`, `reason=${result.reason}`].join("\n");
}

async function main() {
	let result = failOpen();
	try {
		const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
		result = await classifyGitHubEvent({
			event: { eventName: process.env.GITHUB_EVENT_NAME, pullRequest: event.pull_request },
			repository: process.env.GITHUB_REPOSITORY,
			apiUrl: process.env.GITHUB_API_URL,
			token: process.env.GITHUB_TOKEN,
		});
	} catch {
		result = failOpen();
	}

	const outputs = `${formatGitHubOutputs(result)}\n`;
	if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, outputs);
	process.stdout.write(outputs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
