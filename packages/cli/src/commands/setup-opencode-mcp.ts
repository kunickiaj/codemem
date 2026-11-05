/**
 * OpenCode MCP entry handling for `codemem setup`.
 *
 * The OpenCode plugin serves memory tools through the shared viewer, so setup
 * no longer installs a per-project `codemem mcp` stdio entry by default. These
 * helpers recognize the entries setup used to write, in both config shapes:
 *
 * - V1: `mcp.codemem = { type: "local", command: [...], enabled: true }`
 * - V2: `mcp.servers.codemem = { type: "local", command: [...] }`
 *
 * Only entries whose fields all match what setup itself wrote are "managed".
 * Anything a user customized is reported and left in place.
 */

export type OpencodeMcpShape = "v1" | "v2";

export interface OpencodeMcpLauncher {
	command: string;
	args: string[];
}

/** Commands setup has written for OpenCode, across releases. */
const MANAGED_COMMANDS: readonly (readonly string[])[] = [
	["codemem", "mcp"],
	["npx", "-y", "--package", "codemem", "--package", "@codemem/embeddings", "codemem", "mcp"],
	["npx", "-y", "codemem", "mcp"],
	["npx", "codemem", "mcp"],
];

/** Fields setup writes (V1 `enabled`, V2 `disabled`); any other field is user data. */
const MANAGED_FIELDS = new Set(["type", "command", "enabled", "disabled"]);

const V1_CONTAINER_PATH = ["mcp"];
const V2_CONTAINER_PATH = ["mcp", "servers"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((entry, index) => entry === expected[index])
	);
}

/** Python-era uv/uvx launchers, matched as loosely as setup always has. */
export function isLegacyUvOpencodeCommand(command: unknown): boolean {
	if (typeof command === "string") return command === "uvx" || command === "uv";
	return (
		Array.isArray(command) &&
		command.some((arg) => typeof arg === "string" && (arg === "uvx" || arg === "uv"))
	);
}

/** Older single-package npx launchers that `--opencode-mcp stdio` upgrades in place. */
export function isSinglePackageNpxOpencodeCommand(command: unknown): boolean {
	return (
		isExactStringArray(command, ["npx", "-y", "codemem", "mcp"]) ||
		isExactStringArray(command, ["npx", "codemem", "mcp"])
	);
}

export function isManagedOpencodeMcpCommand(command: unknown): boolean {
	return (
		isLegacyUvOpencodeCommand(command) ||
		MANAGED_COMMANDS.some((expected) => isExactStringArray(command, expected))
	);
}

/**
 * True when `mcp.servers` is the V2 server map. V1 configs could in theory name
 * a server "servers"; a value that itself looks like a server entry is V1.
 */
function isV2ServerMap(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && !("type" in value) && !("command" in value) && !("url" in value);
}

export function usesV2OpencodeMcpShape(config: Record<string, unknown>): boolean {
	return isRecord(config.mcp) && isV2ServerMap(config.mcp.servers);
}

export interface OpencodeMcpEntryLocation {
	shape: OpencodeMcpShape;
	/** Container holding the `codemem` key. Mutating it edits `config`. */
	container: Record<string, unknown>;
	/** Dotted config path of the entry, for user-facing messages. */
	label: string;
}

/** Find every `codemem` MCP entry in the config, V1 first. */
export function locateOpencodeMcpEntries(
	config: Record<string, unknown>,
): OpencodeMcpEntryLocation[] {
	const mcp = config.mcp;
	if (!isRecord(mcp)) return [];
	const found: OpencodeMcpEntryLocation[] = [];
	if ("codemem" in mcp) found.push({ shape: "v1", container: mcp, label: "mcp.codemem" });
	const servers = mcp.servers;
	if (isV2ServerMap(servers) && "codemem" in servers) {
		found.push({ shape: "v2", container: servers, label: "mcp.servers.codemem" });
	}
	return found;
}

