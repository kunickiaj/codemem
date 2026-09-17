import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	chmod,
	type FileHandle,
	link,
	mkdir,
	open,
	readdir,
	readFile,
	rm,
	stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ingestRawEvents, MemoryStore, type RawEventSweeper } from "@codemem/core";
import {
	flushRawEventBoundarySessions,
	isClaudeBoundaryEnvelope,
	nudgeRawEventSessions,
} from "./raw-event-processing.js";

const INBOX_DIRECTORY_NAME = "viewer-raw-event-inbox";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_BACKLOG_WARNING_AGE_MS = 30_000;
const DEFAULT_BACKLOG_WARNING_ENTRIES = 500;
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export const RAW_EVENT_INBOX_FULL_CODE = "raw_event_inbox_full";

export interface RawEventInboxEntry {
	request: Record<string, unknown>;
	flushBoundary: boolean;
}

interface StoredRawEventInboxEntry {
	version: 1;
	request: Record<string, unknown>;
	flush_boundary: boolean;
}

interface LoadedRawEventInboxEntry {
	id: string;
	path: string;
	entry: RawEventInboxEntry;
}

interface RawEventInboxCandidate {
	path: string;
	name: string;
	mtimeMs: number;
}

export interface RawEventInboxStatus {
	pending: number;
	corrupt: number;
	draining: boolean;
}

export interface RawEventInboxOptions {
	directory: string;
	processEntry: (entry: RawEventInboxEntry) => Promise<void>;
	batchSize?: number;
	maxEntries?: number;
	retryDelayMs?: number;
	backlogWarningAgeMs?: number;
	backlogWarningEntries?: number;
	onBacklog?: (pending: number, oldestAgeMs: number) => void;
	onBacklogRecovered?: () => void;
	onDrainError?: (error: unknown) => void;
	onDrainRecovered?: () => void;
	onCorruptEntries?: (count: number) => void;
}

export interface RawEventInbox {
	enqueue(request: Record<string, unknown>, options?: { flushBoundary?: boolean }): Promise<void>;
	start(): void;
	status(): Promise<RawEventInboxStatus>;
	stop(): Promise<void>;
}

function contentId(serialized: string): string {
	return createHash("sha256").update(serialized).digest("hex");
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}

export function resolveRawEventInboxDirectory(dbPath: string, homeDir: string = homedir()): string {
	const target = createHash("sha256").update(resolve(dbPath)).digest("hex").slice(0, 24);
	return join(homeDir, ".codemem", INBOX_DIRECTORY_NAME, target);
}

function storedEntry(
	request: Record<string, unknown>,
	flushBoundary: boolean,
): StoredRawEventInboxEntry {
	return { version: 1, request, flush_boundary: flushBoundary };
}

async function writeDurableFile(path: string, contents: string): Promise<void> {
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(contents, { encoding: "utf8" });
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (
			process.platform === "win32" &&
			["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")
		) {
			return;
		}
		throw error;
	} finally {
		await handle?.close();
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
	if (!firstCreated) return;
	const boundary = dirname(firstCreated);
	let current = path;
	while (true) {
		await syncDirectory(current);
		if (current === boundary) return;
		current = dirname(current);
	}
}

function parseStoredEntry(serialized: string): RawEventInboxEntry {
	const parsed = JSON.parse(serialized) as Partial<StoredRawEventInboxEntry>;
	if (
		parsed.version !== 1 ||
		parsed.request == null ||
		typeof parsed.request !== "object" ||
		Array.isArray(parsed.request) ||
		typeof parsed.flush_boundary !== "boolean"
	) {
		throw new Error("invalid raw-event inbox entry");
	}
	return { request: parsed.request, flushBoundary: parsed.flush_boundary };
}

export class FileRawEventInbox implements RawEventInbox {
	private readonly batchSize: number;
	private readonly backlogWarningAgeMs: number;
	private readonly backlogWarningEntries: number;
	private readonly directory: string;
	private readonly maxEntries: number;
	private readonly onDrainError: ((error: unknown) => void) | undefined;
	private readonly onDrainRecovered: (() => void) | undefined;
	private readonly onCorruptEntries: ((count: number) => void) | undefined;
	private readonly onBacklog: ((pending: number, oldestAgeMs: number) => void) | undefined;
	private readonly onBacklogRecovered: (() => void) | undefined;
	private readonly processEntry: (entry: RawEventInboxEntry) => Promise<void>;
	private readonly retryDelayMs: number;
	private drainPromise: Promise<void> | null = null;
	private degraded = false;
	private backlogDegraded = false;
	private enqueueChain: Promise<void> = Promise.resolve();
	private notedCorruptCount = 0;
	private pendingDrainDelayMs: number | null = null;
	private retryCount = 0;
	private timer: NodeJS.Timeout | null = null;
	private stopped = false;

