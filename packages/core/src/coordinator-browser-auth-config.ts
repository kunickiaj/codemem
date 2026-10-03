/** Trusted server-side data only, never request JSON or an environment loader.
 * Enabled settings contain SDK secrets: never use them as an HTTP or logging DTO.
 */
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorOidcProviderConfig } from "./coordinator-oidc.js";

export const COORDINATOR_BROWSER_AUTH_ISSUER = "https://accounts.google.com";

export interface CoordinatorBrowserAuthConfig {
	enabled: boolean;
	coordinatorId: string;
	issuer: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	revision: string;
}

export type CoordinatorBrowserAuthConfigField =
	| "config"
	| "enabled"
	| "unknown_field"
	| "coordinatorId"
	| "issuer"
	| "clientId"
	| "clientSecret"
	| "redirectUri"
	| "revision";

export type CoordinatorBrowserAuthSettings =
	| Readonly<{ kind: "disabled" }>
	| Readonly<{ kind: "invalid"; field: CoordinatorBrowserAuthConfigField }>
	| Readonly<{
			kind: "enabled";
			publicOrigin: string;
			store: Readonly<CoordinatorAuthBrowserConfig>;
			oidc: Readonly<CoordinatorOidcProviderConfig>;
	  }>;

const CONFIG_KEYS = [
	"enabled",
	"coordinatorId",
	"issuer",
	"clientId",
	"clientSecret",
	"redirectUri",
	"revision",
] as const;

function invalid(field: CoordinatorBrowserAuthConfigField): CoordinatorBrowserAuthSettings {
	return Object.freeze({ kind: "invalid", field });
}

function ownDataValue(value: object, key: keyof CoordinatorBrowserAuthConfig): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
	return descriptor.value;
}

function isCredential(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}

function redirectOrigin(value: unknown): string | null {
	if (typeof value !== "string" || value.trim() !== value) return null;
	if (/[\p{Cc}\p{Cf}\p{Cs}\\?#]/u.test(value)) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.href !== value) return null;
		if (url.username || url.password || url.search || url.hash) return null;
		return url.origin;
	} catch {
		return null;
	}
}

function captureEnabled(value: object): CoordinatorBrowserAuthSettings {
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !CONFIG_KEYS.some((known) => known === key)))
		return invalid("unknown_field");
	const coordinatorId = ownDataValue(value, "coordinatorId");
	const issuer = ownDataValue(value, "issuer");
	const clientId = ownDataValue(value, "clientId");
	const clientSecret = ownDataValue(value, "clientSecret");
	const redirectUri = ownDataValue(value, "redirectUri");
	const revision = ownDataValue(value, "revision");
	if (!isAuthControllerId(coordinatorId)) return invalid("coordinatorId");
	if (issuer !== COORDINATOR_BROWSER_AUTH_ISSUER) return invalid("issuer");
	if (!isCredential(clientId, 256)) return invalid("clientId");
	if (!isCredential(clientSecret, 4096)) return invalid("clientSecret");
	const publicOrigin = redirectOrigin(redirectUri);
	if (typeof redirectUri !== "string" || publicOrigin === null) return invalid("redirectUri");
	if (typeof revision !== "string" || revision.length !== 64 || !/^[a-f0-9]{64}$/.test(revision))
		return invalid("revision");
	return Object.freeze({
		kind: "enabled",
		publicOrigin,
		store: Object.freeze({ enabled: true, coordinatorId, issuer, redirectUri, revision }),
		oidc: Object.freeze({ issuer, clientId, clientSecret, redirectUri }),
	});
}

/** Capture own data descriptors once; getters are never evaluated. Reflection
 * may execute proxy traps, whose exceptions are returned without input details.
 */
export function captureCoordinatorBrowserAuthConfig(
	value: unknown,
): CoordinatorBrowserAuthSettings {
	try {
		if (value === undefined) return Object.freeze({ kind: "disabled" });
		if (value === null || typeof value !== "object" || Array.isArray(value))
			return invalid("config");
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return invalid("config");
		const enabled = ownDataValue(value, "enabled");
		if (enabled === false) return Object.freeze({ kind: "disabled" });
		if (enabled !== true) return invalid("enabled");
		return captureEnabled(value);
	} catch {
		return invalid("config");
	}
}
