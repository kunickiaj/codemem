import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { miseInstallVersionFromPath } from "./mise-install-path.js";
import {
	createReleaseCacheIo,
	createReleaseDiscovery,
	detectInstallKind,
	type InstallDetectionInput,
	type InstallKind,
	isExplicitUpdateInstallEligible,
	type ReleaseChannel,
	type ReleaseDiscoveryDependencies,
} from "./release-discovery.js";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const registryUrl = (channel: ReleaseChannel) => `https://registry.npmjs.org/codemem/${channel}`;

type CacheRecord = {
	schema_version: number;
	channel?: ReleaseChannel;
	latest_version: string;
	checked_at: string;
	first_seen_at: string;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function response(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function cacheRecord(overrides: Partial<CacheRecord> = {}): CacheRecord {
	return {
		schema_version: 1,
		latest_version: "0.41.0",
		checked_at: "2026-08-10T00:00:00.000Z",
		first_seen_at: "2026-08-09T09:00:00.000Z",
		...overrides,
	};
}

function cacheWithoutSchemaVersion(
	overrides: Partial<CacheRecord> = {},
): Omit<CacheRecord, "schema_version"> {
	const record: Partial<CacheRecord> = { ...cacheRecord(overrides) };
	delete record.schema_version;
	return record as Omit<CacheRecord, "schema_version">;
}

function streamingResponse(options: { chunks: string[]; contentLength?: string; url?: string }): {
	response: Response;
	state: { cancelled: boolean; pulls: number };
} {
	const encoder = new TextEncoder();
	const state = { cancelled: false, pulls: 0 };
	let index = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulls += 1;
			const chunk = options.chunks[index];
			index += 1;
			if (chunk === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunk));
		},
		cancel() {
			state.cancelled = true;
		},
	});
	const headers = new Headers({ "content-type": "application/json" });
	if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
	const result = new Response(body, { status: 200, headers });
	if (options.url) Object.defineProperty(result, "url", { value: options.url });
	return { response: result, state };
}

function dependencies(
	options: {
		payload?: unknown;
		cache?: string | null;
		fetchError?: Error;
		writeError?: Error;
		now?: Date;
	} = {},
): ReleaseDiscoveryDependencies & {
	fetch: ReturnType<typeof vi.fn>;
	readCache: ReturnType<typeof vi.fn>;
	writeCacheAtomic: ReturnType<typeof vi.fn>;
	timeoutSignal: ReturnType<typeof vi.fn>;
} {
	const signal = new AbortController().signal;
	return {
		fetch: vi.fn(async () => {
			if (options.fetchError) throw options.fetchError;
			return response("payload" in options ? options.payload : { version: "0.41.0" });
		}),
		now: () => options.now ?? NOW,
		readCache: vi.fn(async () => options.cache ?? null),
		writeCacheAtomic: vi.fn(async () => {
			if (options.writeError) throw options.writeError;
		}),
		timeoutSignal: vi.fn(() => signal),
	};
}

async function check(
	deps: ReleaseDiscoveryDependencies,
	options: { currentVersion?: string; installKind?: InstallKind; refresh?: boolean } = {},
) {
	const discovery = createReleaseDiscovery(deps);
	return discovery.check({
		currentVersion: options.currentVersion ?? "0.40.2",
		installKind: options.installKind ?? "npm-global",
		refresh: options.refresh,
	});
}

