import { captureCoordinatorBrowserAuthConfig } from "@codemem/core/internal/cloudflare-coordinator";

export interface CloudflareBrowserAuthEnv {
	CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG?: string;
	CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET?: string;
	CODEMEM_COORDINATOR_BROWSER_CSRF_KEY?: string;
}

export type CloudflareBrowserAuthSettings =
	| { kind: "disabled"; coordinatorId?: unknown }
	| { kind: "invalid" }
	| {
			kind: "enabled";
			config: Record<string, unknown>;
			csrfKeyBytes: Uint8Array;
			ownerEnrollmentEnabled: boolean;
	  };

const CONFIG_FIELDS = new Set([
	"enabled",
	"ownerEnrollmentEnabled",
	"coordinatorId",
	"issuer",
	"clientId",
	"redirectUri",
	"revision",
]);

function disabledSettings(fields: Record<string, unknown>): CloudflareBrowserAuthSettings {
	if (fields.coordinatorId === undefined) return { kind: "disabled" };
	return { kind: "disabled", coordinatorId: fields.coordinatorId };
}

/** Secrets are separate bindings and never appear in configuration JSON. */
export function captureCloudflareBrowserAuthEnv(
	env: CloudflareBrowserAuthEnv,
): CloudflareBrowserAuthSettings {
	try {
		const raw = env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG;
		if (raw === undefined) return { kind: "disabled" };
		if (typeof raw !== "string" || raw.length > 8192) return { kind: "invalid" };
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid" };
		const fields = parsed as Record<string, unknown>;
		if (fields.enabled === false) return disabledSettings(fields);
		if (Object.keys(fields).some((name) => !CONFIG_FIELDS.has(name))) return { kind: "invalid" };
		if (
			fields.ownerEnrollmentEnabled !== undefined &&
			typeof fields.ownerEnrollmentEnabled !== "boolean"
		)
			return { kind: "invalid" };
		const { ownerEnrollmentEnabled, ...publicConfig } = fields;
		const config = {
			...publicConfig,
			clientSecret: env.CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET,
		};
		if (captureCoordinatorBrowserAuthConfig(config).kind !== "enabled") return { kind: "invalid" };
		const secret = env.CODEMEM_COORDINATOR_BROWSER_CSRF_KEY;
		if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) return { kind: "invalid" };
		const csrfKeyBytes = Uint8Array.from(secret.match(/.{2}/g) ?? [], (byte) =>
			Number.parseInt(byte, 16),
		);
		return {
			kind: "enabled",
			config,
			csrfKeyBytes,
			ownerEnrollmentEnabled: ownerEnrollmentEnabled === true,
		};
	} catch {
		return { kind: "invalid" };
	}
}
