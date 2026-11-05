import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureMaintenanceBranch } from "./release-maintenance-branch.mjs";

const commit = "a".repeat(40);
const branch = "release/2.47";
const ref = `refs/heads/${branch}`;
const base = "https://api.github.com/repos/example/project/git";
const options = { tag: "v2.47.0", repository: "example/project", commit, token: "example-token" };
const validRef = { ref, object: { type: "commit", sha: "b".repeat(40) } };

function mockFetch(responses) {
	const calls = [];
	return {
		calls,
		async fetchImpl(url, init) {
			calls.push({ url, ...init });
			assert.ok(responses.length > 0, "Unexpected network request");
			const response = responses.shift();
			if (response instanceof Error) throw response;
			return { status: response.status, async json() { return response.payload; } };
		},
	};
}

describe("maintenance branch creation", () => {
	it("creates the exact stable minor branch at the published commit when absent", async () => {
		// Arrange: only a missing branch permits creation.
		const mock = mockFetch([{ status: 404 }, { status: 201 }]);
		const result = await ensureMaintenanceBranch({ ...options, fetchImpl: mock.fetchImpl });
		assert.deepEqual(result, { status: "created", branch });
		assert.deepEqual(mock.calls.map(({ url, method }) => [url, method ?? "GET"]), [
			[`${base}/ref/heads/${branch}`, "GET"],
			[`${base}/refs`, "POST"],
		]);
		assert.deepEqual(JSON.parse(mock.calls[1].body), { ref, sha: commit });
		assert.equal(mock.calls[0].headers.Authorization, "Bearer example-token");
		assert.equal(mock.calls[1].headers["Content-Type"], "application/json");
	});

	it("preserves an existing branch even when its commit differs from the release", async () => {
		const mock = mockFetch([{ status: 200, payload: validRef }]);
		const result = await ensureMaintenanceBranch({ ...options, fetchImpl: mock.fetchImpl });
		// Assert: no POST or update is permitted for an existing branch.
		assert.deepEqual(result, { status: "existing", branch });
		assert.equal(mock.calls.length, 1);
		assert.equal(mock.calls[0].method ?? "GET", "GET");
	});

	for (const tag of [undefined, null, "", "invalid", "2.47.0", "v02.47.0", "v2.047.0", "v2.47.1", "v2.47.10", "v2.47.0-alpha.1", "v2.47.0-beta.2", "v2.47.0-rc.1", "v2.47.0+build.1"]) {
		it(`skips ${String(tag)} without credentials or requests`, async () => {
			const mock = mockFetch([]);
			const result = await ensureMaintenanceBranch({ tag, fetchImpl: mock.fetchImpl });
			assert.deepEqual(result, { status: "skipped" });
			assert.equal(mock.calls.length, 0);
		});
	}

	for (const [field, values, message] of [
		["repository", [undefined, "", "project", "owner/project/extra", "owner/project?query=1"], /owner\/repository/],
		["commit", [undefined, "", "a".repeat(39), "a".repeat(41), "g".repeat(40)], /full commit SHA/],
		["token", [undefined, ""], /TOKEN.*required/],
	]) {
		for (const value of values) {
			it(`rejects eligible releases with invalid ${field}: ${String(value)}`, async () => {
				const mock = mockFetch([]);
				const result = ensureMaintenanceBranch({ ...options, [field]: value, fetchImpl: mock.fetchImpl });
				await assert.rejects(result, message);
				assert.equal(mock.calls.length, 0);
			});
		}
	}

	for (const status of [401, 403, 500]) {
		it(`fails on GET ${status} without attempting creation`, async () => {
			const mock = mockFetch([{ status }]);
			const result = ensureMaintenanceBranch({ ...options, fetchImpl: mock.fetchImpl });
			await assert.rejects(result, new RegExp(`Cannot read maintenance branch: HTTP ${status}`));
			assert.equal(mock.calls.length, 1);
		});
	}

	for (const payload of [
		{},
		{ ...validRef, ref: "refs/heads/release/2.46" },
		{ ref },
		{ ref, object: null },
		{ ref, object: { type: "tag", sha: commit } },
		{ ref, object: { type: "commit" } },
		{ ref, object: { type: "commit", sha: "" } },
	]) {
		it(`rejects an unexpected reference payload: ${JSON.stringify(payload)}`, async () => {
			const mock = mockFetch([{ status: 200, payload }]);
			const result = ensureMaintenanceBranch({ ...options, fetchImpl: mock.fetchImpl });
			await assert.rejects(result, /unexpected maintenance branch reference/);
			assert.equal(mock.calls.length, 1);
		});
	}

	for (const status of [409, 422]) {
		it(`accepts POST ${status} only after finding the branch created concurrently`, async () => {
			const mock = mockFetch([{ status: 404 }, { status }, { status: 200, payload: validRef }]);
			const result = await ensureMaintenanceBranch({ ...options, fetchImpl: mock.fetchImpl });
			assert.deepEqual(result, { status: "existing", branch });
			assert.deepEqual(mock.calls.map(({ method }) => method ?? "GET"), ["GET", "POST", "GET"]);
			assert.equal(mock.calls[2].url, mock.calls[0].url);
		});

		it(`rejects POST ${status} when the branch is still absent`, async () => {
			const mock = mockFetch([{ status: 404 }, { status }, { status: 404 }]);
			const result = ensureMaintenanceBranch({ ...options, fetchImpl: mock.fetchImpl });
			await assert.rejects(result, new RegExp(`Cannot create maintenance branch: HTTP ${status}`));
			assert.equal(mock.calls.length, 3);
		});
	}

	for (const status of [403, 500]) {
		it(`fails on POST ${status} without retrying or updating the branch`, async () => {
			const mock = mockFetch([{ status: 404 }, { status }]);
			const result = ensureMaintenanceBranch({ ...options, fetchImpl: mock.fetchImpl });
			await assert.rejects(result, new RegExp(`Cannot create maintenance branch: HTTP ${status}`));
			assert.equal(mock.calls.length, 2);
		});
	}

	for (const stage of ["lookup", "creation", "conflict lookup"]) {
		it(`propagates network errors during ${stage}`, async () => {
			const error = new Error("Simulated connection failure");
			const responses = { lookup: [], creation: [{ status: 404 }], "conflict lookup": [{ status: 404 }, { status: 409 }] };
			const mock = mockFetch([...responses[stage], error]);
			const result = ensureMaintenanceBranch({ ...options, fetchImpl: mock.fetchImpl });
			await assert.rejects(result, (received) => received === error);
			assert.equal(mock.calls.length, responses[stage].length + 1);
		});
	}

	it("CLI skips patch releases without credentials", () => {
		// Arrange: use an explicit environment so developer credentials cannot leak into the child.
		const script = fileURLToPath(new URL("./release-maintenance-branch.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, RELEASE_TAG: "v2.47.1" },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "Maintenance branch skipped\n");
	});
});