describe("release discovery registry contract", () => {
	it("reports the current stable release without an update", async () => {
		// Arrange
		const deps = dependencies({ payload: { version: "0.40.2" } });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			current_version: "0.40.2",
			channel: "latest",
			latest_version: "0.40.2",
			update_available: false,
			stale: false,
			error: null,
		});
	});

	it("reports a newer stable release", async () => {
		// Arrange
		const deps = dependencies({ payload: { version: "0.41.0" } });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: "0.41.0",
			update_available: true,
			first_seen_at: NOW.toISOString(),
			checked_at: NOW.toISOString(),
			stale: false,
		});
	});

	it.each([
		{ channel: "alpha", currentVersion: "0.44.0-alpha.1", latestVersion: "0.44.0-alpha.2" },
		{ channel: "beta", currentVersion: "0.44.0-beta.1", latestVersion: "0.44.0-beta.2" },
		{ channel: "rc", currentVersion: "0.44.0-rc.1", latestVersion: "0.44.0-rc.2" },
		{ channel: "latest", currentVersion: "0.43.0", latestVersion: "0.44.0" },
	] satisfies Array<{
		channel: ReleaseChannel;
		currentVersion: string;
		latestVersion: string;
	}>)(
		"queries npm's $channel tag for an installed $channel release",
		async ({ channel, currentVersion, latestVersion }) => {
			const deps = dependencies({ payload: { version: latestVersion } });

			const status = await check(deps, { currentVersion });

			expect(status).toMatchObject({
				channel,
				latest_version: latestVersion,
				update_available: true,
			});
			expect(deps.fetch).toHaveBeenCalledWith(
				registryUrl(channel),
				expect.objectContaining({ redirect: "error" }),
			);
		},
	);

	it.each([
		{ currentVersion: "0.44.0-alpha.1", registryVersion: "0.44.0-beta.1" },
		{ currentVersion: "0.44.0-beta.1", registryVersion: "0.44.0-alpha.2" },
		{ currentVersion: "0.43.0", registryVersion: "0.44.0-alpha.2" },
	])(
		"rejects registry version $registryVersion outside the installed channel",
		async ({ currentVersion, registryVersion }) => {
			const status = await check(dependencies({ payload: { version: registryVersion } }), {
				currentVersion,
			});

			expect(status).toMatchObject({ latest_version: null, update_available: false });
			expect(status.error).toMatch(/invalid registry version/i);
		},
	);

	it("accepts stable semantic versions with build metadata", async () => {
		// Arrange
		const deps = dependencies({ payload: { version: "0.41.0+build.7" } });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: "0.41.0+build.7",
			update_available: true,
			stale: false,
		});
	});

	it("never presents a registry downgrade as an available update", async () => {
		// Arrange
		const deps = dependencies({ payload: { version: "0.39.9" } });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: "0.39.9",
			update_available: false,
			auto_update_eligible: false,
		});
	});

	it("allows a fresh npm update only after the release has been observed for 24 hours", async () => {
		const deps = dependencies({
			cache: JSON.stringify(
				cacheRecord({
					first_seen_at: "2026-08-09T12:00:00.000Z",
					checked_at: "2026-08-10T12:00:00.000Z",
				}),
			),
		});

		const status = await check(deps, { installKind: "npm-global" });

		expect(status.auto_update_eligible).toBe(true);
	});

	it("allows an opted-in alpha installation to auto-update within alpha", async () => {
		const deps = dependencies({
			cache: JSON.stringify(
				cacheRecord({
					schema_version: 2,
					channel: "alpha",
					latest_version: "0.44.0-alpha.2",
					first_seen_at: "2026-08-09T12:00:00.000Z",
					checked_at: NOW.toISOString(),
				}),
			),
		});

		const status = await check(deps, {
			currentVersion: "0.44.0-alpha.1",
			installKind: "npm-global",
		});

		expect(status).toMatchObject({ channel: "alpha", auto_update_eligible: true });
	});

	it("refuses a release observed for less than 24 hours", async () => {
		const deps = dependencies({
			cache: JSON.stringify(
				cacheRecord({ first_seen_at: "2026-08-09T12:00:00.001Z", checked_at: NOW.toISOString() }),
			),
		});

		const status = await check(deps, { installKind: "npm-global" });

		expect(status.auto_update_eligible).toBe(false);
	});

	it("never authorizes automatic installation for npx", async () => {
		const deps = dependencies({
			cache: JSON.stringify(
				cacheRecord({
					first_seen_at: "2026-08-09T12:00:00.000Z",
					checked_at: NOW.toISOString(),
				}),
			),
		});

		const status = await check(deps, { installKind: "npx" });

		expect(status.auto_update_eligible).toBe(false);
	});

	it.each([
		"0.41.0-beta.1",
		"0.41.0-rc.0",
		"v0.41.0",
		"0.41",
		"01.2.3",
		"999999999999999999999999.1.0",
	])("rejects non-strict or prerelease registry version %s", async (version) => {
		// Arrange
		const deps = dependencies({ payload: { version } });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: null,
			update_available: false,
			auto_update_eligible: false,
			stale: false,
		});
	});

	it.each([
		{ label: "null", payload: null },
		{ label: "array", payload: [] },
		{ label: "empty object", payload: {} },
		{ label: "numeric version", payload: { version: 41 } },
		{ label: "empty version", payload: { version: "" } },
		{ label: "wrong property", payload: { latest: "0.41.0" } },
	])("rejects malformed registry payload: $label", async ({ payload }) => {
		// Arrange
		const deps = dependencies({ payload });

		// Act
		const status = await check(deps);

		// Assert
		expect(status.error).toMatch(/invalid.*registry/i);
	});

	it("uses the fixed registry endpoint and injected two-second timeout", async () => {
		// Arrange
		const deps = dependencies();

		// Act
		await check(deps);

		// Assert
		expect(deps.timeoutSignal).toHaveBeenCalledWith(2_000);
		expect(deps.fetch).toHaveBeenCalledWith(
			registryUrl("latest"),
			expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
		);
	});

	it("rejects a response whose final URL does not exactly match the fixed registry URL", async () => {
		// Arrange
		const deps = dependencies();
		const mismatched = response({ version: "0.41.0" });
		Object.defineProperty(mismatched, "url", {
			value: "https://registry.npmjs.org/codemem",
		});
		deps.fetch.mockResolvedValue(mismatched);

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({ latest_version: null, update_available: false });
		expect(status.error).toMatch(/invalid registry response origin|response url/i);
	});

	it.each([
		new DOMException("The operation timed out", "TimeoutError"),
		new DOMException("The operation was aborted", "AbortError"),
	])("classifies compatible $name failures as registry timeouts", async (timeoutError) => {
		// Arrange
		const deps = dependencies({ fetchError: timeoutError });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: null,
			update_available: false,
			auto_update_eligible: false,
			stale: false,
		});
		expect(status.error).toBe("registry request timed out");
	});

	it("classifies a real Node AbortSignal timeout as a registry timeout", async () => {
		// Arrange
		const deps = dependencies();
		deps.timeoutSignal.mockImplementation((milliseconds: number) =>
			AbortSignal.timeout(Math.min(milliseconds, 1)),
		);
		deps.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
			const signal = init?.signal;
			await new Promise<never>((_resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
			});
			throw new Error("unreachable");
		});

		// Act
		const status = await check(deps);

		// Assert
		expect(status.error).toBe("registry request timed out");
	});

	it.each([
		{ label: "missing Content-Length", contentLength: undefined },
		{ label: "lying Content-Length", contentLength: "32" },
	])("caps the streamed response body with $label", async ({ contentLength }) => {
		// Arrange
		const deps = dependencies();
		const chunks = Array.from({ length: 20 }, () => "x".repeat(4_096));
		const streamed = streamingResponse({ chunks, contentLength, url: registryUrl("latest") });
		deps.fetch.mockResolvedValue(streamed.response);

		// Act
		const status = await check(deps);

		// Assert
		expect(status.error).toMatch(/payload too large/i);
		expect(streamed.state.cancelled).toBe(true);
		expect(streamed.state.pulls).toBeLessThan(chunks.length);
	});

	it("enforces the response cap in bytes rather than decoded string length", async () => {
		// Arrange
		const deps = dependencies();
		const streamed = streamingResponse({
			chunks: ["é".repeat(9_000)],
			url: registryUrl("latest"),
		});
		deps.fetch.mockResolvedValue(streamed.response);

		// Act
		const status = await check(deps);

		// Assert
		expect(status.error).toMatch(/payload too large/i);
	});

	it("does not report an unparseable current version as up to date", async () => {
		// Arrange
		const deps = dependencies({ payload: { version: "0.41.0" } });

		// Act
		const status = await check(deps, { currentVersion: "development" });

		// Assert
		expect(status.update_available).toBe(false);
		expect(status.recommended_action).not.toMatch(/up to date|no action required/i);
		expect(deps.fetch).not.toHaveBeenCalled();
	});

	it("routes an rc installation through the rc channel", async () => {
		const deps = dependencies({ payload: { version: "0.44.0-rc.2" } });

		const status = await check(deps, { currentVersion: "0.44.0-rc.1" });

		expect(status).toMatchObject({
			channel: "rc",
			latest_version: "0.44.0-rc.2",
			update_available: true,
		});
		expect(status.recommended_action).toContain("codemem@0.44.0-rc.2");
		expect(deps.fetch).toHaveBeenCalledWith(
			registryUrl("rc"),
			expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
		);
	});
});

