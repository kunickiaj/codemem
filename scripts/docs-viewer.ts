import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHILD_MARKER = "CODEMEM_DOCS_VIEWER_CHILD";
const FIXTURE_ROOT_ENV = "CODEMEM_DOCS_VIEWER_ROOT";
const FIXTURE_REVISION = "current working tree, including generated viewer assets";
const FIXTURE_ROOT_PATTERN = /^codemem-docs-viewer-[A-Za-z0-9]{6}$/;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const SERVER_CLOSE_TIMEOUT_MS = 2_000;

interface RuntimePaths {
	root: string;
	runtime: string;
	db: string;
	config: string;
	keys: string;
}

interface FixtureMemory {
	kind: "bugfix" | "decision" | "discovery";
	title: string;
	subtitle: string;
	body: string;
	tags: string[];
	filesRead: string[];
	filesModified: string[];
	concepts: string[];
	facts: string[];
}

interface ViewerServer {
	close: (callback: (error?: Error) => void) => void;
	closeAllConnections: () => void;
	closeIdleConnections: () => void;
	once: (event: "error", listener: (error: Error) => void) => void;
}

interface LaunchMessage {
	type: "launch";
	root: string;
	tempParent: string;
}

type ServeViewer = (
	options: { fetch: (request: Request) => unknown; hostname: string; port: number },
	listeningListener: (info: { port: number }) => void,
) => ViewerServer;

function runtimePaths(root: string): RuntimePaths {
	return {
		root,
		runtime: join(root, "runtime"),
		db: join(root, "runtime", "mem.sqlite"),
		config: join(root, "runtime", "config", "codemem.json"),
		keys: join(root, "runtime", "keys"),
	};
}

function createRuntimePaths(): RuntimePaths {
	const paths = runtimePaths(mkdtempSync(join(tmpdir(), "codemem-docs-viewer-")));
	for (const path of ["home", "tmp", "xdg/config", "xdg/cache", "xdg/data"]) {
		mkdirSync(join(paths.root, path), { recursive: true });
	}
	for (const path of [paths.runtime, paths.keys, dirname(paths.config)]) {
		mkdirSync(path, { recursive: true });
	}
	return paths;
}

function loaderArgs(execArgv: string[]): string[] {
	const loaderFlags = new Set(["--experimental-loader", "--import", "--loader", "--require", "-r"]);
	const loaderPrefixes = ["--experimental-loader=", "--import=", "--loader=", "--require="];
	const inherited: string[] = [];
	for (let index = 0; index < execArgv.length; index += 1) {
		const arg = execArgv[index];
		if (arg === "--conditions" && execArgv[index + 1] === "source") {
			inherited.push(arg, "source");
			index += 1;
			continue;
		}
		if (arg === "--conditions=source") {
			inherited.push(arg);
			continue;
		}
		if (loaderPrefixes.some((prefix) => arg.startsWith(prefix)) && arg.includes("tsx")) {
			inherited.push(arg);
			continue;
		}
		if (!loaderFlags.has(arg)) continue;
		const value = execArgv[index + 1];
		if (!value) throw new Error(`Missing value for inherited Node argument ${arg}`);
		if (value.includes("tsx")) inherited.push(arg, value);
		index += 1;
	}
	const hasSourceCondition = inherited.some(
		(arg, index) =>
			arg === "--conditions=source" ||
			(arg === "--conditions" && inherited[index + 1] === "source"),
	);
	if (!hasSourceCondition) {
		inherited.unshift("--conditions=source");
	}
	return inherited;
}

function childEnvironment(paths: RuntimePaths): NodeJS.ProcessEnv {
	return {
		[CHILD_MARKER]: "1",
		[FIXTURE_ROOT_ENV]: paths.root,
		HOME: join(paths.root, "home"),
		USER: "demo",
		LOGNAME: "demo",
		TMPDIR: join(paths.root, "tmp"),
		XDG_CONFIG_HOME: join(paths.root, "xdg", "config"),
		XDG_CACHE_HOME: join(paths.root, "xdg", "cache"),
		XDG_DATA_HOME: join(paths.root, "xdg", "data"),
		CODEMEM_RUNTIME_ROOT: paths.runtime,
		CODEMEM_DB: paths.db,
		CODEMEM_CONFIG: paths.config,
		CODEMEM_KEYS_DIR: paths.keys,
		CODEMEM_DEVICE_ID: "docs-fixture-device",
		CODEMEM_ACTOR_ID: "docs-fixture-actor",
		CODEMEM_ACTOR_DISPLAY_NAME: "Demo Developer",
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_EMBEDDING_OFFLINE: "1",
		CODEMEM_RAW_EVENTS_SWEEPER: "0",
		CODEMEM_SYNC_KEY_STORE: "file",
		CODEMEM_SYNC_MDNS: "0",
	};
}

