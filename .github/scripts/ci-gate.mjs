import { pathToFileURL } from "node:url";

const REDUCED_REASONS = new Set(["docs-only", "stacked-pr"]);
const PULL_REQUEST_FULL_SKIP_JOBS = new Set(["windows-embedding-runtime-smoke"]);

function resultEntries(needs) {
	if (!needs || typeof needs !== "object" || Array.isArray(needs)) return [];
	return Object.entries(needs).map(([job, details]) => [job, details?.result ?? "missing"]);
}

function isSuccessfulFullJob(job, result, eventName) {
	if (result === "success") return true;
	return (
		eventName === "pull_request" && result === "skipped" && PULL_REQUEST_FULL_SKIP_JOBS.has(job)
	);
}

function findAuthorizationFailures(classify, { eventName, baseRef, defaultBranch }) {
	if (!classify || eventName !== "pull_request") return [];
	if (!baseRef || !defaultBranch) return ["authorization=target-unknown"];
	return baseRef === defaultBranch ? [] : ["authorization=stacked-pr"];
}

export function findCiGateFailures(needs, { eventName, baseRef, defaultBranch } = {}) {
	const classify = needs?.classify;
	const jobResults = resultEntries(needs).filter(([job]) => job !== "classify");
	if (jobResults.length === 0) return ["required-jobs=missing"];
	const authorizationFailures = findAuthorizationFailures(classify, {
		eventName,
		baseRef,
		defaultBranch,
	});
	if (classify?.result !== "success") {
		const jobFailures = jobResults
			.filter(([job, result]) => !isSuccessfulFullJob(job, result, eventName))
			.map(([job, result]) => `${job}=${result}`);
		return [...authorizationFailures, ...jobFailures];
	}

	const runFull = classify.outputs?.run_full;
	const reason = classify.outputs?.reason;
	if (runFull === "true") {
		const jobFailures = jobResults
			.filter(([job, result]) => !isSuccessfulFullJob(job, result, eventName))
			.map(([job, result]) => `${job}=${result}`);
		return [...authorizationFailures, ...jobFailures];
	}

	if (runFull !== "false" || !REDUCED_REASONS.has(reason)) {
		return [`classification=run_full:${runFull || "missing"},reason:${reason || "missing"}`];
	}

	const unexpectedJobs = jobResults
		.filter(([, result]) => result !== "skipped")
		.map(([job, result]) => `${job}=${result}`);
	return [...authorizationFailures, ...unexpectedJobs];
}

function main() {
	try {
		const needs = JSON.parse(process.env.CI_NEEDS);
		const failures = findCiGateFailures(needs, {
			eventName: process.env.CI_EVENT_NAME,
			baseRef: process.env.CI_BASE_REF,
			defaultBranch: process.env.CI_DEFAULT_BRANCH,
		});
		if (failures.length === 0) return;

		console.error(`Required CI jobs did not complete as expected: ${failures.join(", ")}`);
		process.exitCode = 1;
	} catch (error) {
		console.error(`Could not validate required CI jobs: ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
