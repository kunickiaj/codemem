import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
	normalizeCoordinatorAccountLinkOrigin,
	readAccountLinkDevice,
	readCoordinatorSyncConfig,
} from "@codemem/core";

export type AccountSetup =
	| "ready"
	| "coordinator_not_configured"
	| "coordinator_url_invalid"
	| "group_selection_required"
	| "device_unavailable"
	| "identity_unavailable";
export interface AccountProfile {
	dbPath: string;
	deviceId: string;
	identityId: string;
	identityLabel?: string;
	deviceLabel?: string;
}
export interface AccountContext extends AccountProfile {
	contextId: string;
	keysDir?: string;
	configPath?: string;
	coordinatorUrl: string;
	groupId: string;
	fingerprint: string;
	/** Present on real profile contexts; optional for legacy injected readers. */
	publicKeyHash?: string;
	fileIdentity: { dev: string; ino: string };
}
export type AccountContextResult =
	| {
			setup: AccountSetup;
			groups: string[];
			selectedGroupId: string | null;
			coordinator: { origin: string } | null;
			context: AccountContext | null;
	  }
	| { error: "account_group_not_configured" | "account_context_unavailable" };
export type AccountContextReader = (groupId?: string) => AccountContextResult;
export interface AccountContextReaderOptions {
	getProfile: () => AccountProfile | null;
	readConfig: () => Record<string, unknown>;
	configPath?: string;
	keysDir?: string;
}

function validId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}
function label(value: unknown): string | undefined {
	return validId(value) ? value : undefined;
}
function clean(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
function configuredGroups(raw: Record<string, unknown>): string[] | null {
	const value = process.env.CODEMEM_SYNC_COORDINATOR_GROUPS ?? raw.sync_coordinator_groups;
	if (value === undefined || value === null || value === "") return [];
	const values = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(values) || values.some((item) => !validId(clean(item)))) return null;
	return values.map(clean);
}
function readyContext(
	options: AccountContextReaderOptions,
	groupId: string,
	coordinatorUrl: string,
	raw: Record<string, unknown>,
	groups: string[],
): AccountContext | "device_unavailable" | "identity_unavailable" {
	const profile = options.getProfile();
	if (!profile) return "device_unavailable";
	const before = statSync(profile.dbPath, { bigint: true });
	const device = readAccountLinkDevice(profile.dbPath);
	const after = statSync(profile.dbPath, { bigint: true });
	const override = process.env.CODEMEM_DEVICE_ID?.trim() || undefined;
	if (
		!before.isFile() ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		device.deviceId !== profile.deviceId ||
		(override !== undefined && override !== device.deviceId)
	)
		return "device_unavailable";
	let actor = clean(raw.actor_id);
	if (Object.hasOwn(process.env, "CODEMEM_ACTOR_ID")) actor = clean(process.env.CODEMEM_ACTOR_ID);
	actor ||= `local:${device.deviceId}`;
	if (!validId(actor) || actor !== profile.identityId) return "identity_unavailable";
	const context = {
		dbPath: profile.dbPath,
		keysDir: options.keysDir,
		configPath: options.configPath,
		coordinatorUrl,
		groupId,
		deviceId: device.deviceId,
		fingerprint: device.fingerprint,
		publicKeyHash: createHash("sha256").update(device.publicKey).digest("hex"),
		identityId: actor,
		identityLabel: label(profile.identityLabel),
		deviceLabel: label(profile.deviceLabel),
		fileIdentity: { dev: after.dev.toString(), ino: after.ino.toString() },
	};
	const contextId = createHash("sha256")
		.update(
			JSON.stringify({
				context,
				groups,
				actorConfig: clean(raw.actor_id),
				actorEnv: process.env.CODEMEM_ACTOR_ID,
				deviceEnv: override,
				keyStore: process.env.CODEMEM_SYNC_KEY_STORE,
				home: process.env.HOME,
			}),
		)
		.digest("hex")
		.slice(0, 32);
	return { ...context, contextId };
}

function readContext(options: AccountContextReaderOptions, groupId?: string): AccountContextResult {
	const raw = options.readConfig();
	const config = readCoordinatorSyncConfig(raw);
	if (!configuredGroups(raw)) return { error: "account_context_unavailable" };
	const groups = [...new Set(config.syncCoordinatorGroups)];
	if (groups.length > 25 || groups.some((id) => !validId(id)))
		return { error: "account_context_unavailable" };
	if (groupId !== undefined && !groups.includes(groupId))
		return { error: "account_group_not_configured" };
	const selectedGroupId = groupId ?? (groups.length === 1 ? groups[0] : null) ?? null;
	const origin = normalizeCoordinatorAccountLinkOrigin(config.syncCoordinatorUrl);
	const base = {
		groups,
		selectedGroupId,
		coordinator: origin ? { origin } : null,
		context: null,
	};
	if (!config.syncCoordinatorUrl || groups.length === 0)
		return { ...base, setup: "coordinator_not_configured" };
	if (!origin) return { ...base, setup: "coordinator_url_invalid" };
	if (!selectedGroupId) return { ...base, setup: "group_selection_required" };
	let context: ReturnType<typeof readyContext>;
	try {
		context = readyContext(options, selectedGroupId, origin, raw, groups);
	} catch {
		return { ...base, setup: "device_unavailable" };
	}
	if (typeof context === "string") return { ...base, setup: context };
	return { ...base, setup: "ready", context };
}
/** Trusted callbacks describe the running profile, never a browser-selected path. */
export function createAccountContextReader(
	options: AccountContextReaderOptions,
): AccountContextReader {
	return (groupId) => {
		try {
			return readContext(options, groupId);
		} catch {
			return { error: "account_context_unavailable" };
		}
	};
}