describe("repository-source release status", () => {
	it("keeps registry metadata informational", async () => {
		const status = await check(dependencies({ payload: { version: "0.44.2" } }), {
			currentVersion: "0.44.0",
			installKind: "repo-dev",
		});

		expect(status).toMatchObject({
			current_version: "0.44.0",
			install_kind: "repo-dev",
			latest_version: "0.44.2",
			update_available: false,
		});
		expect(status.recommended_action).toBe(
			"Package-release updates do not apply to repository source. Run git pull, pnpm install, and pnpm build in the codemem repository.",
		);
	});
});

describe("mise release eligibility", () => {
	it("never authorizes automatic installation for mise", async () => {
		const deps = dependencies({
			cache: JSON.stringify(
				cacheRecord({
					first_seen_at: "2026-08-09T12:00:00.000Z",
					checked_at: NOW.toISOString(),
				}),
			),
		});

		const status = await check(deps, { installKind: "mise" });

		expect(status.auto_update_eligible).toBe(false);
	});

	it("permits a fresh error-free explicit mise update", async () => {
		const status = await check(dependencies(), { installKind: "mise" });

		expect(status.auto_update_eligible).toBe(false);
		expect(isExplicitUpdateInstallEligible(status)).toBe(true);
	});

	it("preserves delayed npm-global explicit eligibility", async () => {
		const pending = await check(dependencies(), { installKind: "npm-global" });
		const eligible = await check(
			dependencies({
				cache: JSON.stringify(
					cacheRecord({
						first_seen_at: "2026-08-09T12:00:00.000Z",
						checked_at: NOW.toISOString(),
					}),
				),
			}),
			{ installKind: "npm-global" },
		);

		expect(isExplicitUpdateInstallEligible(pending)).toBe(false);
		expect(isExplicitUpdateInstallEligible(eligible)).toBe(true);
	});
});

describe("explicit mise update eligibility", () => {
	it.each([
		{ error: "registry request failed", stale: false },
		{ error: null, stale: true },
	])("refuses mise when stale=$stale and error=$error", async ({ error, stale }) => {
		const status = await check(dependencies(), { installKind: "mise" });

		expect(isExplicitUpdateInstallEligible({ ...status, error, stale })).toBe(false);
	});
});

describe("explicit pnpm-global update eligibility", () => {
	it("keeps a fresh pnpm-global update explicit-only", async () => {
		const status = await check(dependencies(), { installKind: "pnpm-global" });

		expect(status.auto_update_eligible).toBe(false);
		expect(isExplicitUpdateInstallEligible(status)).toBe(true);
	});

	it.each([
		{ error: "registry request failed", stale: false },
		{ error: null, stale: true },
		{ error: null, stale: false, updateAvailable: false },
	])(
		"refuses pnpm-global when stale=$stale, error=$error, and updateAvailable=$updateAvailable",
		async ({ error, stale, updateAvailable = true }) => {
			const status = await check(dependencies(), { installKind: "pnpm-global" });

			expect(
				isExplicitUpdateInstallEligible({
					...status,
					error,
					stale,
					update_available: updateAvailable,
				}),
			).toBe(false);
		},
	);
});

