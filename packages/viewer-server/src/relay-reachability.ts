import { createPrivateKey, type KeyObject } from "node:crypto";
import {
	type Database,
	fingerprintPublicKey,
	loadPrivateKey,
	type MemoryStore,
	type RequestJsonExecutor,
	readCoordinatorSyncConfig,
	recordSyncAttempt,
	setLocalSyncFeature,
} from "@codemem/core";
import {
	createRelayCoordinatorClient,
	createRelayPeerClient,
	createRelayPeerReachability,
	RELAY_LOGICAL_ORIGIN,
	type RelayGroupClientConfig,
	type RelayGroupResolution,
	type RelayPeerClient,
	type RelayPeerClientOptions,
	readRelayClientSettings,
	readRelayServicePin,
	relayCoordinatorEndpoint,
	resolveRelayGroup,
	type SyncPeerReachabilityResolver,
} from "@codemem/core/internal/relay-runtime";
import { createSyncChannelDispatcher } from "./sync-channel-dispatch.js";

export type RelayLogLevel = "info" | "warn";

export interface ViewerRelayReachabilityOptions {
	readonly store: MemoryStore;
	/** Device key directory. Defaults to `CODEMEM_KEYS_DIR`, then the standard key directory. */
	readonly keysDir?: string;
	/** Config record to read; defaults to the codemem config file plus environment overrides. */
	readonly config?: Record<string, unknown>;
	/** Cancels relay passes and registration maintenance that the daemon starts. */
	readonly signal?: AbortSignal;
	readonly log?: (message: string, level: RelayLogLevel) => void;
	/** Test seam that replaces the coordinator fetch and pin check for one group. */
	readonly resolveGroup?: (db: Database, groupId: string) => Promise<RelayGroupResolution>;
	/** Test seam for the `/v1/relay/info` request. */
	readonly request?: RequestJsonExecutor;
	/** Test seam for per-group pair pacing. Omitted groups and all other clocks stay native. */
	readonly pairPacingByGroup?: ReadonlyMap<string, RelayPeerClientOptions["pairPacing"]>;
	/** Disposable loopback fixtures only: allows `ws://` relay and `http://` admission on loopback. */
	readonly allowLoopback?: boolean;
}

export interface ViewerRelayReachability {
	/** Per-peer resolver for `runSyncDaemon({ reachability })`. */
	readonly reachability: SyncPeerReachabilityResolver;
	/** Re-resolves every group. Builds, closes, or revalidates clients. Never rejects. */
	refresh(): Promise<void>;
	/** Closes every client. Later refreshes do nothing. Never rejects. */
	close(): Promise<void>;
	/** The latest resolution status for each configured group. */
	status(): ReadonlyMap<string, RelayGroupResolution["status"]>;
}

interface GroupState {
	status: RelayGroupResolution["status"];
	client?: RelayPeerClient;
	clientKey?: string;
	servicePublicKey?: string;
	logged?: string;
	/** Set once a client has started, so later loss of relay is worth a warning. */
	everReady?: boolean;
}

/** Same rule as the sync daemon: an explicit directory, then `CODEMEM_KEYS_DIR`. */
function resolveKeysDir(keysDir?: string): string | undefined {
	return keysDir?.trim() || process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
}

function sameDevice(a: LocalDevice | null, b: LocalDevice | null): boolean {
	return a?.deviceId === b?.deviceId && a?.publicKey === b?.publicKey;
}

interface LocalDevice {
	readonly deviceId: string;
	readonly publicKey: string;
}

function readLocalDevice(db: Database): LocalDevice | null {
	const row = db.prepare("SELECT device_id, public_key FROM sync_device LIMIT 1").get() as
		| { device_id: string | null; public_key: string | null }
		| undefined;
	if (!row?.device_id || !row.public_key) return null;
	return { deviceId: row.device_id, publicKey: row.public_key.trim() };
}

/** The peer's stored key, only while it still matches the pinned fingerprint. */
function pinnedPeerKey(db: Database, peerDeviceId: string): string | null {
	const row = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as
		| { public_key: string | null; pinned_fingerprint: string | null }
		| undefined;
	const publicKey = row?.public_key?.trim();
	if (!publicKey || !row?.pinned_fingerprint) return null;
	return fingerprintPublicKey(publicKey) === row.pinned_fingerprint ? publicKey : null;
}

