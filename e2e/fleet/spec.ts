import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type FleetRuntimeType = "compose" | "workspace";
export type IdentityPolicy = "stable" | "ephemeral";
export type StoragePersistence = "durable" | "ephemeral";

export interface FleetRuntimeTarget {
	type: FleetRuntimeType;
	service?: string;
	selector?: string;
	config_path?: string;
	db_path?: string;
	keys_path?: string;
	bootstrap_hook?: string;
}

export interface FleetWorkerSpec {
	id: string;
	runtime: FleetRuntimeTarget;
	identity: IdentityPolicy;
}

export interface FleetSwarmSpec {
	id: string;
	coordinator_group: string;
	seed_peer: string;
	workers: FleetWorkerSpec[];
}

export interface FleetSpec {
	fleet: {
		name: string;
		mode: string;
	};
	seed_peer: {
		id: string;
		runtime: FleetRuntimeTarget;
		identity: "stable";
		storage: {
			kind: "sqlite";
			persistence: StoragePersistence;
		};
	};
	coordinator: {
		mode: "shared";
		runtime: FleetRuntimeTarget;
		cleanup: {
			stale_after_minutes: number;
			expire_after_minutes: number;
		};
	};
	swarms: FleetSwarmSpec[];
}

function assertCondition(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function asObject(value: unknown, message: string): Record<string, unknown> {
	assertCondition(value && typeof value === "object" && !Array.isArray(value), message);
	return value as Record<string, unknown>;
}

function asString(value: unknown, message: string): string {
	assertCondition(typeof value === "string" && value.trim().length > 0, message);
	return value.trim();
}

function asNumber(value: unknown, message: string): number {
	assertCondition(typeof value === "number" && Number.isFinite(value), message);
	return value;
}

function parseRuntimeTarget(value: unknown, messagePrefix: string): FleetRuntimeTarget {
	const raw = asObject(value, `${messagePrefix} must be an object`);
	const type = asString(raw.type, `${messagePrefix}.type must be a non-empty string`);
	assertCondition(type === "compose" || type === "workspace", `${messagePrefix}.type must be 'compose' or 'workspace'`);
	return {
		type,
		service: typeof raw.service === "string" ? raw.service.trim() : undefined,
		selector: typeof raw.selector === "string" ? raw.selector.trim() : undefined,
		config_path: typeof raw.config_path === "string" ? raw.config_path.trim() : undefined,
		db_path: typeof raw.db_path === "string" ? raw.db_path.trim() : undefined,
		keys_path: typeof raw.keys_path === "string" ? raw.keys_path.trim() : undefined,
		bootstrap_hook: typeof raw.bootstrap_hook === "string" ? raw.bootstrap_hook.trim() : undefined,
	};
}

function parseWorkers(value: unknown, messagePrefix: string): FleetWorkerSpec[] {
	assertCondition(Array.isArray(value) && value.length > 0, `${messagePrefix} must be a non-empty array`);
	return value.map((worker, index) => {
		const raw = asObject(worker, `${messagePrefix}[${index}] must be an object`);
		const identity = asString(raw.identity, `${messagePrefix}[${index}].identity must be set`);
		assertCondition(identity === "stable" || identity === "ephemeral", `${messagePrefix}[${index}].identity must be 'stable' or 'ephemeral'`);
		return {
			id: asString(raw.id, `${messagePrefix}[${index}].id must be set`),
			runtime: parseRuntimeTarget(raw.runtime, `${messagePrefix}[${index}].runtime`),
			identity,
		};
	});
}

export function parseFleetSpec(input: string): FleetSpec {
	const raw = asObject(JSON.parse(input), "fleet spec root must be an object");
	const fleet = asObject(raw.fleet, "fleet must be an object");
	const seedPeerRaw = asObject(raw.seed_peer, "seed_peer must be an object");
	const coordinatorRaw = asObject(raw.coordinator, "coordinator must be an object");
	assertCondition(Array.isArray(raw.swarms) && raw.swarms.length > 0, "swarms must be a non-empty array");

	const spec: FleetSpec = {
		fleet: {
			name: asString(fleet.name, "fleet.name must be set"),
			mode: asString(fleet.mode, "fleet.mode must be set"),
		},
		seed_peer: {
			id: asString(seedPeerRaw.id, "seed_peer.id must be set"),
			runtime: parseRuntimeTarget(seedPeerRaw.runtime, "seed_peer.runtime"),
			identity: "stable",
			storage: {
				kind: "sqlite",
				persistence: asString(asObject(seedPeerRaw.storage, "seed_peer.storage must be an object").persistence, "seed_peer.storage.persistence must be set") as StoragePersistence,
			},
		},
		coordinator: {
			mode: "shared",
			runtime: parseRuntimeTarget(coordinatorRaw.runtime, "coordinator.runtime"),
			cleanup: {
				stale_after_minutes: asNumber(asObject(coordinatorRaw.cleanup, "coordinator.cleanup must be an object").stale_after_minutes, "coordinator.cleanup.stale_after_minutes must be a number"),
				expire_after_minutes: asNumber(asObject(coordinatorRaw.cleanup, "coordinator.cleanup must be an object").expire_after_minutes, "coordinator.cleanup.expire_after_minutes must be a number"),
			},
		},
		swarms: raw.swarms.map((swarm, index) => {
			const swarmRaw = asObject(swarm, `swarms[${index}] must be an object`);
			return {
				id: asString(swarmRaw.id, `swarms[${index}].id must be set`),
				coordinator_group: asString(swarmRaw.coordinator_group, `swarms[${index}].coordinator_group must be set`),
				seed_peer: asString(swarmRaw.seed_peer, `swarms[${index}].seed_peer must be set`),
				workers: parseWorkers(swarmRaw.workers, `swarms[${index}].workers`),
			};
		}),
	};

	assertCondition(spec.fleet.mode === "seed-peer-swarms", "fleet.mode must be 'seed-peer-swarms'");
	assertCondition(spec.seed_peer.storage.persistence === "durable" || spec.seed_peer.storage.persistence === "ephemeral", "seed_peer.storage.persistence must be 'durable' or 'ephemeral'");
	assertCondition(spec.coordinator.cleanup.expire_after_minutes >= spec.coordinator.cleanup.stale_after_minutes, "coordinator cleanup expire_after_minutes must be >= stale_after_minutes");
	assertCondition(spec.seed_peer.runtime.type === "compose" || spec.seed_peer.runtime.type === "workspace", "seed_peer runtime must be supported");
	const swarmIds = new Set<string>();
	const groups = new Set<string>();
	for (const swarm of spec.swarms) {
		assertCondition(swarm.seed_peer === spec.seed_peer.id, `swarm '${swarm.id}' references unknown seed_peer '${swarm.seed_peer}'`);
		assertCondition(!swarmIds.has(swarm.id), `duplicate swarm id '${swarm.id}'`);
		assertCondition(!groups.has(swarm.coordinator_group), `duplicate coordinator_group '${swarm.coordinator_group}'`);
		swarmIds.add(swarm.id);
		groups.add(swarm.coordinator_group);
	}
	return spec;
}

export function loadFleetSpec(filePath: string): FleetSpec {
	return parseFleetSpec(readFileSync(resolve(filePath), "utf8"));
}

export function collectComposeServices(spec: FleetSpec): string[] {
	const services = new Set<string>();
	if (spec.coordinator.runtime.type === "compose" && spec.coordinator.runtime.service) services.add(spec.coordinator.runtime.service);
	if (spec.seed_peer.runtime.type === "compose" && spec.seed_peer.runtime.service) services.add(spec.seed_peer.runtime.service);
	for (const swarm of spec.swarms) {
		for (const worker of swarm.workers) {
			if (worker.runtime.type === "compose" && worker.runtime.service) services.add(worker.runtime.service);
		}
	}
	return [...services];
}