describe("release discovery cache contract", () => {
	it("uses cache younger than six hours without registry access", async () => {
		// Arrange
		const cached = cacheRecord({ checked_at: "2026-08-10T06:00:00.001Z" });
		const deps = dependencies({ cache: JSON.stringify(cached) });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: "0.41.0",
			first_seen_at: cached.first_seen_at,
			checked_at: cached.checked_at,
			stale: false,
		});
		expect(deps.fetch).not.toHaveBeenCalled();
	});

	it("refreshes cache once it is six hours old", async () => {
		// Arrange
		const cached = cacheRecord({ checked_at: "2026-08-10T06:00:00.000Z" });
		const deps = dependencies({ cache: JSON.stringify(cached) });

		// Act
		await check(deps);

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(1);
	});

	it("writes the current cache schema version", async () => {
		// Arrange
		const deps = dependencies();

		// Act
		await check(deps);

		// Assert
		const contents = String(deps.writeCacheAtomic.mock.calls[0]?.[0]);
		expect(JSON.parse(contents)).toMatchObject({ schema_version: 2, channel: "latest" });
	});

	it("preserves a valid legacy stable cache without registry access", async () => {
		const cached = cacheRecord({ checked_at: "2026-08-10T11:00:00.000Z" });
		const deps = dependencies({ cache: JSON.stringify(cached) });

		const status = await check(deps);

		expect(status).toMatchObject({ channel: "latest", latest_version: "0.41.0" });
		expect(deps.fetch).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: "alpha installation with stable legacy cache",
			currentVersion: "0.44.0-alpha.1",
			cache: cacheRecord({ checked_at: "2026-08-10T11:00:00.000Z" }),
			registryVersion: "0.44.0-alpha.2",
		},
		{
			label: "stable installation with alpha cache",
			currentVersion: "0.43.0",
			cache: cacheRecord({
				schema_version: 2,
				channel: "alpha",
				latest_version: "0.44.0-alpha.2",
				checked_at: "2026-08-10T11:00:00.000Z",
			}),
			registryVersion: "0.44.0",
		},
	])(
		"never reuses a cache across channels: $label",
		async ({ currentVersion, cache, registryVersion }) => {
			const deps = dependencies({
				cache: JSON.stringify(cache),
				payload: { version: registryVersion },
			});

			const status = await check(deps, { currentVersion });

			expect(status.latest_version).toBe(registryVersion);
			expect(deps.fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("preserves first-seen time while the same latest release remains current", async () => {
		// Arrange
		const cached = cacheRecord();
		const deps = dependencies({ cache: JSON.stringify(cached), payload: { version: "0.41.0" } });

		// Act
		const status = await check(deps);

		// Assert
		expect(status.first_seen_at).toBe(cached.first_seen_at);
	});

	it("resets first-seen time when the latest release changes", async () => {
		// Arrange
		const cached = cacheRecord({ latest_version: "0.41.0" });
		const deps = dependencies({ cache: JSON.stringify(cached), payload: { version: "0.42.0" } });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: "0.42.0",
			first_seen_at: NOW.toISOString(),
		});
	});

	it("returns valid stale status when refresh fails", async () => {
		// Arrange
		const cached = cacheRecord();
		const deps = dependencies({
			cache: JSON.stringify(cached),
			fetchError: new Error("registry offline"),
		});

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: cached.latest_version,
			update_available: true,
			first_seen_at: cached.first_seen_at,
			checked_at: cached.checked_at,
			stale: true,
			auto_update_eligible: false,
		});
		expect(status.error).toMatch(/registry offline/i);
	});

	it("forced refresh bypasses a fresh cache", async () => {
		// Arrange
		const cached = cacheRecord({ checked_at: "2026-08-10T11:59:00.000Z" });
		const deps = dependencies({ cache: JSON.stringify(cached) });

		// Act
		await check(deps, { refresh: true });

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(1);
	});

	it("forced refresh bypasses a fresh in-memory result", async () => {
		// Arrange
		const deps = dependencies();
		const discovery = createReleaseDiscovery(deps);
		const options = { currentVersion: "0.40.2", installKind: "npm-global" as const };

		// Act
		await discovery.check(options);
		await discovery.check({ ...options, refresh: true });

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(2);
	});

	it("ignores malformed cache content and refreshes from the registry", async () => {
		// Arrange
		const deps = dependencies({ cache: "{ definitely-not-json" });

		// Act
		const status = await check(deps);

		// Assert
		expect(status.latest_version).toBe("0.41.0");
		expect(deps.fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			label: "missing schema version",
			cache: cacheWithoutSchemaVersion({
				checked_at: "2026-08-10T11:00:00.000Z",
				first_seen_at: "2026-08-10T10:00:00.000Z",
			}),
		},
		{
			label: "unsupported schema version",
			cache: cacheRecord({
				schema_version: 3,
				checked_at: "2026-08-10T11:00:00.000Z",
				first_seen_at: "2026-08-10T10:00:00.000Z",
			}),
		},
	])("rejects cache records with $label", async ({ cache }) => {
		// Arrange
		const deps = dependencies({ cache: JSON.stringify(cache) });

		// Act
		await check(deps);

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(1);
	});

	it("ignores cache records containing invalid versions or timestamps", async () => {
		// Arrange
		const deps = dependencies({
			cache: JSON.stringify(
				cacheRecord({ latest_version: "0.41.0-rc.1", checked_at: "not-a-date" }),
			),
		});

		// Act
		const status = await check(deps);

		// Assert
		expect(status.latest_version).toBe("0.41.0");
		expect(deps.fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			label: "checked_at in the future",
			cache: cacheRecord({ checked_at: "2026-08-10T12:00:00.001Z" }),
		},
		{
			label: "first_seen_at after checked_at",
			cache: cacheRecord({
				checked_at: "2026-08-10T11:00:00.000Z",
				first_seen_at: "2026-08-10T11:00:00.001Z",
			}),
		},
	])("rejects cache records with $label", async ({ cache }) => {
		// Arrange
		const deps = dependencies({ cache: JSON.stringify(cache) });

		// Act
		await check(deps);

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(1);
	});

	it("returns fresh status even when the atomic cache write fails", async () => {
		// Arrange
		const deps = dependencies({ writeError: new Error("rename denied") });

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({
			latest_version: "0.41.0",
			update_available: true,
			stale: false,
		});
		expect(status.error).toMatch(/rename denied|cache/i);
	});

	it("reuses a fresh in-memory result when the cache cannot be written", async () => {
		// Arrange
		const deps = dependencies({ writeError: new Error("rename denied") });
		const discovery = createReleaseDiscovery(deps);
		const options = { currentVersion: "0.40.2", installKind: "npm-global" as const };

		// Act
		const first = await discovery.check(options);
		const second = await discovery.check(options);

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it("does not reuse an in-memory result across channels", async () => {
		const deps = dependencies();
		deps.fetch.mockImplementation(async (url: string) =>
			response({ version: url.endsWith("/alpha") ? "0.44.0-alpha.2" : "0.44.0" }),
		);
		const discovery = createReleaseDiscovery(deps);

		const alpha = await discovery.check({
			currentVersion: "0.44.0-alpha.1",
			installKind: "npm-global",
		});
		const stable = await discovery.check({ currentVersion: "0.43.0", installKind: "npm-global" });

		expect(alpha.latest_version).toBe("0.44.0-alpha.2");
		expect(stable.latest_version).toBe("0.44.0");
		expect(deps.fetch).toHaveBeenCalledTimes(2);
	});

	it("backs off sequential registry failures when no cache exists", async () => {
		// Arrange
		const deps = dependencies({ fetchError: new Error("registry offline") });
		const discovery = createReleaseDiscovery(deps);
		const options = { currentVersion: "0.40.2", installKind: "npm-global" as const };

		// Act
		const first = await discovery.check(options);
		const second = await discovery.check(options);

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it("retries registry discovery after the failure backoff expires", async () => {
		// Arrange
		let currentTime = NOW;
		const deps = dependencies({ fetchError: new Error("registry offline") });
		deps.now = () => currentTime;
		const discovery = createReleaseDiscovery(deps);
		const options = { currentVersion: "0.40.2", installKind: "npm-global" as const };

		// Act
		await discovery.check(options);
		currentTime = new Date(NOW.getTime() + 15 * 60 * 1_000);
		await discovery.check(options);

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(2);
	});

	it("keeps backing off registry failures when the wall clock moves backwards", async () => {
		// Arrange
		let currentTime = NOW;
		const deps = dependencies({ fetchError: new Error("registry offline") });
		deps.now = () => currentTime;
		const discovery = createReleaseDiscovery(deps);
		const options = { currentVersion: "0.40.2", installKind: "npm-global" as const };

		// Act
		await discovery.check(options);
		currentTime = new Date(NOW.getTime() - 60 * 1_000);
		await discovery.check(options);

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(1);
	});

	it("returns fresh status with a warning when reading the cache fails", async () => {
		// Arrange
		const deps = dependencies();
		deps.readCache.mockRejectedValue(new Error("permission denied"));

		// Act
		const status = await check(deps);

		// Assert
		expect(status).toMatchObject({ latest_version: "0.41.0", stale: false });
		expect(status.error).toMatch(/cache read failed.*permission denied/i);
	});

	it("coalesces concurrent refreshes into one registry request", async () => {
		// Arrange
		let resolveFetch: ((value: Response) => void) | undefined;
		const deps = dependencies();
		deps.fetch.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const discovery = createReleaseDiscovery(deps);

		// Act
		const first = discovery.check({ currentVersion: "0.40.2", installKind: "npm-global" });
		const second = discovery.check({ currentVersion: "0.40.2", installKind: "npm-global" });
		await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(1));
		resolveFetch?.(response({ version: "0.41.0" }));
		const statuses = await Promise.all([first, second]);

		// Assert
		expect(deps.fetch).toHaveBeenCalledTimes(1);
		expect(statuses[0]).toEqual(statuses[1]);
	});
});

describe("release cache file IO", () => {
	it("atomically writes and reads a private cache file", async () => {
		// Arrange
		const directory = await mkdtemp(join(tmpdir(), "codemem-release-cache-"));
		temporaryDirectories.push(directory);
		const cacheDirectory = join(directory, ".codemem");
		const cachePath = join(cacheDirectory, "release-discovery.json");
		const io = createReleaseCacheIo(cachePath);
		const contents = JSON.stringify(cacheRecord());

		// Act
		await io.writeCacheAtomic(contents);
		const stored = await io.readCache();
		const directoryMode = (await stat(cacheDirectory)).mode & 0o777;
		const fileMode = (await stat(cachePath)).mode & 0o777;
		const entries = await readdir(cacheDirectory);

		// Assert
		expect(stored).toBe(contents);
		expect(await readFile(cachePath, "utf8")).toBe(contents);
		expect(directoryMode).toBe(0o700);
		expect(fileMode).toBe(0o600);
		expect(entries).toEqual(["release-discovery.json"]);
	});

	it("returns null when the cache file does not exist", async () => {
		// Arrange
		const directory = await mkdtemp(join(tmpdir(), "codemem-release-cache-"));
		temporaryDirectories.push(directory);
		const io = createReleaseCacheIo(join(directory, "missing", "cache.json"));

		// Act
		const stored = await io.readCache();

		// Assert
		expect(stored).toBeNull();
	});

	it("removes its temporary file when the atomic rename fails", async () => {
		// Arrange
		const directory = await mkdtemp(join(tmpdir(), "codemem-release-cache-"));
		temporaryDirectories.push(directory);
		const cacheDirectory = join(directory, ".codemem");
		const cachePath = join(cacheDirectory, "release-discovery.json");
		await mkdir(cachePath, { recursive: true });
		const io = createReleaseCacheIo(cachePath);

		// Act
		const write = io.writeCacheAtomic(JSON.stringify(cacheRecord()));

		// Assert
		await expect(write).rejects.toThrow();
		const entries = await readdir(cacheDirectory);
		expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
	});
});

describe("installation-kind detection", () => {
	it.each([
		{
			label: "explicit Docker marker",
			input: {
				entryPath: "/usr/local/lib/node_modules/codemem/dist/index.js",
				env: { CODEMEM_INSTALL_KIND: "docker" },
			},
			expected: "docker",
		},
		{
			label: "repository development source path",
			input: { entryPath: "/workspace/codemem/packages/cli/src/index.ts" },
			expected: "repo-dev",
		},
		{
			label: "npx cache path",
			input: { entryPath: "/home/user/.npm/_npx/abc123/node_modules/codemem/dist/index.js" },
			expected: "npx",
		},
		{
			label: "global npm package path",
			input: { entryPath: "/usr/local/lib/node_modules/codemem/dist/index.js" },
			expected: "npm-global",
		},
		{
			label: "pinned runner source",
			input: {
				entryPath: "/home/user/.npm/_npx/abc123/node_modules/codemem/dist/index.js",
				env: {
					CODEMEM_RUNNER_FROM: "git+https://github.com/kunickiaj/codemem.git@v0.40.2",
				},
			},
			expected: "pinned",
		},
		{
			label: "unrecognized path and source",
			input: { entryPath: "/opt/custom/codemem-cli.js", env: {} },
			expected: "unknown",
		},
	] satisfies Array<{
		label: string;
		input: InstallDetectionInput;
		expected: InstallKind;
	}>)("detects $label as $expected", ({ input, expected }) => {
		// Arrange
		const detectionInput = { ...input, env: { ...input.env } };

		// Act
		const kind = detectInstallKind(detectionInput);

		// Assert
		expect(kind).toBe(expected);
	});

	it.each([
		["unpinned npm tag", "codemem@latest", "unknown"],
		["pinned npm version", "codemem@0.40.2", "pinned"],
		["pinned git ref", "git+https://example.test/codemem.git@v0.40.2", "pinned"],
		["pinned git fragment", "git+https://example.test/codemem.git#v0.40.2", "pinned"],
		[
			"git fragment containing whitespace",
			"git+https://example.test/codemem.git#release branch",
			"unknown",
		],
		["repeated fragments", `git+https://example.test/codemem.git${"#".repeat(10_000)}`, "unknown"],
		["repeated git refs", `git+https://example.test/codemem${".git@".repeat(10_000)}`, "unknown"],
		[
			"bounded repeated fragments",
			`git+https://example.test/codemem.git${"#".repeat(2_000)}`,
			"pinned",
		],
		[
			"bounded repeated git refs",
			`git+https://example.test/codemem${".git@".repeat(500)}`,
			"unknown",
		],
	] as const)("handles %s runner sources in bounded time", (_label, source, expected) => {
		expect(
			detectInstallKind({
				entryPath: "/opt/custom/codemem-cli.js",
				env: { CODEMEM_RUNNER_FROM: source },
			}),
		).toBe(expected);
	});

	it("does not let an environment marker override pinned or repository-development evidence", () => {
		expect(
			detectInstallKind({
				entryPath: "/home/user/.npm/_npx/abc/node_modules/codemem/dist/index.js",
				env: { CODEMEM_INSTALL_KIND: "npm-global", CODEMEM_RUNNER_FROM: "codemem@0.40.2" },
			}),
		).toBe("pinned");
		expect(
			detectInstallKind({
				entryPath: "/workspace/codemem/packages/cli/src/index.ts",
				env: { CODEMEM_INSTALL_KIND: "npm-global" },
			}),
		).toBe("repo-dev");
	});

	it("does not treat CODEMEM_RUNNER=npx as executable installation evidence", () => {
		expect(
			detectInstallKind({
				entryPath: "/opt/custom/codemem-cli.js",
				env: { CODEMEM_RUNNER: "npx" },
			}),
		).toBe("unknown");
	});
});

describe("mise installation-kind detection", () => {
	it.each([
		{
			label: "Unix path",
			entryPath:
				"/home/user/.local/share/mise/installs/npm-codemem/0.41.0/lib/node_modules/codemem/dist/index.js",
		},
		{
			label: "Windows-style path",
			entryPath:
				"C:\\Users\\user\\AppData\\Local\\mise\\installs\\npm-codemem\\0.41.0\\lib\\node_modules\\codemem\\dist\\index.js",
		},
	])("detects a mise npm backend $label", ({ entryPath }) => {
		expect(detectInstallKind({ entryPath })).toBe("mise");
	});

	it("detects an executable beneath a symlinked default mise data directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codemem-mise-default-link-"));
		temporaryDirectories.push(directory);
		const home = join(directory, "home");
		const dataDirectory = join(home, ".local", "share", "mise");
		const canonicalStore = join(directory, "tool-store");
		const relativeEntry = join(
			"installs",
			"npm-codemem",
			"0.41.0",
			"lib",
			"node_modules",
			"codemem",
			"dist",
			"index.js",
		);
		await mkdir(dirname(join(canonicalStore, relativeEntry)), { recursive: true });
		await writeFile(join(canonicalStore, relativeEntry), "");
		await mkdir(join(dataDirectory, ".."), { recursive: true });
		await symlink(canonicalStore, dataDirectory, process.platform === "win32" ? "junction" : "dir");

		expect(
			detectInstallKind({
				entryPath: join(dataDirectory, relativeEntry),
				env: { HOME: home },
			}),
		).toBe("mise");
	});
});