function clientKey(config: RelayGroupClientConfig): string {
	return `${config.url}\n${config.admissionUrl}\n${config.servicePublicKey}`;
}

function describe(resolution: RelayGroupResolution): string {
	if (resolution.status === "ready") return "ready";
	if (resolution.status === "paused")
		return "paused: the relay service key changed; approve it with `codemem sync approve-relay-key`";
	return `disabled: ${resolution.reason}`;
}

/**
 * A coordinator without relay is the normal case, so plain disabled states
 * stay at info until the group has relayed once. A changed key, an invalid
 * reply, or losing a group that worked are warnings.
 */
function levelFor(resolution: RelayGroupResolution, everReady: boolean): RelayLogLevel {
	if (resolution.status === "ready") return "info";
	if (resolution.status === "paused" || resolution.reason === "info_invalid") return "warn";
	return everReady ? "warn" : "info";
}

interface Deps {
	readonly options: ViewerRelayReachabilityOptions;
	readonly device: LocalDevice;
	readonly key: KeyObject;
	readonly dispatch: ReturnType<typeof createSyncChannelDispatcher>;
}

function buildClient(deps: Deps, config: RelayGroupClientConfig): RelayPeerClient {
	const { options, device } = deps;
	const db = options.store.db;
	return createRelayPeerClient({
		enabled: true,
		url: config.url,
		allowLoopbackWs: options.allowLoopback,
		servicePublicKey: config.servicePublicKey,
		deviceId: device.deviceId,
		localIdentity: { key: deps.key, expectedPin: device.publicKey },
		authorityId: config.authorityId,
		groupId: config.groupId,
		pairPacing: options.pairPacingByGroup?.get(config.groupId),
		relayAudienceId: config.relayAudienceId,
		externalPathname: config.externalPathname,
		coordinator: createRelayCoordinatorClient({
			url: config.admissionUrl,
			allowLoopbackHttp: options.allowLoopback,
		}),
		resolvePeerPin: (peerDeviceId) => pinnedPeerKey(db, peerDeviceId),
		validateLocal: () => sameDevice(readLocalDevice(db), device),
		onInboundFailure: (failure) => {
			const http = failure.httpCode ? ` http=${failure.httpCode}` : "";
			const diagnostic = `relay_target_failure stage=${failure.stage} reason=${failure.reason}${http}`;
			try {
				// An empty peer key keeps this identifier-free diagnostic out of individual peer health.
				// Do not update a real peer's last_error for an independent inbound exchange.
				recordSyncAttempt(db, "", {
					ok: false,
					error: diagnostic,
					failureCategory: "connectivity",
				});
			} catch {
				options.log?.("[codemem] relay target diagnostic could not be persisted", "warn");
			}
			options.log?.(`[codemem] ${diagnostic}`, "warn");
		},
		onInbound: (_connection, context) =>
			context.serve({ origin: RELAY_LOGICAL_ORIGIN, dispatch: deps.dispatch }),
	});
}

function loadDeps(options: ViewerRelayReachabilityOptions): Deps {
	const device = readLocalDevice(options.store.db);
	if (!device) throw new Error("device identity missing");
	const bytes = loadPrivateKey(options.keysDir, options.store.dbPath, device.deviceId);
	if (!bytes) throw new Error("device private key unavailable");
	const dispatch = createSyncChannelDispatcher({ storeFactory: () => options.store });
	return { options, device, key: createPrivateKey(bytes), dispatch };
}

function defaultResolver(
	options: ViewerRelayReachabilityOptions,
	coordinatorUrl: string,
	timeoutS: number,
) {
	const settings = readRelayClientSettings(options.config);
	return (db: Database, groupId: string) =>
		resolveRelayGroup(db, {
			coordinatorUrl,
			groupId,
			settings,
			deviceId: readLocalDevice(db)?.deviceId ?? "",
			dbPath: options.store.dbPath,
			keysDir: options.keysDir,
			timeoutS,
			signal: options.signal,
			request: options.request,
		});
}

