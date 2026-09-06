import { pathToFileURL } from "node:url";

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

export function findCiGateFailures(needs, { eventName } = {}) {
	const jobResults = resultEntries(needs);
	if (jobResults.length === 0) return ["required-jobs=missing"];
	return jobResults
		.filter(([job, result]) => !isSuccessfulFullJob(job, result, eventName))
		.map(([job, result]) => `${job}=${result}`);
}

function main() {
	try {
		const needs = JSON.parse(process.env.CI_NEEDS);
		const failures = findCiGateFailures(needs, { eventName: process.env.CI_EVENT_NAME });
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
