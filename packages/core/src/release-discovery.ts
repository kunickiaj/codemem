import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codememHomeDir } from "./home.js";

const REGISTRY_URL_PREFIX = "https://registry.npmjs.org/codemem/";
const REQUEST_TIMEOUT_MS = 2_000;
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const FAILURE_RETRY_DELAY_MS = 15 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const MAX_VERSION_LENGTH = 128;
const MAX_RUNNER_SOURCE_LENGTH = 4_096;
const RELEASE_CACHE_SCHEMA_VERSION = 2;
const AUTO_UPDATE_DELAY_MS = 24 * 60 * 60 * 1_000;
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type InstallKind = "npm-global" | "npx" | "docker" | "repo-dev" | "pinned" | "unknown";
export type ReleaseChannel = "alpha" | "beta" | "rc" | "latest";

export interface UpdateStatus {
	current_version: string;
	channel: ReleaseChannel | null;
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
	channel: ReleaseChannel;
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

interface ParsedSemver {
	core: [number, number, number];
	prerelease: string[];
}

interface ReleaseDiscoveryState {
	inFlight: Map<ReleaseChannel, Promise<ReleaseResolution>>;
	memoryResolutions: Map<ReleaseChannel, { resolution: ReleaseResolution; resolvedAtMs: number }>;
}

function parseSemver(value: unknown): ParsedSemver | null {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_VERSION_LENGTH) {
		return null;
	}
	const match = SEMVER.exec(value);
	if (!match) return null;
	const parts = match.slice(1, 4).map(Number);
	if (!parts.every(Number.isSafeInteger)) return null;
	const prerelease = match[4]?.split(".") ?? [];
	if (prerelease.some((identifier) => /^\d+$/.test(identifier) && /^0\d/.test(identifier))) {
		return null;
	}
	return { core: parts as [number, number, number], prerelease };
}

export function releaseChannelForVersion(value: unknown): ReleaseChannel | null {
	const parsed = parseSemver(value);
	if (!parsed) return null;
	if (parsed.prerelease.length === 0) return "latest";
	const channel = parsed.prerelease[0];
	return channel === "alpha" || channel === "beta" || channel === "rc" ? channel : null;
}

export function isReleaseVersionForChannel(
	value: unknown,
	channel: ReleaseChannel,
): value is string {
	return releaseChannelForVersion(value) === channel;
}

export function isStableReleaseVersion(value: unknown): value is string {
	return releaseChannelForVersion(value) === "latest";
}

function comparePrereleaseIdentifier(left: string | undefined, right: string | undefined): number {
	if (left === undefined) return right === undefined ? 0 : -1;
	if (right === undefined) return 1;
	if (left === right) return 0;
	const leftNumeric = /^\d+$/.test(left);
	const rightNumeric = /^\d+$/.test(right);
	if (leftNumeric && rightNumeric && left.length !== right.length) {
		return Math.sign(left.length - right.length);
	}
	if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
	return left < right ? -1 : 1;
}

function comparePrerelease(left: string[], right: string[]): number {
	if (left.length === 0) return right.length === 0 ? 0 : 1;
	if (right.length === 0) return -1;
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const comparison = comparePrereleaseIdentifier(left[index], right[index]);
		if (comparison !== 0) return comparison;
	}
	return 0;
}

function compareSemver(left: string, right: string): number | null {
	const leftVersion = parseSemver(left);
	const rightVersion = parseSemver(right);
	if (!leftVersion || !rightVersion) return null;
	for (const index of [0, 1, 2] as const) {
		const difference = leftVersion.core[index] - rightVersion.core[index];
		if (difference !== 0) return Math.sign(difference);
	}
	return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function parseIsoTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value ? value : null;
}