describe("pnpm-global installation-kind detection", () => {
	it.each([
		{
			label: "current isolated global virtual-store package",
			entryPath:
				"/opt/pnpm/global/v11/group-token/node_modules/.pnpm/codemem@0.44.2_better-sqlite3@13.0.3_hono@4.13.7/node_modules/codemem/dist/index.js",
		},
		{
			label: "current normalized Windows isolated global virtual-store package",
			entryPath:
				"C:\\pnpm\\global\\v11\\short-group\\node_modules\\.pnpm\\codemem@0.44.2_peer@1.0.0\\node_modules\\codemem\\dist\\..\\dist\\index.js",
		},
		{
			label: "legacy Unix virtual-store package",
			entryPath: "/opt/pnpm/global/5/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
		},
		{
			label: "legacy Windows virtual-store package",
			entryPath:
				"C:\\pnpm\\global\\5\\.pnpm\\codemem@0.44.2\\node_modules\\codemem\\dist\\index.js",
		},
	])("detects a $label", ({ entryPath }) => {
		expect(detectInstallKind({ entryPath })).toBe("pnpm-global");
	});

	it("classifies an unresolved group alias from its canonical virtual-store entry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codemem-pnpm-global-link-"));
		temporaryDirectories.push(directory);
		const shortGroupPath = join(directory, "global", "v11", "7fe-18d46352ecbd2b50-0");
		const packageDirectoryName = "codemem@0.44.2_better-sqlite3@13.0.3_hono@4.13.7";
		const canonicalPackagePath = join(
			shortGroupPath,
			"node_modules",
			".pnpm",
			packageDirectoryName,
			"node_modules",
			"codemem",
		);
		const canonicalEntryPath = join(canonicalPackagePath, "dist", "index.js");
		const topLevelPackagePath = join(shortGroupPath, "node_modules", "codemem");
		const aliasGroupPath = join(directory, "global", "v11", "a".repeat(64));
		const aliasEntryPath = join(aliasGroupPath, "node_modules", "codemem", "dist", "index.js");
		const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
		await mkdir(dirname(canonicalEntryPath), { recursive: true });
		await writeFile(canonicalEntryPath, "");
		await symlink(canonicalPackagePath, topLevelPackagePath, directoryLinkType);
		await symlink(shortGroupPath, aliasGroupPath, directoryLinkType);

		expect(detectInstallKind({ entryPath: aliasEntryPath, env: { PNPM_HOME: directory } })).toBe(
			"pnpm-global",
		);
	});

	it("detects a legacy global entry beneath a custom normalized PNPM_HOME", () => {
		expect(
			detectInstallKind({
				entryPath:
					"/srv/tools/pnpm-home/../pnpm-home/global/5/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
				env: { PNPM_HOME: "/srv/tools/pnpm-home" },
			}),
		).toBe("pnpm-global");
	});

	it("treats PNPM_HOME as authoritative when it is configured", () => {
		expect(
			detectInstallKind({
				entryPath: "/opt/pnpm/global/5/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
				env: { PNPM_HOME: "/srv/tools/pnpm-home" },
			}),
		).toBe("unknown");
	});
});

