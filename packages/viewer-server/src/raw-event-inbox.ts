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
	enqueue_order: string;
	request: Record<string, unknown>;
	flush_boundary: boolean;
}

interface LoadedRawEventInboxEntry {
	id: string;
	path: string;
	enqueueOrder: bigint;
	entry: RawEventInboxEntry;
}

interface RawEventInboxCandidate {
	path: string;
	id: string;
	enqueueOrder: bigint;
}

interface RawEventInboxScan {
	candidates: RawEventInboxCandidate[];
	corrupt: number;
	oldestMtimeMs: number;
	pending: number;
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

function entryContent(
	request: Record<string, unknown>,
	flushBoundary: boolean,
): Omit<StoredRawEventInboxEntry, "enqueue_order"> {
	return { version: 1, request, flush_boundary: flushBoundary };
}

function storedEntry(
	request: Record<string, unknown>,
	flushBoundary: boolean,
	enqueueOrder: bigint,
): StoredRawEventInboxEntry {
	return { ...entryContent(request, flushBoundary), enqueue_order: enqueueOrder.toString() };
}

function entryContentId(entry: RawEventInboxEntry): string {
	return contentId(JSON.stringify(entryContent(entry.request, entry.flushBoundary)));
}

function inboxFileName(enqueueOrder: bigint, id: string): string {
	return `${enqueueOrder.toString().padStart(24, "0")}-${id}.json`;
}

function parseInboxFileName(name: string): { id: string; enqueueOrder: bigint } | null {
	const match = /^(\d+)-([a-f0-9]{64})\.json$/u.exec(name);
	if (!match?.[1] || !match[2]) return null;
	const enqueueOrder = BigInt(match[1]);
	if (enqueueOrder < 1n) return null;
	return { id: match[2], enqueueOrder };
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

function parseStoredEntry(serialized: string): {
	entry: RawEventInboxEntry;
	enqueueOrder: bigint;
} {
	const parsed = JSON.parse(serialized) as Partial<StoredRawEventInboxEntry>;
	if (
		parsed.version !== 1 ||
		typeof parsed.enqueue_order !== "string" ||
		!/^[1-9]\d*$/u.test(parsed.enqueue_order) ||
		parsed.request == null ||
		typeof parsed.request !== "object" ||
		Array.isArray(parsed.request) ||
		typeof parsed.flush_boundary !== "boolean"
	) {
		throw new Error("invalid raw-event inbox entry");
	}
	return {
		entry: { request: parsed.request, flushBoundary: parsed.flush_boundary },
		enqueueOrder: BigInt(parsed.enqueue_order),
	};
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
	private nextEnqueueOrder: bigint | null = null;
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
		const flushBoundary = options.flushBoundary === true;
		const id = entryContentId({ request, flushBoundary });
		await ensurePrivateDirectory(this.directory);
		const entries = await readdir(this.directory, { withFileTypes: true });
		const existingEntry = entries.find(
			(entry) => entry.isFile() && parseInboxFileName(entry.name)?.id === id,
		);
		if (existingEntry) {
			const existing = await readFile(join(this.directory, existingEntry.name), "utf8");
			const parsedExisting = parseStoredEntry(existing);
			const existingName = parseInboxFileName(existingEntry.name);
			if (
				entryContentId(parsedExisting.entry) !== id ||
				existingName?.enqueueOrder !== parsedExisting.enqueueOrder
			) {
				throw new Error("raw-event inbox entry conflict");
			}
			await chmod(join(this.directory, existingEntry.name), 0o600);
			await syncDirectory(this.directory);
			this.scheduleDrain();
			return;
		}

		const count = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
		if (count >= this.maxEntries) {
			const error = new Error("raw-event inbox is full") as Error & { code?: string };
			error.code = RAW_EVENT_INBOX_FULL_CODE;
			throw error;
		}
		const enqueueOrder = await this.allocateEnqueueOrder(entries);
		const serialized = JSON.stringify(storedEntry(request, flushBoundary, enqueueOrder));
		const destination = join(this.directory, inboxFileName(enqueueOrder, id));
		const temporary = join(this.directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);

		try {
			await writeDurableFile(temporary, serialized);
			try {
				await link(temporary, destination);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = await readFile(destination, "utf8");
				const parsedExisting = parseStoredEntry(existing);
				if (
					entryContentId(parsedExisting.entry) !== id ||
					parsedExisting.enqueueOrder !== enqueueOrder
				) {
					throw new Error("raw-event inbox entry conflict");
				}
			}
			await chmod(destination, 0o600);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
		await syncDirectory(this.directory);
		this.scheduleDrain();
	}

	private async allocateEnqueueOrder(entries: Dirent[]): Promise<bigint> {
		if (this.nextEnqueueOrder != null) {
			const order = this.nextEnqueueOrder;
			this.nextEnqueueOrder += 1n;
			return order;
		}
		let highestOrder = 0n;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const parsed = parseInboxFileName(entry.name);
			if (parsed && parsed.enqueueOrder > highestOrder) highestOrder = parsed.enqueueOrder;
		}
		const order = highestOrder + 1n;
		this.nextEnqueueOrder = order + 1n;
		return order;
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
		const scan = await this.scanCandidates(directoryEntries);
		scan.candidates.sort((left, right) => {
			if (left.enqueueOrder < right.enqueueOrder) return -1;
			if (left.enqueueOrder > right.enqueueOrder) return 1;
			return left.id.localeCompare(right.id);
		});
		const entries: LoadedRawEventInboxEntry[] = [];
		let corrupt = scan.corrupt;
		for (const candidate of scan.candidates) {
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
			oldestAgeMs: Number.isFinite(scan.oldestMtimeMs)
				? Math.max(0, Date.now() - scan.oldestMtimeMs)
				: 0,
			pending: scan.pending,
		};
	}

	private async scanCandidates(directoryEntries: Dirent[]): Promise<RawEventInboxScan> {
		const candidates: RawEventInboxCandidate[] = [];
		let corrupt = 0;
		let oldestMtimeMs = Number.POSITIVE_INFINITY;
		let pending = 0;
		for (const directoryEntry of directoryEntries) {
			if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(".json")) continue;
			const path = join(this.directory, directoryEntry.name);
			try {
				const details = await stat(path);
				pending += 1;
				oldestMtimeMs = Math.min(oldestMtimeMs, details.mtimeMs);
				const parsed = parseInboxFileName(directoryEntry.name);
				if (!parsed) {
					corrupt += 1;
					continue;
				}
				candidates.push({
					path,
					...parsed,
				});
			} catch {
				// A concurrent drain removed the entry.
			}
		}
		return { candidates, corrupt, oldestMtimeMs, pending };
	}

	private async loadEntry(
		candidate: RawEventInboxCandidate,
	): Promise<LoadedRawEventInboxEntry | null> {
		try {
			const serialized = await readFile(candidate.path, "utf8");
			const { entry, enqueueOrder } = parseStoredEntry(serialized);
			const id = entryContentId(entry);
			if (candidate.id !== id || candidate.enqueueOrder !== enqueueOrder) return null;
			return { id, path: candidate.path, entry, enqueueOrder };
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
