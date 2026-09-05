const DOCS_PATH_PREFIXES = ["docs/"];

function fullResult(topology, reason, docsOnly = false) {
	return { runFull: true, docsOnly, topology, reason };
}

function reducedResult(topology, reason, docsOnly = false) {
	return { runFull: false, docsOnly, topology, reason };
}

function isValidPullRequest(pullRequest) {
	return (
		Number.isInteger(pullRequest?.number) &&
		pullRequest.number > 0 &&
		typeof pullRequest.baseRef === "string" &&
		pullRequest.baseRef.length > 0 &&
		typeof pullRequest.headRef === "string" &&
		pullRequest.headRef.length > 0 &&
		typeof pullRequest.baseRepo === "string" &&
		pullRequest.baseRepo.length > 0 &&
		typeof pullRequest.headRepo === "string" &&
		pullRequest.headRepo.length > 0 &&
		Array.isArray(pullRequest.labels) &&
		pullRequest.labels.every((label) => typeof label === "string")
	);
}

export function isDocsOnly(changedFiles) {
	if (!isValidChangedFiles(changedFiles)) return false;

	return changedFiles.every((file) => {
		if (file === "LICENSE") return true;
		if (file.endsWith(".md")) return true;
		return DOCS_PATH_PREFIXES.some((prefix) => file.startsWith(prefix));
	});
}

function isValidChangedFiles(changedFiles) {
	return (
		Array.isArray(changedFiles) &&
		changedFiles.length > 0 &&
		changedFiles.every((file) => typeof file === "string" && file.length > 0)
	);
}

function findRelations(current, openPullRequests) {
	const peers = openPullRequests.filter((pullRequest) => pullRequest.number !== current.number);
	const parents = peers.filter(
		(pullRequest) =>
			pullRequest.headRef === current.baseRef &&
			pullRequest.headRepo === current.baseRepo &&
			pullRequest.baseRepo === current.baseRepo,
	);
	const children = peers.filter(
		(pullRequest) =>
			pullRequest.baseRef === current.headRef &&
			pullRequest.baseRepo === current.headRepo &&
			pullRequest.headRepo === current.headRepo,
	);
	return { parents, children };
}

export function classifyPullRequestTopology({
	pullRequest,
	openPullRequests,
	defaultBranch = "main",
}) {
	if (!isValidPullRequest(pullRequest)) return "unknown";
	if (!Array.isArray(openPullRequests) || !openPullRequests.every(isValidPullRequest))
		return "unknown";
	if (pullRequest.baseRepo !== pullRequest.headRepo) return "unknown";

	const currentMatches = openPullRequests.filter(
		(candidate) =>
			candidate.number === pullRequest.number &&
			candidate.baseRef === pullRequest.baseRef &&
			candidate.headRef === pullRequest.headRef,
	);
	if (currentMatches.length !== 1) return "unknown";

	const { parents, children } = findRelations(pullRequest, openPullRequests);
	if (children.length > 1) return "unknown";

	if (pullRequest.baseRef === defaultBranch) {
		return children.length === 0 ? "standalone" : "bottom";
	}
	if (parents.length !== 1) return "unknown";
	return children.length === 0 ? "tip" : "middle";
}

export function classifyCi({
	eventName,
	pullRequest,
	openPullRequests,
	changedFiles,
	defaultBranch = "main",
}) {
	if (eventName !== "pull_request")
		return fullResult("not-applicable", eventName || "unknown-event");

	if (!isValidChangedFiles(changedFiles)) return fullResult("unknown", "invalid-changed-files");
	const docsOnly = isDocsOnly(changedFiles);
	const topology = classifyPullRequestTopology({ pullRequest, openPullRequests, defaultBranch });
	if (topology === "unknown") return fullResult(topology, "unknown-topology", docsOnly);
	if (pullRequest.labels.includes("ci:full")) return fullResult(topology, "ci:full", docsOnly);
	if (pullRequest.baseRef !== defaultBranch) return reducedResult(topology, "stacked-pr", docsOnly);
	if (docsOnly) return reducedResult(topology, "docs-only", true);
	return fullResult(topology, topology);
}