describe("pnpm-global installation-kind refusals", () => {
	it.each([
		{
			label: "pnpm dlx package",
			entryPath:
				"/opt/pnpm-cache/pnpm/dlx/abc/def/node_modules/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
			expected: "npx",
		},
		{
			label: "legacy .pnpm dlx package",
			entryPath:
				"/opt/pnpm-cache/.pnpm/dlx/abc/node_modules/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
			expected: "npx",
		},
		{
			label: "project-local virtual-store package",
			entryPath:
				"/workspace/app/node_modules/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{
			label: "legacy global package without an exact version",
			entryPath: "/opt/pnpm/global/5/.pnpm/codemem@latest/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{
			label: "global package with a malformed version segment",
			entryPath:
				"/opt/pnpm/global/latest/group/node_modules/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{
			label: "global virtual-store package with an invalid semver",
			entryPath:
				"/opt/pnpm/global/v11/group/node_modules/.pnpm/codemem@01.2.3_peer@1/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{
			label: "global virtual-store package with an empty peer suffix",
			entryPath:
				"/opt/pnpm/global/v11/group/node_modules/.pnpm/codemem@0.44.2_/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{
			label: "generic package-manager global path",
			entryPath: "/opt/package-manager/global/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{
			label: "ambiguous versioned global package path",
			entryPath: "/srv/app/global/v1/group/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{
			label: "project-local versioned global virtual store",
			entryPath:
				"/srv/app/global/v11/group/node_modules/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{
			label: "project path merely containing pnpm dlx segments",
			entryPath:
				"/workspace/pnpm/dlx/cache/node_modules/.pnpm/codemem@0.44.2/node_modules/codemem/dist/index.js",
			expected: "unknown",
		},
		{ label: "missing entry path", entryPath: "", expected: "unknown" },
	] as const)("refuses a $label", ({ entryPath, expected }) => {
		expect(detectInstallKind({ entryPath })).toBe(expected);
	});

	it("preserves mise precedence over a pnpm-global environment marker", () => {
		expect(
			detectInstallKind({
				entryPath: "/opt/mise/installs/npm-codemem/0.44.2/lib/node_modules/codemem/dist/index.js",
				env: { CODEMEM_INSTALL_KIND: "pnpm-global" },
			}),
		).toBe("mise");
	});
});

