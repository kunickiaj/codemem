import * as p from "@clack/prompts";
import {
	applyBootstrapSnapshot,
	buildBaseUrl,
	buildDirectPeerAuthHeaders,
	DeviceIdentityError,
	ensureDeviceIdentity,
	fetchAllSnapshotPages,
	hasUnsyncedSharedMemoryChanges,
	MemoryStore,
	peerTransportBlocker,
	peerTransportExecutor,
	type RequestJsonExecutor,
	resolveDbPath,
	schema,
} from "@codemem/core";
import { Command, Option } from "commander";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { helpStyle } from "../help-style.js";
import { addDbOption, addJsonOption, emitJsonError, resolveDbOpt } from "../shared-options.js";

export interface SyncBootstrapOptions {
	peer?: string;
	bootstrapGrant?: string;
	pageSize: string;
	db?: string;
	dbPath?: string;
	keysDir?: string;
	force?: boolean;
	json?: boolean;
}

/** Direct Noise activation. Defaults to the shared switch; tests turn it on. */
export interface SyncBootstrapTransport {
	directNoise?: { active?: boolean };
}

type Boundary = { generation: number; snapshot_id: string; baseline_cursor: string | null };
type AddressResult = { address: string; result: string };
type Peer = typeof schema.syncPeers.$inferSelect;

interface BootstrapContext {
	store: MemoryStore;
	opts: SyncBootstrapOptions;
	peerDeviceId: string;
	deviceId: string;
	keysDir: string | undefined;
	/** One executor for the status and every snapshot page, so status-first holds. */
	execute: RequestJsonExecutor;
}

function reportError(opts: SyncBootstrapOptions, code: string, message: string, exitCode = 1) {
	if (opts.json) {
		emitJsonError(code, message, exitCode);
		return;
	}
	p.log.error(message);
	process.exitCode = exitCode;
}

/** The pinned peer to bootstrap from, or null after reporting why it can't be used. */
function bootstrapPeer(store: MemoryStore, peerDeviceId: string, opts: SyncBootstrapOptions) {
	const peer = drizzle(store.db, { schema })
		.select()
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.get();
	if (!peer) {
		reportError(opts, "peer_not_found", `Peer ${peerDeviceId} not found in sync_peers.`);
		return null;
	}
	if (!peer.pinned_fingerprint) {
		const message = `Peer ${peerDeviceId} has no pinned fingerprint. Accept it first.`;
		reportError(opts, "peer_not_pinned", message);
		return null;
	}
	return peer;
}

/**
 * Once direct Noise is on, a peer pinned by fingerprint alone can't be
 * reached. Say how to fix it before any request, including a grant's, leaves.
 */
function peerKeyReady(
	store: MemoryStore,
	peer: Peer,
	opts: SyncBootstrapOptions,
	transport: SyncBootstrapTransport,
): boolean {
	if (!peerTransportBlocker(store.db, peer.peer_device_id, transport.directNoise)) return true;
	const label = peer.name || peer.peer_device_id;
	const message = `Peer ${label} has no saved public key, so codemem can't open an encrypted connection to it. On that device, run \`codemem sync pair --payload-only\` and save the output. Then run \`codemem sync pair --accept-file <file>\` here. The payload's public key must match the pinned fingerprint.`;
	reportError(opts, "peer_key_missing", message);
	return false;
}

function localStateIsClean(store: MemoryStore, opts: SyncBootstrapOptions): boolean {
	if (opts.force) return true;
	const dirty = hasUnsyncedSharedMemoryChanges(store.db);
	if (!dirty.dirty) return true;
	const message = `${dirty.count} unsynced shared memory change(s) would be lost. Use --force to override.`;
	reportError(opts, "local_unsynced_changes", message);
	return false;
}

function resetBoundary(payload: Record<string, unknown>): Boundary | null {
	const reset = payload.sync_reset as Record<string, unknown> | undefined;
	if (!reset || typeof reset.generation !== "number" || typeof reset.snapshot_id !== "string")
		return null;
	return {
		generation: reset.generation,
		snapshot_id: reset.snapshot_id,
		baseline_cursor: typeof reset.baseline_cursor === "string" ? reset.baseline_cursor : null,
	};
}

