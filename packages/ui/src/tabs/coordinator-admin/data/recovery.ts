export type CoordinatorAdminSurface = "status" | "groups" | "joinRequests" | "devices";

export type CoordinatorAdminAvailability =
	| "unknown"
	| "fresh"
	| "stale"
	| "unavailable"
	| "not_applicable";

export interface CoordinatorAdminSurfaceState {
	availability: CoordinatorAdminAvailability;
	retrying: boolean;
}

export type CoordinatorAdminRecoveryState = Record<
	CoordinatorAdminSurface,
	CoordinatorAdminSurfaceState
>;

const SURFACE_LABELS: Record<CoordinatorAdminSurface, string> = {
	status: "coordinator status",
	groups: "coordinator groups",
	joinRequests: "join requests",
	devices: "devices",
};

function initialSurface(): CoordinatorAdminSurfaceState {
	return { availability: "unknown", retrying: false };
}

export function initialCoordinatorAdminRecovery(): CoordinatorAdminRecoveryState {
	return {
		status: initialSurface(),
		groups: initialSurface(),
		joinRequests: initialSurface(),
		devices: initialSurface(),
	};
}

export function beginSurfaceRefresh(
	recovery: CoordinatorAdminRecoveryState,
	surface: CoordinatorAdminSurface,
): void {
	recovery[surface] = { ...recovery[surface], retrying: true };
}

export function cancelSurfaceRefresh(
	recovery: CoordinatorAdminRecoveryState,
	surface: CoordinatorAdminSurface,
): void {
	recovery[surface] = { ...recovery[surface], retrying: false };
}

export function completeSurfaceRefresh(
	recovery: CoordinatorAdminRecoveryState,
	surface: CoordinatorAdminSurface,
): void {
	recovery[surface] = { availability: "fresh", retrying: false };
}

export function failSurfaceRefresh(
	recovery: CoordinatorAdminRecoveryState,
	surface: CoordinatorAdminSurface,
	hasUsableSnapshot?: boolean,
): void {
	const hadSnapshot =
		hasUsableSnapshot ??
		(recovery[surface].availability === "fresh" || recovery[surface].availability === "stale");
	recovery[surface] = {
		availability: hadSnapshot ? "stale" : "unavailable",
		retrying: false,
	};
}

export function markSurfaceNotApplicable(
	recovery: CoordinatorAdminRecoveryState,
	surface: CoordinatorAdminSurface,
): void {
	recovery[surface] = { availability: "not_applicable", retrying: false };
}

export function surfaceHasSnapshot(
	recovery: CoordinatorAdminRecoveryState,
	surface: CoordinatorAdminSurface,
): boolean {
	return recovery[surface].availability === "fresh" || recovery[surface].availability === "stale";
}

export function surfacesAreFresh(
	recovery: CoordinatorAdminRecoveryState,
	...surfaces: CoordinatorAdminSurface[]
): boolean {
	return surfaces.every(
		(surface) => recovery[surface].availability === "fresh" && !recovery[surface].retrying,
	);
}

export function surfaceIsNotApplicable(
	recovery: CoordinatorAdminRecoveryState,
	surface: CoordinatorAdminSurface,
): boolean {
	return recovery[surface].availability === "not_applicable";
}

export interface CoordinatorAdminRecoveryNotice {
	stale: string[];
	unavailable: string[];
	retrying: boolean;
}

export function coordinatorAdminRecoveryNotice(
	recovery: CoordinatorAdminRecoveryState,
): CoordinatorAdminRecoveryNotice | null {
	const entries = Object.entries(recovery) as Array<
		[CoordinatorAdminSurface, CoordinatorAdminSurfaceState]
	>;
	const stale = entries
		.filter(([, value]) => value.availability === "stale")
		.map(([surface]) => SURFACE_LABELS[surface]);
	const unavailable = entries
		.filter(([, value]) => value.availability === "unavailable")
		.map(([surface]) => SURFACE_LABELS[surface]);
	if (stale.length === 0 && unavailable.length === 0) return null;
	return {
		stale,
		unavailable,
		retrying: entries.some(([, value]) => value.retrying),
	};
}