async function launchIsolatedChild(): Promise<void> {
	const paths = createRuntimePaths();
	const scriptPath = fileURLToPath(import.meta.url);
	const child = spawn(process.execPath, [...loaderArgs(process.execArgv), scriptPath], {
		env: childEnvironment(paths),
		stdio: ["inherit", "inherit", "inherit", "ipc"],
	});
	let launched = false;
	child.on("message", (message) => {
		if (launched || !message || typeof message !== "object") return;
		if (!("type" in message) || message.type !== "ready") return;
		launched = true;
		child.send({ type: "launch", root: paths.root, tempParent: dirname(paths.root) });
	});

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => child.kill(signal));
	}

	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				process.exitCode = signal === "SIGINT" ? 130 : 143;
			} else {
				process.exitCode = code ?? 1;
			}
			resolve();
		});
	});
}

async function receiveLaunchMessage(): Promise<LaunchMessage> {
	if (!process.connected || typeof process.send !== "function") {
		throw new Error("Synthetic viewer child requires its parent IPC channel");
	}
	return new Promise<LaunchMessage>((resolveMessage, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Synthetic viewer parent handshake timed out")),
			HANDSHAKE_TIMEOUT_MS,
		);
		process.once("message", (message) => {
			clearTimeout(timer);
			if (!message || typeof message !== "object" || !("type" in message)) {
				reject(new Error("Synthetic viewer parent sent an invalid launch message"));
				return;
			}
			const launch = message as Partial<LaunchMessage>;
			if (launch.type !== "launch" || typeof launch.root !== "string") {
				reject(new Error("Synthetic viewer parent sent an invalid launch message"));
				return;
			}
			if (typeof launch.tempParent !== "string") {
				reject(new Error("Synthetic viewer parent omitted its temp directory"));
				return;
			}
			resolveMessage(launch as LaunchMessage);
		});
		process.send?.({ type: "ready" });
	});
}

function loadRuntimePaths(launch: LaunchMessage): RuntimePaths {
	const root = resolve(launch.root);
	const tempParent = resolve(launch.tempParent);
	if (dirname(root) !== tempParent || !FIXTURE_ROOT_PATTERN.test(basename(root))) {
		throw new Error("Synthetic viewer parent supplied an invalid fixture root");
	}
	if (process.env[FIXTURE_ROOT_ENV] !== root) {
		throw new Error("Synthetic viewer environment does not match its parent handshake");
	}
	return runtimePaths(root);
}

function validateRuntimeEnvironment(paths: RuntimePaths): void {
	const expected = {
		HOME: join(paths.root, "home"),
		TMPDIR: join(paths.root, "tmp"),
		XDG_CONFIG_HOME: join(paths.root, "xdg", "config"),
		XDG_CACHE_HOME: join(paths.root, "xdg", "cache"),
		XDG_DATA_HOME: join(paths.root, "xdg", "data"),
		CODEMEM_RUNTIME_ROOT: paths.runtime,
		CODEMEM_DB: paths.db,
		CODEMEM_CONFIG: paths.config,
		CODEMEM_KEYS_DIR: paths.keys,
	};
	for (const [name, value] of Object.entries(expected)) {
		if (process.env[name] !== value) {
			throw new Error(`Synthetic viewer rejected mismatched ${name}`);
		}
	}
}

function prepareRuntime(paths: RuntimePaths): void {
	if (existsSync(paths.db)) {
		throw new Error(`Refusing to reuse synthetic viewer database: ${paths.db}`);
	}
	const config = {
		actor_id: "docs-fixture-actor",
		actor_display_name: "Demo Developer",
		observer_auth_source: "none",
		observer_tier_routing_enabled: false,
		sync_enabled: false,
		sync_mdns: false,
	};
	writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
}