describe("custom mise data directory detection", () => {
	it.each([
		{
			entryPath:
				"/home/user/xdg/mise/installs/npm-codemem/0.41.0/lib/node_modules/codemem/dist/index.js",
			env: { XDG_DATA_HOME: "/home/user/xdg" },
			label: "XDG data home",
		},
		{
			entryPath:
				"D:\\Users\\user\\AppData\\Local\\mise\\installs\\npm-codemem\\0.41.0\\lib\\node_modules\\codemem\\dist\\index.js",
			env: { LOCALAPPDATA: "D:\\Users\\user\\AppData\\Local" },
			label: "Windows LocalAppData",
		},
		{
			entryPath:
				"/home/user/.local/share/mise/installs/npm-codemem/0.41.0/lib/node_modules/codemem/dist/index.js",
			env: { USERPROFILE: "/home/user" },
			label: "USERPROFILE fallback",
		},
	])("detects the default mise root from $label", ({ entryPath, env }) => {
		expect(detectInstallKind({ entryPath, env })).toBe("mise");
	});

	it.each([
		{
			dataDir: "/opt/mise-data/../mise-data/",
			entryPath:
				"/opt/mise-data/installs/npm-codemem/0.41.0/lib/node_modules/codemem/dist/index.js",
			label: "Unix",
		},
		{
			dataDir: "C:\\mise-data\\.\\",
			entryPath:
				"C:\\mise-data\\installs\\npm-codemem\\0.41.0\\lib\\node_modules\\codemem\\dist\\index.js",
			label: "Windows-style",
		},
	])("accepts a normalized $label MISE_DATA_DIR install prefix", ({ dataDir, entryPath }) => {
		expect(
			detectInstallKind({
				entryPath,
				env: { MISE_DATA_DIR: dataDir },
			}),
		).toBe("mise");
	});

	it("extracts the exact version from the same comparable custom path used for matching", () => {
		expect(
			miseInstallVersionFromPath(
				"C:\\MİSE-DATA\\installs\\npm-codemem\\0.41.0\\lib\\node_modules\\codemem\\dist\\index.js",
				{ MISE_DATA_DIR: "C:\\MİSE-DATA\\" },
			),
		).toBe("0.41.0");
	});

	it.each([
		"/opt/tools/installs/npm-codemem/0.41.0/bin/codemem",
		"/opt/mise-data-other/installs/npm-codemem/0.41.0/bin/codemem",
	])("rejects insufficient mise path evidence at %s", (entryPath) => {
		expect(detectInstallKind({ entryPath, env: { MISE_DATA_DIR: "/opt/mise-data" } })).toBe(
			"unknown",
		);
	});
});