	constructor(options: RawEventInboxOptions) {
		this.batchSize = normalizePositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
		this.backlogWarningAgeMs = normalizePositiveInteger(
			options.backlogWarningAgeMs,
			DEFAULT_BACKLOG_WARNING_AGE_MS,
		);
		this.backlogWarningEntries = normalizePositiveInteger(
			options.backlogWarningEntries,
			DEFAULT_BACKLOG_WARNING_ENTRIES,
		);
		this.directory = options.directory;
		this.maxEntries = normalizePositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
		this.onDrainError = options.onDrainError;
		this.onDrainRecovered = options.onDrainRecovered;
		this.onCorruptEntries = options.onCorruptEntries;
		this.onBacklog = options.onBacklog;
		this.onBacklogRecovered = options.onBacklogRecovered;
		this.processEntry = options.processEntry;
		this.retryDelayMs = normalizePositiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
	}

	async enqueue(
		request: Record<string, unknown>,
		options: { flushBoundary?: boolean } = {},
	): Promise<void> {
		const operation = this.enqueueChain.then(() => this.persist(request, options));
		this.enqueueChain = operation.catch(() => {});
		return operation;
	}

	private async persist(
		request: Record<string, unknown>,
		options: { flushBoundary?: boolean },
	): Promise<void> {
		const serialized = JSON.stringify(storedEntry(request, options.flushBoundary === true));
		const id = contentId(serialized);
		const destination = join(this.directory, `${id}.json`);
		const temporary = join(this.directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
		await ensurePrivateDirectory(this.directory);
		try {
			const existing = await readFile(destination, "utf8");
			if (existing !== serialized) throw new Error("raw-event inbox entry conflict");
			await chmod(destination, 0o600);
			await syncDirectory(this.directory);
			this.scheduleDrain();
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const entries = await readdir(this.directory, { withFileTypes: true });
		const count = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
		if (count >= this.maxEntries) {
			const error = new Error("raw-event inbox is full") as Error & { code?: string };
			error.code = RAW_EVENT_INBOX_FULL_CODE;
			throw error;
		}

		try {
			await writeDurableFile(temporary, serialized);
			try {
				await link(temporary, destination);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = await readFile(destination, "utf8");
				if (existing !== serialized) throw new Error("raw-event inbox entry conflict");
			}
			await chmod(destination, 0o600);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
		await syncDirectory(this.directory);
		this.scheduleDrain();
	}

	start(): void {
		this.scheduleDrain();
	}

	async status(): Promise<RawEventInboxStatus> {
		const loaded = await this.loadEntries(Number.POSITIVE_INFINITY);
		return {
			pending: loaded.entries.length,
			corrupt: loaded.corrupt,
			draining: this.drainPromise != null,
		};
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.pendingDrainDelayMs = null;
		await this.enqueueChain;
		await this.drainPromise;
	}

	private scheduleDrain(delayMs = 0): void {
		if (this.stopped || this.timer) return;
		if (this.drainPromise) {
			this.pendingDrainDelayMs = delayMs;
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			if (this.stopped || this.drainPromise) return;
			this.drainPromise = this.drain()
				.catch((error) => this.handleDrainFailure(error))
				.finally(() => {
					this.drainPromise = null;
					if (this.pendingDrainDelayMs != null) {
						const pendingDelayMs = this.pendingDrainDelayMs;
						this.pendingDrainDelayMs = null;
						this.scheduleDrain(pendingDelayMs);
					}
				});
		}, delayMs);
		this.timer.unref?.();
	}

	private async loadEntries(limit: number): Promise<{
		entries: LoadedRawEventInboxEntry[];
		corrupt: number;
		oldestAgeMs: number;
		pending: number;
	}> {
		let directoryEntries: Dirent[];
		try {
			directoryEntries = await readdir(this.directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { entries: [], corrupt: 0, oldestAgeMs: 0, pending: 0 };
			}
			throw error;
		}
		const candidates: RawEventInboxCandidate[] = [];
		for (const directoryEntry of directoryEntries) {
			if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(".json")) continue;
			const path = join(this.directory, directoryEntry.name);
			try {
				const details = await stat(path);
				candidates.push({ path, name: directoryEntry.name, mtimeMs: details.mtimeMs });
			} catch {
				// A concurrent drain removed the entry.
			}
		}
		candidates.sort(
			(left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
		);
		const entries: LoadedRawEventInboxEntry[] = [];
		let corrupt = 0;
		for (const candidate of candidates) {
			if (entries.length >= limit) break;
			const loadedEntry = await this.loadEntry(candidate);
			if (!loadedEntry) {
				corrupt += 1;
				continue;
			}
			entries.push(loadedEntry);
		}
		return {
			entries,
			corrupt,
			oldestAgeMs: candidates[0] ? Math.max(0, Date.now() - candidates[0].mtimeMs) : 0,
			pending: candidates.length,
		};
	}

	private async loadEntry(
		candidate: RawEventInboxCandidate,
	): Promise<LoadedRawEventInboxEntry | null> {
		try {
			const serialized = await readFile(candidate.path, "utf8");
			const id = contentId(serialized);
			if (candidate.name !== `${id}.json`) return null;
			return { id, path: candidate.path, entry: parseStoredEntry(serialized) };
		} catch {
			return null;
		}
	}

	private async drain(): Promise<void> {
		const loaded = await this.loadEntries(this.batchSize);
		const backlogExceeded =
			loaded.pending >= this.backlogWarningEntries &&
			loaded.oldestAgeMs >= this.backlogWarningAgeMs;
		if (backlogExceeded && !this.backlogDegraded) {
			this.backlogDegraded = true;
			this.onBacklog?.(loaded.pending, loaded.oldestAgeMs);
		} else if (!backlogExceeded && this.backlogDegraded) {
			this.backlogDegraded = false;
			this.onBacklogRecovered?.();
		}
		if (loaded.corrupt !== this.notedCorruptCount) {
			this.notedCorruptCount = loaded.corrupt;
			if (loaded.corrupt > 0) this.onCorruptEntries?.(loaded.corrupt);
		}
		for (const loadedEntry of loaded.entries) {
			await this.processEntry(loadedEntry.entry);
			await rm(loadedEntry.path, { force: true });
		}
		this.retryCount = 0;
		if (this.degraded) {
			this.degraded = false;
			this.onDrainRecovered?.();
		}
		if (loaded.entries.length > 0) this.scheduleDrain();
	}

	private handleDrainFailure(error: unknown): void {
		if (!this.degraded) {
			this.degraded = true;
			this.onDrainError?.(error);
		}
		this.retryCount += 1;
		const delay = Math.min(this.retryDelayMs * 2 ** (this.retryCount - 1), MAX_RETRY_DELAY_MS);
		this.scheduleDrain(delay);
	}
}

export function createViewerRawEventInbox(options: {
	dbPath: string;
	sweeper?: RawEventSweeper | null;
	homeDir?: string;
	onDrainError?: (error: unknown) => void;
	onDrainRecovered?: () => void;
	onCorruptEntries?: (count: number) => void;
	onBacklog?: (pending: number, oldestAgeMs: number) => void;
	onBacklogRecovered?: () => void;
}): { inbox: RawEventInbox; stop: () => Promise<void> } {
	const store = new MemoryStore(options.dbPath);
	store.db.pragma("busy_timeout = 25");
	const inbox = new FileRawEventInbox({
		directory: resolveRawEventInboxDirectory(options.dbPath, options.homeDir),
		onDrainError: options.onDrainError,
		onDrainRecovered: options.onDrainRecovered,
		onCorruptEntries: options.onCorruptEntries,
		onBacklog: options.onBacklog,
		onBacklogRecovered: options.onBacklogRecovered,
		processEntry: async ({ request, flushBoundary }) => {
			const result = ingestRawEvents(store, request);
			nudgeRawEventSessions(options.sweeper, result.sessions);
			if (flushBoundary && isClaudeBoundaryEnvelope(request)) {
				await flushRawEventBoundarySessions(options.sweeper, result.sessions);
			}
		},
	});
	return {
		inbox,
		stop: async () => {
			await inbox.stop();
			store.close();
		},
	};
}
