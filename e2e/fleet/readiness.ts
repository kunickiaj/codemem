import type { FleetSpec } from "./spec.js";

export type FleetNodeState =
	| "pending"
	| "reachable"
	| "group_ready"
	| "joining"
	| "joined"
	| "bootstrapping"
	| "bootstrapped"
	| "sync_verifying"
	| "ready"
	| "failed";

export interface FleetNodeStatus {
	id: string;
	role: "seed-peer" | "worker-peer" | "coordinator";
	swarm_id: string | null;
	coordinator_group: string | null;
	runtime_type: string;
	runtime_target: string | null;
	identity: "stable" | "ephemeral" | null;
	state: FleetNodeState;
	detail: string;
}

export interface FleetStatusSnapshot {
	fleet_name: string;
	mode: string;
	nodes: FleetNodeStatus[];
	counts: Record<FleetNodeState, number>;
}

export function updateFleetNodeStatus(
	nodes: FleetNodeStatus[],
	nodeId: string,
	state: FleetNodeState,
	detail: string,
): void {
	const node = nodes.find((entry) => entry.id === nodeId);
	if (!node) throw new Error(`Unknown fleet node status '${nodeId}'`);
	node.state = state;
	node.detail = detail;
}

function countStates(nodes: FleetNodeStatus[]): Record<FleetNodeState, number> {
	const counts: Record<FleetNodeState, number> = {
		pending: 0,
		reachable: 0,
		group_ready: 0,
		joining: 0,
		joined: 0,
		bootstrapping: 0,
		bootstrapped: 0,
		sync_verifying: 0,
		ready: 0,
		failed: 0,
	};
	for (const node of nodes) counts[node.state] += 1;
	return counts;
}

export function createFleetStatusSnapshot(spec: FleetSpec, nodes: FleetNodeStatus[]): FleetStatusSnapshot {
	return {
		fleet_name: spec.fleet.name,
		mode: spec.fleet.mode,
		nodes,
		counts: countStates(nodes),
	};
}