/**
 * Explain why an entry is not one setup manages, or return null when it is.
 * The reason completes the sentence "Left <entry> in place because ...".
 */
export function describeUnmanagedOpencodeMcpEntry(entry: unknown): string | null {
	if (!isRecord(entry)) return "it is not an object";
	if (entry.type === "remote") return "it points to a remote server";
	if (entry.type !== undefined && entry.type !== "local") {
		return `it uses type ${JSON.stringify(entry.type)}`;
	}
	if ("environment" in entry) return "it sets environment variables";
	if ("cwd" in entry) return "it sets a working directory";
	if (!isManagedOpencodeMcpCommand(entry.command)) return "it runs a custom command";
	const extraFields = Object.keys(entry).filter((key) => !MANAGED_FIELDS.has(key));
	if (extraFields.length > 0) return `it sets ${extraFields.join(", ")}`;
	return null;
}

export interface OpencodeMcpCleanup {
	config: Record<string, unknown>;
	removed: string[];
	kept: { label: string; reason: string }[];
}

export interface RemoveOpencodeMcpOptions {
	/**
	 * Whether an emptied container at this path may be deleted. The caller uses
	 * it to keep containers that hold comments, which deletion would discard.
	 */
	canDropEmptyContainer: (path: string[]) => boolean;
}

function dropEmptyContainers(
	config: Record<string, unknown>,
	cleanup: OpencodeMcpCleanup,
	{ canDropEmptyContainer }: RemoveOpencodeMcpOptions,
): void {
	const mcp = config.mcp;
	if (!isRecord(mcp)) return;
	const removedV2 = cleanup.removed.includes("mcp.servers.codemem");
	const servers = mcp.servers;
	if (
		removedV2 &&
		isRecord(servers) &&
		Object.keys(servers).length === 0 &&
		canDropEmptyContainer(V2_CONTAINER_PATH)
	) {
		delete mcp.servers;
	}
	if (Object.keys(mcp).length === 0 && canDropEmptyContainer(V1_CONTAINER_PATH)) {
		delete config.mcp;
	}
}

/** Deep-copy the parts of the config this module may edit. */
function cloneMcpContainers(config: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(config.mcp)) return { ...config };
	const mcp: Record<string, unknown> = { ...config.mcp };
	if (isV2ServerMap(mcp.servers)) mcp.servers = { ...mcp.servers };
	return { ...config, mcp };
}

/**
 * Remove managed codemem MCP entries from both config shapes. Returns a new
 * config; the input is not mutated. Containers emptied by the removal are
 * deleted only when they held nothing but the codemem entry and the caller
 * allows it.
 */
export function removeManagedOpencodeMcp(
	config: Record<string, unknown>,
	options: RemoveOpencodeMcpOptions,
): OpencodeMcpCleanup {
	const next = cloneMcpContainers(config);
	const cleanup: OpencodeMcpCleanup = { config: next, removed: [], kept: [] };
	for (const location of locateOpencodeMcpEntries(next)) {
		const reason = describeUnmanagedOpencodeMcpEntry(location.container.codemem);
		if (reason != null) {
			cleanup.kept.push({ label: location.label, reason });
			continue;
		}
		delete location.container.codemem;
		cleanup.removed.push(location.label);
	}
	if (cleanup.removed.length > 0) dropEmptyContainers(next, cleanup, options);
	return cleanup;
}

/** The stdio entry `--opencode-mcp stdio` writes, in the file's config shape. */
export function buildOpencodeStdioMcpEntry(
	shape: OpencodeMcpShape,
	launcher: OpencodeMcpLauncher,
): Record<string, unknown> {
	const command = [launcher.command, ...launcher.args];
	// V2 uses `disabled` instead of `enabled`; servers connect unless disabled.
	if (shape === "v2") return { type: "local", command };
	return { type: "local", command, enabled: true };
}
