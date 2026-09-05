import assert from "node:assert/strict";
import test from "node:test";
import { classifyGitHubEvent, formatGitHubOutputs } from "./ci-classify.mjs";

const REPOSITORY = "codemem/codemem";

function apiPull(number, baseRef, headRef, labels = []) {
	const repo = { full_name: REPOSITORY, default_branch: "main" };
	return {
		number,
		base: { ref: baseRef, repo },
		head: { ref: headRef, repo },
		labels: labels.map((name) => ({ name })),
	};
}

function event(pullRequest) {
	return { eventName: "pull_request", pullRequest };
}

function mockFetch({ pulls, files, status = 200 }) {
	return async (url) => ({
		ok: status >= 200 && status < 300,
		status,
		async json() {
			if (url.includes("/files?")) return files;
			return pulls;
		},
	});
}

async function classify(pullRequest, fetchImpl) {
	return classifyGitHubEvent({
		event: event(pullRequest),
		repository: REPOSITORY,
		apiUrl: "https://api.github.test",
		token: "test-token",
		fetchImpl,
	});
}

test("classifies GitHub-native pull and file metadata", async () => {
	const pulls = [apiPull(1, "main", "one"), apiPull(2, "one", "two"), apiPull(3, "two", "three")];
	const result = await classify(
		pulls[1],
		mockFetch({ pulls, files: [{ filename: "packages/core/src/index.ts" }] }),
	);
	assert.deepEqual(result, {
		runFull: false,
		docsOnly: false,
		topology: "middle",
		reason: "stacked-pr",
	});
});

test("includes the previous path when classifying renamed files", async () => {
	const current = apiPull(1, "main", "one");
	const result = await classify(
		current,
		mockFetch({
			pulls: [current],
			files: [
				{
					filename: "docs/foo.md",
					previous_filename: "packages/core/src/foo.ts",
					status: "renamed",
				},
			],
		}),
	);
	assert.equal(result.runFull, true);
	assert.equal(result.docsOnly, false);
	assert.equal(result.reason, "standalone");
});

test("keeps documentation-only renames on reduced CI", async () => {
	const current = apiPull(1, "main", "one");
	const result = await classify(
		current,
		mockFetch({
			pulls: [current],
			files: [{ filename: "docs/new.md", previous_filename: "docs/old.md", status: "renamed" }],
		}),
	);
	assert.equal(result.runFull, false);
	assert.equal(result.docsOnly, true);
	assert.equal(result.reason, "docs-only");
});

test("honors the ci:full label from event metadata", async () => {
	const pulls = [
		apiPull(1, "main", "one"),
		apiPull(2, "one", "two", ["ci:full"]),
		apiPull(3, "two", "three"),
	];
	const result = await classify(pulls[1], mockFetch({ pulls, files: [{ filename: "README.md" }] }));
	assert.equal(result.reason, "ci:full");
});

test("fails open when required environment metadata is absent", async () => {
	const result = await classifyGitHubEvent({ event: event(apiPull(1, "main", "one")) });
	assert.equal(result.runFull, true);
});

test("runs full CI for non-pull-request events", async () => {
	const result = await classifyGitHubEvent({ event: { eventName: "push" } });
	assert.equal(result.runFull, true);
	assert.equal(result.reason, "push");
});

test("fails open for pull requests from forks", async () => {
	const current = apiPull(1, "main", "feature");
	current.head.repo = { full_name: "contributor/codemem", default_branch: "main" };
	const result = await classify(
		current,
		mockFetch({ pulls: [current], files: [{ filename: "README.md" }] }),
	);
	assert.equal(result.runFull, true);
	assert.equal(result.reason, "unknown-topology");
});

test("fails open on API errors", async () => {
	const current = apiPull(1, "main", "one");
	const result = await classify(current, mockFetch({ status: 500 }));
	assert.deepEqual(result, {
		runFull: true,
		docsOnly: false,
		topology: "unknown",
		reason: "metadata-error",
	});
});

test("fails open on malformed API responses", async () => {
	const current = apiPull(1, "main", "one");
	const result = await classify(current, async () => ({
		ok: true,
		status: 200,
		json: async () => ({}),
	}));
	assert.equal(result.runFull, true);
});

test("fails open when changed files reach GitHub's 3000-file pagination cap", async () => {
	const current = apiPull(1, "main", "one");
	let filePageRequests = 0;
	const fetchImpl = async (url) => {
		if (url.includes("/files?")) {
			filePageRequests += 1;
			return {
				ok: true,
				status: 200,
				json: async () =>
					Array.from({ length: 100 }, (_, index) => ({ filename: `docs/${index}.md` })),
			};
		}
		return { ok: true, status: 200, json: async () => [current] };
	};

	const result = await classify(current, fetchImpl);
	assert.equal(result.runFull, true);
	assert.equal(result.reason, "metadata-error");
	assert.equal(filePageRequests, 30);
});

test("fails open when open pull-request pagination reaches its cap", async () => {
	const current = apiPull(1, "main", "one");
	let pullPageRequests = 0;
	const fetchImpl = async (url) => {
		if (url.includes("/files?")) {
			return { ok: true, status: 200, json: async () => [{ filename: "README.md" }] };
		}
		pullPageRequests += 1;
		return {
			ok: true,
			status: 200,
			json: async () => Array.from({ length: 100 }, () => current),
		};
	};

	const result = await classify(current, fetchImpl);
	assert.equal(result.runFull, true);
	assert.equal(result.reason, "metadata-error");
	assert.equal(pullPageRequests, 30);
});

test("fails open when a GitHub API request times out", async () => {
	const current = apiPull(1, "main", "one");
	const fetchImpl = async (_url, options) =>
		new Promise((_resolve, reject) => {
			options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
		});

	const result = await classifyGitHubEvent({
		event: event(current),
		repository: REPOSITORY,
		apiUrl: "https://api.github.test",
		token: "test-token",
		fetchImpl,
		requestTimeoutMs: 1,
	});
	assert.equal(result.runFull, true);
	assert.equal(result.reason, "metadata-error");
});

test("fails open when changed files are empty or malformed", async () => {
	const current = apiPull(1, "main", "one");
	const empty = await classify(current, mockFetch({ pulls: [current], files: [] }));
	const malformed = await classify(current, mockFetch({ pulls: [current], files: [{}] }));
	assert.equal(empty.runFull, true);
	assert.equal(malformed.runFull, true);
});

test("emits stable GitHub Actions outputs", () => {
	const outputs = formatGitHubOutputs({
		runFull: false,
		docsOnly: true,
		topology: "standalone",
		reason: "docs-only",
	});
	assert.equal(outputs, "run_full=false\nreason=docs-only");
});