function atlasMemories(): FixtureMemory[] {
	return [
		{
			kind: "decision",
			title: "Keep note parsing deterministic",
			subtitle: "Markdown structure is parsed before search indexing",
			body: "Atlas Notes parses headings, task markers, and wiki links in one deterministic pass. The index receives normalized text plus stable section anchors, so a re-index does not reorder otherwise unchanged notes.",
			tags: ["architecture", "markdown", "search"],
			filesRead: ["src/notes/parse-note.ts", "src/search/index-note.ts"],
			filesModified: ["docs/architecture/note-pipeline.md"],
			concepts: ["deterministic parsing", "stable anchors", "search indexing"],
			facts: [
				"Pipeline: parse → normalize → index",
				"Anchor format: heading slug plus source offset",
			],
		},
		{
			kind: "discovery",
			title: "Backlinks need normalized note identifiers",
			subtitle: "Display titles are not stable relationship keys",
			body: "Renaming a note changed its display title but not its file identity. Backlink edges remain correct when they use the normalized repository-relative note identifier and resolve the latest title only while rendering.",
			tags: ["backlinks", "data-model"],
			filesRead: ["src/graph/backlinks.ts", "src/notes/note-id.ts"],
			filesModified: [],
			concepts: ["backlinks", "note identity", "rename safety"],
			facts: [
				"Stable key: repository-relative note identifier",
				"Presentation: resolve title at render time",
			],
		},
		{
			kind: "bugfix",
			title: "Preserve task state during note refresh",
			subtitle: "Refresh no longer resets optimistic checkbox updates",
			body: "A background refresh could replace a locally toggled task with an older server snapshot. The client now retains pending task revisions until the matching write response arrives, then reconciles against the returned revision.",
			tags: ["tasks", "concurrency", "ui"],
			filesRead: ["src/tasks/task-state.ts", "src/api/save-task.ts"],
			filesModified: ["src/tasks/task-state.ts", "src/tasks/task-state.test.ts"],
			concepts: ["optimistic update", "revision", "background refresh"],
			facts: [
				"Cause: stale refresh replaced a pending local revision",
				"Fix: reconcile after the matching write response",
			],
		},
	];
}

function gardenMemories(): FixtureMemory[] {
	return [
		{
			kind: "decision",
			title: "Use cursor pagination for plant observations",
			subtitle: "Observation time and identifier form the stable cursor",
			body: "Garden API pages observations by descending observed time with the observation identifier as a deterministic tie-breaker. Clients can request the next page without skipped or duplicated rows when new observations arrive.",
			tags: ["api", "pagination", "observations"],
			filesRead: ["src/observations/list.ts", "src/http/cursors.ts"],
			filesModified: ["docs/api/observations.md"],
			concepts: ["cursor pagination", "stable ordering", "observation feed"],
			facts: ["Sort: observed_at DESC, observation_id DESC", "Page size: 50 by default"],
		},
		{
			kind: "discovery",
			title: "Sensor timestamps can arrive out of order",
			subtitle: "Ingestion time cannot stand in for observation time",
			body: "Offline greenhouse sensors upload buffered readings after reconnecting. Reports must group by the sensor-provided observation time while retaining ingestion time for operational diagnostics and replay analysis.",
			tags: ["sensors", "timestamps", "ingestion"],
			filesRead: ["src/sensors/ingest-reading.ts", "src/reports/daily-summary.ts"],
			filesModified: [],
			concepts: ["event time", "ingestion time", "offline sensors"],
			facts: ["Reporting clock: sensor observation time", "Diagnostic clock: API ingestion time"],
		},
		{
			kind: "bugfix",
			title: "Reject duplicate watering commands",
			subtitle: "Retries now reuse an idempotency record",
			body: "A timed-out client retry could schedule the same watering command twice. The endpoint now stores the request key with the first command result and returns that result for later retries within the retention window.",
			tags: ["idempotency", "watering", "retries"],
			filesRead: ["src/watering/create-command.ts", "src/storage/idempotency.ts"],
			filesModified: ["src/watering/create-command.ts", "src/watering/create-command.test.ts"],
			concepts: ["idempotency", "retry safety", "watering command"],
			facts: ["Cause: timeout hid the first successful write", "Retention: 24 hours"],
		},
	];
}

