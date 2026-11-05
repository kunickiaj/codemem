// Shared pieces of the relay host acceptance run. Every key is generated per run
// and written only under the run's directory in the repository's ignored .tmp/.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

export interface Identity {
	readonly deviceId: string;
	readonly publicKey: string;
	readonly privateKey: string;
	/** Base64 PKCS#8, the form the Worker secrets take. */
	readonly pkcs8: string;
}

export function newIdentity(deviceId: string): Identity {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	return {
		deviceId,
		publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
		privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
		pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
	};
}

export const GROUPS = ["team-a", "team-b"] as const;
export type GroupId = (typeof GROUPS)[number];

/** Scopes and their members. Probe scopes hold only the health probe device. */
export function fixtureScopes(ids: Fixture["ids"]) {
	return {
		"work-a": { groupId: "team-a", members: [ids.source.deviceId, ids.targetB.deviceId] },
		"personal-a": { groupId: "team-a", members: [ids.source.deviceId] },
		"work-b": { groupId: "team-b", members: [ids.source.deviceId, ids.targetC.deviceId] },
		"probe-a": { groupId: "team-a", members: [ids.probe.deviceId] },
		"probe-b": { groupId: "team-b", members: [ids.probe.deviceId] },
	} as const;
}

export const PROBE_SCOPES: Record<GroupId, string> = { "team-a": "probe-a", "team-b": "probe-b" };

/** Everything a relay host needs before it starts. */
export interface Fixture {
	readonly origin: string;
	readonly coordinatorId: string;
	readonly authorityId: string;
	readonly runDir: string;
	readonly adminSecret: string;
	readonly ids: {
		readonly service: Identity;
		readonly probe: Identity;
		readonly source: Identity;
		readonly targetB: Identity;
		readonly targetC: Identity;
	};
}

export function newIdentities(): Fixture["ids"] {
	return {
		service: newIdentity("relay-service"),
		probe: newIdentity("relay-health-probe"),
		source: newIdentity("device-a"),
		targetB: newIdentity("device-b"),
		targetC: newIdentity("device-c"),
	};
}

export interface ReadinessRow {
	readonly scope: string;
	readonly group_id: string;
	readonly state: string;
}

export interface RelayCounters {
	readonly routes: number;
	readonly queuedBytes: number;
	readonly trafficQuotaAborts: number;
}

/**
 * One relay deployment under test. The run puts a TLS front at the fixture origin
 * that forwards HTTP to `httpPort` and relay upgrades, through a fault proxy, to
 * `relayUpstream(group)`.
 */
export interface RelayHostUnderTest {
	readonly name: string;
	readonly httpPort: number;
	relayUpstream(groupId: GroupId): string;
	readiness(): Promise<ReadinessRow[]>;
	counters(groupId: GroupId): Promise<RelayCounters | null>;
	/** The host's operator switch for one realm. */
	disableRealm(groupId: GroupId): Promise<void>;
	dispose(): Promise<void>;
}

/** The directory store calls both coordinator stores share. */
export interface DirectoryStore {
	createGroup(groupId: string, displayName?: string): Promise<unknown>;
	enrollDevice(
		groupId: string,
		device: { deviceId: string; publicKey: string; fingerprint: string },
	): Promise<unknown>;
	createScope(scope: {
		scopeId: string;
		groupId: string;
		coordinatorId: string;
		label: string;
		kind: string;
		authorityType: string;
		status: string;
		membershipEpoch: number;
	}): Promise<unknown>;
	grantScopeMembership(grant: {
		scopeId: string;
		deviceId: string;
		membershipEpoch: number;
		effectId: string;
	}): Promise<unknown>;
}

/** Groups, enrolled devices and managed Spaces, as an operator would create them. */
export async function seedDirectory(
	store: DirectoryStore,
	fixture: Fixture,
	fingerprint: (publicKey: string) => string,
): Promise<void> {
	const { ids } = fixture;
	const enroll = (groupId: string, identity: Identity) =>
		store.enrollDevice(groupId, {
			deviceId: identity.deviceId,
			publicKey: identity.publicKey,
			fingerprint: fingerprint(identity.publicKey),
		});
	for (const groupId of GROUPS) {
		await store.createGroup(groupId, groupId);
		await enroll(groupId, ids.source);
		await enroll(groupId, ids.probe);
	}
	await enroll("team-a", ids.targetB);
	await enroll("team-b", ids.targetC);
	for (const [scopeId, scope] of Object.entries(fixtureScopes(ids))) {
		await store.createScope({
			scopeId,
			groupId: scope.groupId,
			coordinatorId: fixture.coordinatorId,
			label: scopeId,
			kind: "managed_project",
			authorityType: "coordinator",
			status: "active",
			membershipEpoch: 1,
		});
		for (const deviceId of scope.members)
			await store.grantScopeMembership({ scopeId, deviceId, membershipEpoch: 1, effectId: randomUUID() });
	}
}

export async function listenLoopback(server: Server, port = 0): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address !== "object") throw new Error("listener has no port");
	return address.port;
}

export async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

export async function freePort(): Promise<number> {
	const probe = createServer();
	const port = await listenLoopback(probe);
	await closeServer(probe);
	return port;
}

export function writePrivate(dir: string, name: string, value: unknown): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, name);
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), {
		mode: 0o600,
		flag: "wx",
	});
	return path;
}

export function emit(stage: string, fields: Record<string, unknown> = {}): void {
	process.stdout.write(`${JSON.stringify({ stage, ...fields })}\n`);
}

/**
 * Gives this process its own HOME, config and key directory, and drops inherited
 * CODEMEM_* settings, before any core module loads.
 */
export function isolateProcess(home: string): void {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	for (const name of Object.keys(process.env))
		if (name.startsWith("CODEMEM_")) delete process.env[name];
	process.env.HOME = home;
	process.env.CODEMEM_CONFIG = join(home, "absent-config.json");
	process.env.CODEMEM_KEYS_DIR = join(home, "keys");
	process.env.CODEMEM_SYNC_KEY_STORE = "file";
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
}

/** What the run passes to each target peer process. */
export interface PeerInput {
	readonly name: string;
	readonly home: string;
	readonly origin: string;
	readonly coordinatorId: string;
	readonly identity: Identity;
	readonly source: { readonly deviceId: string; readonly publicKey: string };
	readonly servicePublicKey: string;
	readonly groupId: GroupId;
	readonly otherGroupId: GroupId;
	readonly workScope: string;
	readonly directPort: number;
	readonly controlPort: number;
}
