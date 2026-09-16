import { getCodememEnvOverrides, readCodememConfigFile } from "./observer-config.js";

type ConfigRecord = Record<string, unknown>;

function clean(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parseIntOr(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
		return Number.parseInt(value.trim(), 10);
	return fallback;
}

function parseBoolOr(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	return fallback;
}

function parseStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return [];
}

export interface CoordinatorSyncConfig {
	syncEnabled: boolean;
	syncHost: string;
	syncPort: number;
	syncIntervalS: number;
	syncAdvertise: string;
	syncMdns: boolean;
	syncRetentionEnabled: boolean;
	syncRetentionMaxAgeDays: number;
	syncRetentionMaxSizeMb: number;
	syncRetentionIntervalS: number;
	syncRetentionMaxRuntimeMs: number;
	syncRetentionMaxOpsPerPass: number;
	rawEventsRetentionEnabled: boolean;
	/** Whether raw_events_retention_enabled was explicitly set (file or env), so
	 * callers can treat an explicit `false` as authoritative over legacy knobs. */
	rawEventsRetentionConfigured: boolean;
	rawEventsRetentionMaxAgeDays: number;
	syncProjectsInclude: string[];
	syncProjectsExclude: string[];
	syncOpsLimit: number;
	syncCoordinatorUrl: string;
	syncCoordinatorGroup: string;
	syncCoordinatorGroups: string[];
	syncCoordinatorTimeoutS: number;
	syncCoordinatorPresenceTtlS: number;
	syncCoordinatorAdminSecret: string;
}

export function readCoordinatorSyncConfig(config?: ConfigRecord): CoordinatorSyncConfig {
	const raw = { ...(config ?? readCodememConfigFile()) } as ConfigRecord;
	const envOverrides = getCodememEnvOverrides();
	for (const key of Object.keys(envOverrides)) {
		const value = process.env[envOverrides[key] as string];
		if (value != null) raw[key] = value;
	}
	const syncCoordinatorGroup = clean(raw.sync_coordinator_group);
	const syncCoordinatorGroups = parseStringList(raw.sync_coordinator_groups);
	if (syncCoordinatorGroups.length === 0 && syncCoordinatorGroup) {
		syncCoordinatorGroups.push(syncCoordinatorGroup);
	}
	return {
		syncEnabled: parseBoolOr(raw.sync_enabled, false),
		syncHost: clean(raw.sync_host) || "0.0.0.0",
		syncPort: parseIntOr(raw.sync_port, 7337),
		syncIntervalS: parseIntOr(raw.sync_interval_s, 120),
		syncAdvertise: clean(raw.sync_advertise) || "auto",
		syncMdns: parseBoolOr(raw.sync_mdns, false),
		syncRetentionEnabled: parseBoolOr(raw.sync_retention_enabled, false),
		syncRetentionMaxAgeDays: Math.max(1, parseIntOr(raw.sync_retention_max_age_days, 30)),
		syncRetentionMaxSizeMb: Math.max(1, parseIntOr(raw.sync_retention_max_size_mb, 512)),
		syncRetentionIntervalS: Math.max(5, parseIntOr(raw.sync_retention_interval_s, 300)),
		syncRetentionMaxRuntimeMs: Math.max(100, parseIntOr(raw.sync_retention_max_runtime_ms, 2000)),
		syncRetentionMaxOpsPerPass: Math.max(1, parseIntOr(raw.sync_retention_max_ops_per_pass, 5000)),
		rawEventsRetentionEnabled: parseBoolOr(raw.raw_events_retention_enabled, false),
		rawEventsRetentionConfigured: raw.raw_events_retention_enabled !== undefined,
		rawEventsRetentionMaxAgeDays: Math.max(
			1,
			parseIntOr(raw.raw_events_retention_max_age_days, 90),
		),
		syncProjectsInclude: parseStringList(raw.sync_projects_include),
		syncProjectsExclude: parseStringList(raw.sync_projects_exclude),
		syncOpsLimit: Math.max(1, Math.min(1000, parseIntOr(raw.sync_ops_limit, 500))),
		syncCoordinatorUrl: clean(raw.sync_coordinator_url),
		syncCoordinatorGroup,
		syncCoordinatorGroups,
		syncCoordinatorTimeoutS: parseIntOr(raw.sync_coordinator_timeout_s, 3),
		syncCoordinatorPresenceTtlS: parseIntOr(raw.sync_coordinator_presence_ttl_s, 180),
		syncCoordinatorAdminSecret: clean(raw.sync_coordinator_admin_secret),
	};
}

export function coordinatorEnabled(config: CoordinatorSyncConfig): boolean {
	return Boolean(config.syncCoordinatorUrl && config.syncCoordinatorGroups.length > 0);
}