function parseCache(
	contents: string | null,
	now: Date,
	channel: ReleaseChannel,
): ReleaseCacheRecord | null {
	if (contents === null) return null;
	try {
		const value: unknown = JSON.parse(contents);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const candidate = value as Record<string, unknown>;
		const isLegacyStableCache = candidate.schema_version === 1 && channel === "latest";
		if (!isLegacyStableCache && candidate.schema_version !== RELEASE_CACHE_SCHEMA_VERSION)
			return null;
		const cachedChannel = isLegacyStableCache ? "latest" : candidate.channel;
		if (cachedChannel !== channel) return null;
		const latestVersion =
			typeof candidate.latest_version === "string" &&
			isReleaseVersionForChannel(candidate.latest_version, channel)
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
			channel,
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

async function fetchLatestVersion(
	deps: ReleaseDiscoveryDependencies,
	channel: ReleaseChannel,
): Promise<string> {
	const registryUrl = `${REGISTRY_URL_PREFIX}${channel}`;
	const response = await deps.fetch(registryUrl, {
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
		if (finalUrl.href !== registryUrl) {
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
	if (typeof version !== "string" || !isReleaseVersionForChannel(version, channel)) {
		throw new Error("invalid registry version");
	}
	return version;
}

function recommendedAction(
	installKind: InstallKind,
	currentVersion: string,
	latestVersion: string | null,
	updateAvailable: boolean,
	channel: ReleaseChannel | null,
): string {
	if (!channel || !isReleaseVersionForChannel(currentVersion, channel)) {
		return "Verify the current codemem version and try again.";
	}
	if (!latestVersion) return "Check network access and try again.";
	if (!updateAvailable) {
		const releaseLabel = channel === "latest" ? "stable" : channel;
		return `No action required; codemem is on the latest ${releaseLabel} release.`;
	}
	switch (installKind) {
		case "npm-global":
			return `${process.platform === "linux" ? "env ONNXRUNTIME_NODE_INSTALL=skip " : ""}npm install -g codemem@${latestVersion}`;
		case "npx":
			return `Update your launcher to request codemem@${latestVersion} and @codemem/embeddings@${latestVersion} together.`;
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

function toStatus(
	resolution: ReleaseResolution,
	options: ReleaseCheckOptions,
	channel: ReleaseChannel | null,
): UpdateStatus {
	const latestVersion = resolution.record?.latest_version ?? null;
	const comparison = latestVersion ? compareSemver(latestVersion, options.currentVersion) : null;
	const updateAvailable = comparison !== null && comparison > 0;
	return {
		current_version: options.currentVersion,
		channel,
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
			channel,
		),
		error: resolution.error,
	};
}

function canReuseMemoryResolution(
	state: ReleaseDiscoveryState,
	channel: ReleaseChannel,
	now: Date,
): boolean {
	const memoryResolution = state.memoryResolutions.get(channel);
	if (!memoryResolution) return false;
	const ageMs = Math.max(0, now.getTime() - memoryResolution.resolvedAtMs);
	const { resolution } = memoryResolution;
	if (resolution.record && !resolution.stale && isFresh(resolution.record, now)) return true;
	return resolution.error !== null && ageMs < FAILURE_RETRY_DELAY_MS;
}

async function refreshRelease(
	deps: ReleaseDiscoveryDependencies,
	cached: ReleaseCacheRecord | null,
	now: Date,
	channel: ReleaseChannel,
): Promise<ReleaseResolution> {
	try {
		const latestVersion = await fetchLatestVersion(deps, channel);
		const timestamp = now.toISOString();
		const record: ReleaseCacheRecord = {
			schema_version: RELEASE_CACHE_SCHEMA_VERSION,
			channel,
			latest_version: latestVersion,
			checked_at: timestamp,
			first_seen_at: cached?.latest_version === latestVersion ? cached.first_seen_at : timestamp,
		};
		try {
			await deps.writeCacheAtomic(JSON.stringify(record));
			return { record, stale: false, error: null };
		} catch (error) {
			return { record, stale: false, error: `cache write failed: ${errorMessage(error)}` };
		}
	} catch (error) {
		return { record: cached, stale: cached !== null, error: errorMessage(error) };
	}
}

function withCacheReadError(
	resolution: ReleaseResolution,
	cacheReadError: string | null,
): ReleaseResolution {
	return cacheReadError && !resolution.error
		? { ...resolution, error: cacheReadError }
		: resolution;
}

async function readReleaseCache(
	deps: ReleaseDiscoveryDependencies,
	now: Date,
	channel: ReleaseChannel,
): Promise<{ cached: ReleaseCacheRecord | null; error: string | null }> {
	try {
		return { cached: parseCache(await deps.readCache(), now, channel), error: null };
	} catch (error) {
		return { cached: null, error: `cache read failed: ${errorMessage(error)}` };
	}
}

async function checkRelease(
	deps: ReleaseDiscoveryDependencies,
	state: ReleaseDiscoveryState,
	options: ReleaseCheckOptions,
): Promise<UpdateStatus> {
	const now = deps.now();
	const channel = releaseChannelForVersion(options.currentVersion);
	if (!channel) {
		return toStatus(
			{ record: null, stale: false, error: "unsupported installed release channel" },
			options,
			null,
		);
	}
	const cache = await readReleaseCache(deps, now, channel);
	if (!options.refresh && cache.cached && isFresh(cache.cached, now)) {
		return toStatus({ record: cache.cached, stale: false, error: null }, options, channel);
	}
	const memoryResolution = state.memoryResolutions.get(channel);
	if (!options.refresh && memoryResolution && canReuseMemoryResolution(state, channel, now)) {
		return toStatus(withCacheReadError(memoryResolution.resolution, cache.error), options, channel);
	}
	let request = state.inFlight.get(channel);
	if (!request) {
		request = refreshRelease(deps, cache.cached, now, channel).finally(() => {
			state.inFlight.delete(channel);
		});
		state.inFlight.set(channel, request);
	}
	const resolution = await request;
	state.memoryResolutions.set(channel, { resolution, resolvedAtMs: deps.now().getTime() });
	return toStatus(withCacheReadError(resolution, cache.error), options, channel);
}

export function createReleaseDiscovery(deps: ReleaseDiscoveryDependencies): ReleaseDiscovery {
	const state: ReleaseDiscoveryState = {
		inFlight: new Map(),
		memoryResolutions: new Map(),
	};
	return { check: (options) => checkRelease(deps, state, options) };
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

	let entryPath = input.entryPath;
	if (entryPath) {
		try {
			entryPath = realpathSync(entryPath);
		} catch {
			// Preserve synthetic, removed, and otherwise unresolved paths for the
			// existing pattern checks below.
		}
	}
	entryPath = entryPath.replaceAll("\\", "/");
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