function relayTargets(options: ViewerRelayReachabilityOptions) {
	if (!readRelayClientSettings(options.config).enabled) return null;
	const sync = readCoordinatorSyncConfig(options.config);
	const coordinatorUrl = sync.syncCoordinatorUrl.trim();
	if (!coordinatorUrl) return null;
	return { coordinatorUrl, timeoutS: sync.syncCoordinatorTimeoutS };
}

/**
 * The groups configured right now. Joining a group updates the config while
 * the viewer runs, so this is reread on every refresh. A different coordinator
 * yields no groups, because the resolver and pins belong to the startup one.
 */
function configuredGroupIds(
	options: ViewerRelayReachabilityOptions,
	coordinatorUrl: string,
): { groupIds: string[]; coordinatorChanged: boolean } {
	const sync = readCoordinatorSyncConfig(options.config);
	if (sync.syncCoordinatorUrl.trim() !== coordinatorUrl)
		return { groupIds: [], coordinatorChanged: true };
	return { groupIds: [...new Set(sync.syncCoordinatorGroups)], coordinatorChanged: false };
}

/** Owns one optional relay client per configured coordinator group. */
class RelayGroupClients {
	private readonly groups = new Map<string, GroupState>();
	private deps: Deps | undefined;
	private closed = false;
	private refreshing: Promise<void> | undefined;
	private coordinatorChangeLogged = false;

	constructor(
		private readonly options: ViewerRelayReachabilityOptions,
		private readonly coordinatorId: string,
		private readonly coordinatorUrl: string,
		private readonly resolve: (db: Database, groupId: string) => Promise<RelayGroupResolution>,
		private readonly log: (message: string, level: RelayLogLevel) => void,
	) {
		this.reconcileGroups();
	}

	clientForGroup(groupId: string): RelayPeerClient | undefined {
		return this.groups.get(groupId)?.client;
	}

	clients(): RelayPeerClient[] {
		return [...this.groups.values()].flatMap((state) => (state.client ? [state.client] : []));
	}

	status(): Map<string, RelayGroupResolution["status"]> {
		return new Map([...this.groups].map(([groupId, state]) => [groupId, state.status]));
	}

	refresh(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.refreshing ??= this.runRefresh()
			.catch((error) => this.log(`[codemem] relay refresh failed: ${String(error)}`, "warn"))
			.finally(() => {
				this.refreshing = undefined;
			});
		return this.refreshing;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.refreshing;
		await this.dropAll();
	}

	private async runRefresh(): Promise<void> {
		await this.checkDeviceIdentity();
		await Promise.all(this.reconcileGroups().map((state) => this.dropClient(state)));
		const ids = [...this.groups.keys()];
		const results = await Promise.all(ids.map((groupId) => this.resolveSafely(groupId)));
		for (const [index, groupId] of ids.entries()) {
			const resolution = results[index];
			if (resolution) await this.apply(groupId, resolution);
		}
	}

	/** Adds newly configured groups and removes dropped ones. Returns the removed states to close. */
	private reconcileGroups(): GroupState[] {
		let current: ReturnType<typeof configuredGroupIds>;
		try {
			current = configuredGroupIds(this.options, this.coordinatorUrl);
		} catch (error) {
			// An unreadable config keeps the groups already known.
			this.log(`[codemem] relay could not read the group list: ${String(error)}`, "warn");
			return [];
		}
		if (current.coordinatorChanged && !this.coordinatorChangeLogged) {
			this.coordinatorChangeLogged = true;
			this.log(
				"[codemem] sync coordinator changed; restart codemem serve to relay through it",
				"warn",
			);
		}
		const wanted = new Set(current.groupIds);
		const removed: GroupState[] = [];
		for (const [groupId, state] of this.groups) {
			if (wanted.has(groupId)) continue;
			this.groups.delete(groupId);
			removed.push(state);
		}
		for (const groupId of wanted)
			if (!this.groups.has(groupId)) this.groups.set(groupId, { status: "disabled" });
		return removed;
	}

	/** A changed local identity invalidates the cached key and every client built from it. */
	private async checkDeviceIdentity(): Promise<void> {
		if (!this.deps || sameDevice(readLocalDevice(this.options.store.db), this.deps.device)) return;
		this.deps = undefined;
		await this.dropAll();
		// Clearing the cache means the next change is detected only after a rebuild, so this logs once per change.
		this.log("[codemem] device identity changed; rebuilding relay clients", "warn");
	}

