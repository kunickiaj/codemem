import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codememHomeDir } from "./home.js";

const REGISTRY_URL = "https://registry.npmjs.org/codemem/latest";
const REQUEST_TIMEOUT_MS = 2_000;
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const FAILURE_RETRY_DELAY_MS = 15 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const MAX_VERSION_LENGTH = 128;
const MAX_RUNNER_SOURCE_LENGTH = 4_096;
const RELEASE_CACHE_SCHEMA_VERSION = 1;
const AUTO_UPDATE_DELAY_MS = 24 * 60 * 60 * 1_000;
const STABLE_SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type InstallKind = "npm-global" | "npx" | "docker" | "repo-dev" | "pinned" | "unknown";

export interface UpdateStatus {
	current_version: string;
	latest_version: string | null;
	update_available: boolean;
	first_seen_at: string | null;
	checked_at: string | null;
	stale: boolean;
	install_kind: InstallKind;
	auto_update_eligible: boolean;
	recommended_action: string;
	error: string | null;
}

interface ReleaseCacheRecord {
	schema_version: typeof RELEASE_CACHE_SCHEMA_VERSION;
	latest_version: string;
	checked_at: string;
	first_seen_at: string;
}

export interface ReleaseCacheIo {
	readCache: () => Promise<string | null>;
	writeCacheAtomic: (contents: string) => Promise<void>;
}

export interface InstallDetectionInput {
	entryPath: string;
	env?: Record<string, string | undefined>;
}

export interface ReleaseDiscoveryDependencies {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	now: () => Date;
	readCache: () => Promise<string | null>;
	writeCacheAtomic: (contents: string) => Promise<void>;
	timeoutSignal: (milliseconds: number) => AbortSignal;
}

export interface ReleaseCheckOptions {
	currentVersion: string;
	installKind: InstallKind;
	refresh?: boolean;
}

export interface ReleaseDiscovery {
	check(options: ReleaseCheckOptions): Promise<UpdateStatus>;
}

interface ReleaseResolution {
	record: ReleaseCacheRecord | null;
	stale: boolean;
	error: string | null;
}

function parseStableSemver(value: unknown): [number, number, number] | null {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_VERSION_LENGTH) {
		return null;
	}
	const match = STABLE_SEMVER.exec(value);
	if (!match) return null;
	const parts = match.slice(1, 4).map(Number);
	return parts.every(Number.isSafeInteger) ? (parts as [number, number, number]) : null;
}

export function isStableReleaseVersion(value: unknown): value is string {
	return parseStableSemver(value) !== null;
}

function compareStableSemver(left: string, right: string): number | null {
	const leftParts = parseStableSemver(left);
	const rightParts = parseStableSemver(right);
	if (!leftParts || !rightParts) return null;
	for (const index of [0, 1, 2] as const) {
		const difference = leftParts[index] - rightParts[index];
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
}

function parseIsoTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value ? value : null;
}

function parseCache(contents: string | null, now: Date): ReleaseCacheRecord | null {
	if (contents === null) return null;
	try {
		const value: unknown = JSON.parse(contents);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const candidate = value as Record<string, unknown>;
		if (candidate.schema_version !== RELEASE_CACHE_SCHEMA_VERSION) return null;
		const latestVersion =
			typeof candidate.latest_version === "string" && parseStableSemver(candidate.latest_version)
				? candidate.latest_version
				: null;
		const checkedAt = parseIsoTimestamp(candidate.checked_at);
		const firstSeenAt = parseIsoTimestamp(candidate.first_seen_at);
		if (!latestVersion || !checkedAt || !firstSeenAt) return null;
		const checkedTime = Date.parse(checkedAt);
		const firstSeenTime = Date.parse(firstSeenAt);
		if (checkedTime > now.getTime() || firstSeenTime > checkedTime) return null;
		return {
			schema_version: RELEASE_CACHE_SCHEMA_VERSION,
			latest_version: latestVersion,
			checked_at: checkedAt,
			first_seen_at: firstSeenAt,
		};
	} catch {
		return null;
	}
}