function seedProject(
	store: InstanceType<typeof import("../packages/core/src/index.ts")["MemoryStore"]>,
	project: string,
	cwd: string,
	memories: FixtureMemory[],
): number {
	const sessionId = store.startSession({
		cwd,
		project,
		user: "demo",
		toolVersion: "docs-fixture",
		metadata: { fixture: "docs-viewer", synthetic: true },
	});
	for (const [index, memory] of memories.entries()) {
		store.remember(
			sessionId,
			memory.kind,
			memory.title,
			memory.body,
			0.9 - index * 0.05,
			memory.tags,
			{
				visibility: "private",
				workspace_kind: "personal",
				workspace_id: "personal:docs-fixture-actor",
				origin_source: "docs-fixture",
				subtitle: memory.subtitle,
				narrative: memory.body,
				facts: memory.facts,
				concepts: memory.concepts,
				files_read: memory.filesRead,
				files_modified: memory.filesModified,
				prompt_number: index + 1,
			},
		);
	}
	store.endSession(sessionId, { fixture: "docs-viewer", memory_count: memories.length });
	return memories.length;
}

function denyExternalFetch(): void {
	const systemFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
			throw new Error(`Synthetic docs viewer blocked outbound fetch to ${url.origin}`);
		}
		return systemFetch(input, init);
	};
}

async function loadServeViewer(): Promise<ServeViewer> {
	const requireFromViewer = createRequire(
		new URL("../packages/viewer-server/package.json", import.meta.url),
	);
	const moduleUrl = pathToFileURL(requireFromViewer.resolve("@hono/node-server"));
	const loaded: unknown = await import(moduleUrl.href);
	if (!loaded || typeof loaded !== "object" || !("serve" in loaded)) {
		throw new Error("@hono/node-server did not export serve");
	}
	const serve = (loaded as { serve?: unknown }).serve;
	if (typeof serve !== "function") throw new Error("@hono/node-server serve export is invalid");
	return serve as ServeViewer;
}

async function closeServer(server: ViewerServer): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			server.closeAllConnections();
			finish();
		}, SERVER_CLOSE_TIMEOUT_MS);
		server.close((error) => {
			finish(error);
		});
		server.closeIdleConnections();
	});
}

function offlineUpdateStatus(
	currentVersion: string,
): import("../packages/core/src/index.ts").UpdateStatus {
	return {
		current_version: currentVersion,
		channel: null,
		latest_version: null,
		update_available: false,
		first_seen_at: null,
		checked_at: null,
		stale: false,
		install_kind: "repo-dev",
		auto_update_eligible: false,
		recommended_action: "Offline synthetic fixture; update checks are disabled.",
		error: null,
	};
}

function printFixture(paths: RuntimePaths, port: number, memoryCount: number): void {
	console.log(
		JSON.stringify(
			{
				url: `http://127.0.0.1:${port}`,
				runtime: paths.root,
				database: paths.db,
				memories: memoryCount,
				fixture_revision: FIXTURE_REVISION,
				synthetic_only: true,
			},
			null,
			2,
		),
	);
}

async function waitForShutdown(): Promise<void> {
	await new Promise<void>((resolve) => {
		for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, resolve);
	});
}

async function runFixture(): Promise<void> {
	const launch = await receiveLaunchMessage();
	const paths = loadRuntimePaths(launch);
	validateRuntimeEnvironment(paths);
	prepareRuntime(paths);
	denyExternalFetch();

	const [{ initDatabase, MemoryStore, VERSION }, { createApp }, serve] = await Promise.all([
		import("../packages/core/src/index.ts"),
		import("../packages/viewer-server/src/index.ts"),
		loadServeViewer(),
	]);
	initDatabase(paths.db);
	const store = new MemoryStore(paths.db);
	let server: ViewerServer | null = null;
	try {
		const memoryCount =
			seedProject(store, "atlas-notes", "/demo/atlas-notes", atlasMemories()) +
			seedProject(store, "garden-api", "/demo/garden-api", gardenMemories());
		const app = createApp({
			storeFactory: () => store,
			observer: null,
			sweeper: null,
			getSyncRuntimeStatus: () => ({ phase: "disabled", detail: "Synthetic docs fixture" }),
			getUpdateStatus: async () => offlineUpdateStatus(VERSION),
		});

		const started = await new Promise<{ server: ViewerServer; port: number }>((resolve, reject) => {
			const candidate = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
				resolve({ server: candidate, port: info.port }),
			);
			candidate.once("error", reject);
		});
		server = started.server;
		printFixture(paths, started.port, memoryCount);
		await waitForShutdown();
	} finally {
		try {
			if (server) await closeServer(server);
		} finally {
			store.close();
		}
	}
}

async function main(): Promise<void> {
	if (process.env[CHILD_MARKER] === "1") {
		await runFixture();
		return;
	}
	await launchIsolatedChild();
}

void main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
