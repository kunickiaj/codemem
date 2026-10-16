import { isCoordinatorAccountIssuer } from "./coordinator-auth-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";

export type Captured = Record<string, unknown>;
export function isHash(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}
export function capture(value: unknown, fields: readonly string[]): Captured | null {
	if (!value || typeof value !== "object") return null;
	try {
		if (Array.isArray(value)) return null;
		const result: Captured = {};
		for (const key of fields) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return null;
	}
}
export function captureAuthLinkConfig(value: unknown): CoordinatorAuthLinkConfig | null {
	const c = capture(value, ["coordinatorId", "issuer", "revision", "enabled"]);
	if (
		!c ||
		!isAuthControllerId(c.coordinatorId) ||
		!isCoordinatorAccountIssuer(c.issuer) ||
		!isHash(c.revision) ||
		typeof c.enabled !== "boolean"
	)
		return null;
	return c as unknown as CoordinatorAuthLinkConfig;
}
function isPublicKey(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 4096) return false;
	const flat = value.replace(/[\r\n]/g, "");
	return flat.length > 0 && flat.trim() === flat && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(flat);
}
export function captureAuthLinkSigner(value: unknown): CoordinatorAuthLinkSigner | null {
	const s = capture(value, ["groupId", "deviceId", "publicKey", "fingerprint"]);
	if (
		!s ||
		!isAuthControllerId(s.groupId) ||
		!isAuthControllerId(s.deviceId) ||
		!isPublicKey(s.publicKey) ||
		!isHash(s.fingerprint)
	)
		return null;
	return s as unknown as CoordinatorAuthLinkSigner;
}