function isFresh(record: ReleaseCacheRecord, now: Date): boolean {
	return now.getTime() - Date.parse(record.checked_at) < CACHE_MAX_AGE_MS;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return "registry request timed out";
	}
	return error instanceof Error && error.message ? error.message : "release discovery failed";
}

async function readBoundedResponseBody(response: Response): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		if (!/^\d+$/.test(contentLength)) {
			await response.body?.cancel();
			throw new Error("invalid registry response: invalid Content-Length");
		}
		const declaredBytes = Number(contentLength);
		if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_RESPONSE_BYTES) {
			await response.body?.cancel();
			throw new Error("invalid registry response: payload too large");
		}
	}
	if (!response.body) throw new Error("invalid registry response: missing body");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let receivedBytes = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			receivedBytes += result.value.byteLength;
			if (receivedBytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("invalid registry response: payload too large");
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(receivedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch {
		throw new Error("invalid registry response payload");
	}
}

async function fetchLatestVersion(deps: ReleaseDiscoveryDependencies): Promise<string> {
	const response = await deps.fetch(REGISTRY_URL, {
		headers: { accept: "application/json" },
		redirect: "error",
		signal: deps.timeoutSignal(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`registry request failed with status ${response.status}`);
	}
	if (response.url) {
		const finalUrl = new URL(response.url);
		if (finalUrl.href !== REGISTRY_URL) {
			await response.body?.cancel();
			throw new Error("invalid registry response URL");
		}
	}
	const body = await readBoundedResponseBody(response);
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new Error("invalid registry response payload");
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("invalid registry response payload");
	}
	const version = (payload as Record<string, unknown>).version;
	if (typeof version !== "string" || !parseStableSemver(version)) {
		throw new Error("invalid registry version");
	}
	return version;
}

function recommendedAction(
	installKind: InstallKind,
	currentVersion: string,
	latestVersion: string | null,
	updateAvailable: boolean,
): string {
	if (!latestVersion) return "Check network access and try again.";
	if (!parseStableSemver(currentVersion)) {
		return "Verify the current codemem version and try again.";
	}
	if (!updateAvailable) return "No action required; codemem is up to date.";
	switch (installKind) {
		case "npm-global":
			return `npm install -g codemem@${latestVersion}`;
		case "npx":
			return `Run npx codemem@${latestVersion} or update the version used by your launcher.`;
		case "docker":
			return `Set CODEMEM_VERSION=${latestVersion}, then run CODEMEM_VERSION=${latestVersion} docker compose build --pull and docker compose up -d.`;
		case "repo-dev":
			return "Run git pull, pnpm install, and pnpm build in the codemem repository.";
		case "pinned":
			return `Update the pinned codemem version to ${latestVersion}, then restart codemem.`;
		default:
			return `Update codemem to ${latestVersion} using your installation method.`;
	}
}

function toStatus(resolution: ReleaseResolution, options: ReleaseCheckOptions): UpdateStatus {
	const latestVersion = resolution.record?.latest_version ?? null;
	const comparison = latestVersion
		? compareStableSemver(latestVersion, options.currentVersion)
		: null;
	const updateAvailable = comparison !== null && comparison > 0;
	return {
		current_version: options.currentVersion,
		latest_version: latestVersion,
		update_available: updateAvailable,
		first_seen_at: resolution.record?.first_seen_at ?? null,
		checked_at: resolution.record?.checked_at ?? null,
		stale: resolution.stale,
		install_kind: options.installKind,
		auto_update_eligible:
			options.installKind === "npm-global" &&
			updateAvailable &&
			!resolution.stale &&
			resolution.error === null &&
			resolution.record !== null &&
			Date.parse(resolution.record.checked_at) - Date.parse(resolution.record.first_seen_at) >=
				AUTO_UPDATE_DELAY_MS,
		recommended_action: recommendedAction(
			options.installKind,
			options.currentVersion,
			latestVersion,
			updateAvailable,
		),
		error: resolution.error,
	};
}

export function createReleaseDiscovery(deps: ReleaseDiscoveryDependencies): ReleaseDiscovery {
	let inFlight: Promise<ReleaseResolution> | null = null;
	let memoryResolution: { resolution: ReleaseResolution; resolvedAtMs: number } | null = null;

	function canReuseMemoryResolution(now: Date): boolean {
		if (!memoryResolution) return false;
		const ageMs = Math.max(0, now.getTime() - memoryResolution.resolvedAtMs);
		const { resolution } = memoryResolution;
		if (resolution.record && !resolution.stale && isFresh(resolution.record, now)) return true;
		return resolution.error !== null && ageMs < FAILURE_RETRY_DELAY_MS;
	}

	async function refresh(cached: ReleaseCacheRecord | null, now: Date): Promise<ReleaseResolution> {
		try {
			const latestVersion = await fetchLatestVersion(deps);
			const timestamp = now.toISOString();
			const record: ReleaseCacheRecord = {
				schema_version: RELEASE_CACHE_SCHEMA_VERSION,
				latest_version: latestVersion,
				checked_at: timestamp,
				first_seen_at: cached?.latest_version === latestVersion ? cached.first_seen_at : timestamp,
			};
			try {
				await deps.writeCacheAtomic(JSON.stringify(record));
				return { record, stale: false, error: null };
			} catch (error) {
				return {
					record,
					stale: false,
					error: `cache write failed: ${errorMessage(error)}`,
				};
			}
		} catch (error) {
			return { record: cached, stale: cached !== null, error: errorMessage(error) };
		}
	}

	return {
		async check(options): Promise<UpdateStatus> {
			const now = deps.now();
			let cached: ReleaseCacheRecord | null = null;
			let cacheReadError: string | null = null;
			try {
				cached = parseCache(await deps.readCache(), now);
			} catch (error) {
				cacheReadError = `cache read failed: ${errorMessage(error)}`;
			}
			if (!options.refresh && cached && isFresh(cached, now)) {
				return toStatus({ record: cached, stale: false, error: null }, options);
			}
			if (!options.refresh && canReuseMemoryResolution(now) && memoryResolution) {
				const resolution = memoryResolution.resolution;
				return toStatus(
					cacheReadError && !resolution.error
						? { ...resolution, error: cacheReadError }
						: resolution,
					options,
				);
			}
			if (!inFlight) {
				inFlight = refresh(cached, now).finally(() => {
					inFlight = null;
				});
			}
			const resolution = await inFlight;
			memoryResolution = { resolution, resolvedAtMs: deps.now().getTime() };
			return toStatus(
				cacheReadError && !resolution.error ? { ...resolution, error: cacheReadError } : resolution,
				options,
			);
		},
	};
}

function defaultCachePath(): string {
	return join(codememHomeDir(), ".codemem", "release-discovery.json");
}

export function createReleaseCacheIo(cachePath: string): ReleaseCacheIo {
	const directory = dirname(cachePath);
	return {
		async readCache(): Promise<string | null> {
			try {
				return await readFile(cachePath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		},
		async writeCacheAtomic(contents: string): Promise<void> {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const temporaryPath = join(
				directory,
				`.release-discovery.${process.pid}.${randomUUID()}.tmp`,
			);
			let handle: Awaited<ReturnType<typeof open>> | null = null;
			try {
				handle = await open(temporaryPath, "wx", 0o600);
				await handle.writeFile(contents, "utf8");
				await handle.sync();
				await handle.close();
				handle = null;
				await rename(temporaryPath, cachePath);
			} catch (error) {
				await handle?.close().catch(() => undefined);
				await unlink(temporaryPath).catch(() => undefined);
				throw error;
			}
		},
	};
}

function isPinnedSource(source: string): boolean {
	if (!source || source.length > MAX_RUNNER_SOURCE_LENGTH) return false;
	const containsWhitespace = (value: string): boolean => {
		for (const character of value) {
			if (character.trim() === "") return true;
		}
		return false;
	};
	const normalized = source.toLowerCase();
	if (normalized.startsWith("codemem@")) {
		const requested = source.slice("codemem@".length);
		return (
			requested.length > 0 &&
			!containsWhitespace(requested) &&
			!["latest", "next", "*"].includes(requested.toLowerCase())
		);
	}
	if (!source.startsWith("git+") && !source.includes(".git")) return false;
	const queryIndex = source.indexOf("?");
	const fragmentIndex = source.indexOf("#");
	const boundaryIndexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
	const boundary = boundaryIndexes.length > 0 ? Math.min(...boundaryIndexes) : source.length;
	const withoutQuery = source.slice(0, boundary);
	const gitRefIndex = withoutQuery.toLowerCase().lastIndexOf(".git@");
	const gitRef = gitRefIndex >= 0 ? withoutQuery.slice(gitRefIndex + ".git@".length) : "";
	if (gitRef.length > 0 && !gitRef.includes("/") && !containsWhitespace(gitRef)) return true;
	const fragment = fragmentIndex >= 0 ? source.slice(fragmentIndex + 1) : "";
	return fragment.length > 0 && !containsWhitespace(fragment);
}

export function detectInstallKind(input: InstallDetectionInput): InstallKind {
	const env = input.env ?? {};
	const source = env.CODEMEM_RUNNER_FROM?.trim() ?? "";
	if (isPinnedSource(source)) return "pinned";

	const entryPath = input.entryPath.replaceAll("\\", "/");
	if (/\/packages\/cli\/src\/index\.ts$/.test(entryPath)) return "repo-dev";

	const explicit = env.CODEMEM_INSTALL_KIND?.trim().toLowerCase();
	const knownKinds: readonly InstallKind[] = [
		"npm-global",
		"npx",
		"docker",
		"repo-dev",
		"pinned",
		"unknown",
	];
	if (explicit) {
		if (!knownKinds.includes(explicit as InstallKind)) return "unknown";
		// An environment marker may safely narrow permissions, but it must never
		// authorize process execution on its own.
		if (["docker", "repo-dev", "pinned", "unknown"].includes(explicit)) {
			return explicit as InstallKind;
		}
	}

	const runner = env.CODEMEM_RUNNER?.trim().toLowerCase();
	if (runner === "node" || runner === "uv") return "repo-dev";

	if (/\/(?:_npx|\.pnpm\/dlx)\//.test(entryPath)) return "npx";
	if (/\/lib\/node_modules\/codemem\/dist\/index\.js$/.test(entryPath)) {
		return "npm-global";
	}
	if (/\/AppData\/Roaming\/npm\/node_modules\/codemem\/dist\/index\.js$/i.test(entryPath)) {
		return "npm-global";
	}
	return "unknown";
}

const defaultReleaseDiscovery = createReleaseDiscovery({
	fetch: (url, init) => fetch(url, init),
	now: () => new Date(),
	readCache: () => createReleaseCacheIo(defaultCachePath()).readCache(),
	writeCacheAtomic: (contents) =>
		createReleaseCacheIo(defaultCachePath()).writeCacheAtomic(contents),
	timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
});

export interface GetUpdateStatusOptions {
	currentVersion: string;
	installKind?: InstallKind;
	refresh?: boolean;
}

export function getUpdateStatus(options: GetUpdateStatusOptions): Promise<UpdateStatus> {
	return defaultReleaseDiscovery.check({
		currentVersion: options.currentVersion,
		installKind: options.installKind ?? "unknown",
		refresh: options.refresh,
	});
}