	private async resolveSafely(groupId: string): Promise<RelayGroupResolution> {
		try {
			return await this.resolve(this.options.store.db, groupId);
		} catch {
			return { status: "disabled", groupId, reason: "info_unavailable" };
		}
	}

	/** A transient info failure keeps a client whose key is still the stored pin. */
	private keepsClient(groupId: string, state: GroupState, resolution: RelayGroupResolution) {
		if (resolution.status !== "disabled" || resolution.reason !== "info_unavailable") return false;
		if (!state.client) return false;
		const pin = readRelayServicePin(this.options.store.db, this.coordinatorId, groupId);
		return pin?.state === "pinned" && pin.pinnedKey === state.servicePublicKey;
	}

	private async apply(groupId: string, resolution: RelayGroupResolution): Promise<void> {
		const state = this.groups.get(groupId);
		if (!state || this.closed) return;
		if (this.keepsClient(groupId, state, resolution)) {
			state.client?.revalidate();
			return;
		}
		state.status = resolution.status;
		if (resolution.status !== "ready") {
			await this.dropClient(state);
			this.report(groupId, state, describe(resolution), levelFor(resolution, !!state.everReady));
			return;
		}
		if (state.client && state.clientKey === clientKey(resolution.config)) {
			state.client.revalidate();
			return;
		}
		await this.dropClient(state);
		// close() may have run while the old client was closing.
		if (!this.closed) this.startClient(groupId, state, resolution.config);
	}

	private startClient(groupId: string, state: GroupState, config: RelayGroupClientConfig): void {
		try {
			this.deps ??= loadDeps(this.options);
			state.client = buildClient(this.deps, config);
			state.clientKey = clientKey(config);
			state.servicePublicKey = config.servicePublicKey;
			state.everReady = true;
			this.report(groupId, state, "ready", "info");
		} catch (error) {
			state.status = "disabled";
			const reason = error instanceof Error ? error.message : String(error);
			this.report(groupId, state, `disabled: ${reason}`, state.everReady ? "warn" : "info");
		}
	}

	private async dropAll(): Promise<void> {
		await Promise.all([...this.groups.values()].map((state) => this.dropClient(state)));
	}

	private async dropClient(state: GroupState): Promise<void> {
		const client = state.client;
		state.client = undefined;
		state.clientKey = undefined;
		state.servicePublicKey = undefined;
		await client?.close().catch(() => {});
	}

	/** Logs each group's state once per change, so a persistent failure is not repeated every refresh. */
	private report(groupId: string, state: GroupState, message: string, level: RelayLogLevel): void {
		if (state.logged === message) return;
		state.logged = message;
		this.log(`[codemem] relay for group ${groupId}: ${message}`, level);
	}
}

/**
 * Device relay clients for `codemem serve`, one per configured coordinator
 * group that the coordinator advertises and whose service key is pinned.
 * Returns null when relay is off or coordinator sync is not configured, so
 * callers keep plain direct sync. Failures leave only that group direct-only.
 */
export function createViewerRelayReachability(
	options: ViewerRelayReachabilityOptions,
): ViewerRelayReachability | null {
	const targets = relayTargets(options);
	// Peers that see this device only over direct sync learn whether relay can reach it.
	setLocalSyncFeature("relay", targets !== null);
	if (!targets) return null;
	const resolved = { ...options, keysDir: resolveKeysDir(options.keysDir) };
	const resolve =
		options.resolveGroup ?? defaultResolver(resolved, targets.coordinatorUrl, targets.timeoutS);
	const coordinatorId =
		relayCoordinatorEndpoint(targets.coordinatorUrl)?.coordinatorId ?? targets.coordinatorUrl;
	const groups = new RelayGroupClients(
		resolved,
		coordinatorId,
		targets.coordinatorUrl,
		resolve,
		options.log ?? (() => {}),
	);
	return {
		reachability: createRelayPeerReachability({
			coordinatorId,
			clientForGroup: (groupId) => groups.clientForGroup(groupId),
			clients: () => groups.clients(),
			signal: options.signal,
		}),
		refresh: () => groups.refresh(),
		close: () => groups.close(),
		status: () => groups.status(),
	};
}