describe("mise installation evidence safeguards", () => {
	it("fails closed for an unrecognized npm backend install root", () => {
		expect(
			detectInstallKind({
				entryPath:
					"/opt/tool-store/installs/npm-codemem/0.41.0/lib/node_modules/codemem/dist/index.js",
			}),
		).toBe("unknown");
	});

	it.each([
		{
			label: "an unrecognized executable path",
			entryPath: "/opt/custom/codemem-cli.js",
		},
		{
			label: "conflicting npm-global path evidence",
			entryPath: "/usr/local/lib/node_modules/codemem/dist/index.js",
		},
	])("does not let an explicit mise marker claim $label", ({ entryPath }) => {
		expect(detectInstallKind({ entryPath, env: { CODEMEM_INSTALL_KIND: "mise" } })).toBe("unknown");
	});

	it("prefers mise path evidence over the generic npm-global layout", () => {
		expect(
			detectInstallKind({
				entryPath:
					"/home/user/.local/share/mise/installs/npm-codemem/0.41.0/lib/node_modules/codemem/dist/index.js",
				env: { CODEMEM_INSTALL_KIND: "npm-global" },
			}),
		).toBe("mise");
	});

	it("requires an exact version segment in mise path evidence", () => {
		expect(
			detectInstallKind({
				entryPath:
					"/home/user/.local/share/mise/installs/npm-codemem/latest/lib/node_modules/codemem/dist/index.js",
			}),
		).toBe("unknown");
	});
});

describe("installation guidance", () => {
	it.each([
		{ channel: "alpha", currentVersion: "0.44.0-alpha.1", latestVersion: "0.44.0-alpha.2" },
		{ channel: "beta", currentVersion: "0.44.0-beta.1", latestVersion: "0.44.0-beta.2" },
	] as const)(
		"keeps $channel guidance on the installed channel",
		async ({ currentVersion, latestVersion }) => {
			const status = await check(dependencies({ payload: { version: latestVersion } }), {
				currentVersion,
			});

			expect(status.recommended_action).toContain(`codemem@${latestVersion}`);
		},
	);

	it.each([
		["npm-global", "npm install -g codemem@0.41.0"],
		["pnpm-global", "pnpm add -g codemem@0.41.0 @codemem/embeddings@0.41.0"],
		["npx", "codemem@0.41.0 and @codemem/embeddings@0.41.0"],
		["docker", "CODEMEM_VERSION=0.41.0 docker compose build --pull"],
		["repo-dev", "git pull"],
		["pinned", "pinned"],
		["unknown", "installation method"],
	] satisfies Array<[InstallKind, string]>)(
		"returns %s-specific upgrade guidance",
		async (installKind, expectedGuidance) => {
			// Arrange
			const deps = dependencies();

			// Act
			const status = await check(deps, { installKind });

			// Assert
			expect(status).toMatchObject({ install_kind: installKind });
			expect(status.recommended_action).toContain(expectedGuidance);
		},
	);

	it("includes the CPU-only ONNX policy in Linux npm-global guidance", async () => {
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const status = await check(dependencies(), { installKind: "npm-global" }).finally(() =>
			platform.mockRestore(),
		);

		expect(status.recommended_action).toBe(
			"env ONNXRUNTIME_NODE_INSTALL=skip npm install -g codemem@0.41.0",
		);
	});

	it("keeps npm-global guidance unprefixed off Linux", async () => {
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const status = await check(dependencies(), { installKind: "npm-global" }).finally(() =>
			platform.mockRestore(),
		);

		expect(status.recommended_action).toBe("npm install -g codemem@0.41.0");
	});

	it("returns exact paired pnpm-global guidance off Linux", async () => {
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const status = await check(dependencies(), { installKind: "pnpm-global" }).finally(() =>
			platform.mockRestore(),
		);

		expect(status.recommended_action).toBe("pnpm add -g codemem@0.41.0 @codemem/embeddings@0.41.0");
	});

	it("prefixes pnpm-global guidance with the Linux CPU-only ONNX policy", async () => {
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const status = await check(dependencies(), { installKind: "pnpm-global" }).finally(() =>
			platform.mockRestore(),
		);

		expect(status.recommended_action).toBe(
			"env ONNXRUNTIME_NODE_INSTALL=skip pnpm add -g codemem@0.41.0 @codemem/embeddings@0.41.0",
		);
	});

	it("returns no-upgrade guidance when the installation is current", async () => {
		// Arrange
		const deps = dependencies({ payload: { version: "0.40.2" } });

		// Act
		const status = await check(deps);

		// Assert
		expect(status.recommended_action).toMatch(/up to date|no action/i);
	});
});

describe("mise installation guidance", () => {
	it("returns the exact mise upgrade command off Linux", async () => {
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const status = await check(dependencies(), { installKind: "mise" }).finally(() =>
			platform.mockRestore(),
		);

		expect(status.recommended_action).toBe("mise use -g npm:codemem@0.41.0");
	});

	it("returns the exact Linux mise upgrade command with install safeguards", async () => {
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const status = await check(dependencies(), { installKind: "mise" }).finally(() =>
			platform.mockRestore(),
		);

		expect(status.recommended_action).toBe(
			"env ONNXRUNTIME_NODE_INSTALL=skip mise use -g npm:codemem@0.41.0",
		);
	});
});