/** Asks one address for its status. Returns the reset boundary or why the address failed. */
async function statusAt(
	context: BootstrapContext,
	peer: Peer,
	baseUrl: string,
): Promise<Boundary | string> {
	const statusUrl = `${baseUrl}/v1/status`;
	const headers = buildDirectPeerAuthHeaders({
		deviceId: context.deviceId,
		recipientId: context.peerDeviceId,
		dbPath: context.store.dbPath,
		method: "GET",
		url: statusUrl,
		bodyBytes: Buffer.alloc(0),
		bootstrapGrantId: context.opts.bootstrapGrant,
		keysDir: context.keysDir,
	});
	try {
		const [code, payload] = await context.execute("GET", statusUrl, {
			operation: "status",
			headers,
		});
		if (code !== 200 || !payload) return `status ${code}`;
		if (payload.fingerprint !== peer.pinned_fingerprint) return "fingerprint mismatch";
		return resetBoundary(payload) ?? "missing sync_reset boundary";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

async function findBoundary(context: BootstrapContext, peer: Peer, addresses: string[]) {
	const addressResults: AddressResult[] = [];
	for (const address of addresses) {
		const baseUrl = buildBaseUrl(address);
		if (!baseUrl) continue;
		const outcome = await statusAt(context, peer, baseUrl);
		if (typeof outcome === "string") {
			addressResults.push({ address: baseUrl, result: outcome });
			continue;
		}
		addressResults.push({ address: baseUrl, result: "ok" });
		return { boundary: outcome, baseUrl, addressResults };
	}
	return { boundary: null, baseUrl: "", addressResults };
}

function reportUnreachable(opts: SyncBootstrapOptions, addressResults: AddressResult[]) {
	const summary = addressResults.map((r) => `${r.address}: ${r.result}`).join("; ");
	const detail = summary
		? `no reachable peer with valid reset boundary. Tried: ${summary}`
		: "peer unreachable or missing reset boundary";
	if (opts.json) {
		console.log(JSON.stringify({ ok: false, error: detail, addresses: addressResults }));
	} else {
		p.log.error(detail);
	}
	process.exitCode = 1;
}

function reportApplied(
	opts: SyncBootstrapOptions,
	result: ReturnType<typeof applyBootstrapSnapshot>,
) {
	if (opts.json) {
		const { ok, applied, deleted } = result;
		console.log(JSON.stringify({ ok, applied, deleted, error: result.error ?? null }));
	} else {
		if (result.ok) {
			p.log.success(`Applied ${result.applied} memories (removed ${result.deleted} stale).`);
		} else {
			p.log.error(result.error || "Bootstrap apply failed.");
		}
		p.outro(result.ok ? "Bootstrap complete" : "Bootstrap failed");
	}
	if (!result.ok) process.exitCode = 1;
}

async function copyFromPeer(
	context: BootstrapContext,
	peer: Peer,
	boundary: Boundary,
	baseUrl: string,
) {
	const { opts, store, peerDeviceId } = context;
	if (!opts.json) {
		p.intro("codemem sync bootstrap");
		p.log.step(`Bootstrapping from ${peer.name || peerDeviceId}...`);
	}
	const resetInfo = {
		...boundary,
		retained_floor_cursor: null,
		reset_required: true as const,
		reason: "initial_bootstrap" as const,
	};
	const { items } = await fetchAllSnapshotPages(baseUrl, resetInfo, context.deviceId, {
		keysDir: context.keysDir,
		dbPath: store.dbPath,
		bootstrapGrantId: opts.bootstrapGrant,
		recipientId: peerDeviceId,
		pageSize: Math.max(1, Number.parseInt(opts.pageSize, 10) || 2000),
		requestExecutor: context.execute,
	});
	reportApplied(
		opts,
		applyBootstrapSnapshot(store.db, peerDeviceId, items, resetInfo, store.scanner),
	);
}

/**
 * Every request goes through the shared transport policy. A bootstrap grant
 * rides along so a noise_required seed can pin this device before Noise.
 */
function bootstrapExecutor(
	store: MemoryStore,
	ids: { peerDeviceId: string; deviceId: string },
	opts: SyncBootstrapOptions,
	transport: SyncBootstrapTransport,
): RequestJsonExecutor {
	const grant = opts.bootstrapGrant?.trim();
	return peerTransportExecutor({
		db: store.db,
		peerDeviceId: ids.peerDeviceId,
		localDeviceId: ids.deviceId,
		keysDir: opts.keysDir,
		dbPath: store.dbPath,
		bootstrapGrantId: grant || undefined,
		...transport.directNoise,
	});
}

async function bootstrapStore(
	store: MemoryStore,
	peerDeviceId: string,
	opts: SyncBootstrapOptions,
	transport: SyncBootstrapTransport,
) {
	const peer = bootstrapPeer(store, peerDeviceId, opts);
	if (!peer || !peerKeyReady(store, peer, opts, transport)) return;
	if (!localStateIsClean(store, opts)) return;
	const keysDir = opts.keysDir ?? undefined;
	const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
	const addresses = JSON.parse(String(peer.addresses_json ?? "[]")) as string[];
	if (!addresses.length) {
		const message = "Peer has no known addresses. Run a sync first or add addresses.";
		reportError(opts, "no_peer_addresses", message);
		return;
	}
	const execute = bootstrapExecutor(store, { peerDeviceId, deviceId }, opts, transport);
	const context = { store, opts, peerDeviceId, deviceId, keysDir, execute };
	const found = await findBoundary(context, peer, addresses);
	if (!found.boundary || !found.baseUrl) {
		reportUnreachable(opts, found.addressResults);
		return;
	}
	await copyFromPeer(context, peer, found.boundary, found.baseUrl);
}

export async function runSyncBootstrap(
	peerArg: string | undefined,
	opts: SyncBootstrapOptions,
	transport: SyncBootstrapTransport = {},
): Promise<void> {
	// Resolve peer from positional or hidden --peer alias
	const peerDeviceId = (peerArg || opts.peer || "").trim();
	if (!peerDeviceId) {
		reportError(opts, "usage_error", "missing required argument: <peer-device-id>", 2);
		return;
	}
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		await bootstrapStore(store, peerDeviceId, opts, transport);
	} catch (error) {
		const code = error instanceof DeviceIdentityError ? error.code : "bootstrap_failed";
		reportError(opts, code, error instanceof Error ? error.message : "Bootstrap failed");
	} finally {
		store.close();
	}
}

export function buildSyncBootstrapCommand(): Command {
	const command = new Command("bootstrap")
		.configureHelp(helpStyle)
		.description("Copy existing memories from a peer")
		.argument("[peer-device-id]", "peer device ID to bootstrap from")
		.option("--bootstrap-grant <grant-id>", "bootstrap grant id for seed-authorized bootstrap")
		.option("--page-size <n>", "items per snapshot page (default: 2000)", "2000")
		.option("--keys-dir <path>", "keys directory")
		.option("--force", "skip dirty-local-state safety check");
	addDbOption(command);
	addJsonOption(command);
	// Hidden alias for backwards compat
	command.addOption(new Option("--peer <device-id>", "peer device ID").hideHelp());
	command.action((peerArg: string | undefined, opts: SyncBootstrapOptions) =>
		runSyncBootstrap(peerArg, opts),
	);
	return command;
}
