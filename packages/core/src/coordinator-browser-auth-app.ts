import type { Context, Hono } from "hono";
import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import type { CoordinatorAuthLinkStore } from "./coordinator-auth-link-contract.js";
import type { CoordinatorAuthSessionStore } from "./coordinator-auth-session-contract.js";
import {
	type CoordinatorBrowserAccountInput,
	createCoordinatorBrowserAccount,
} from "./coordinator-browser-account.js";
import {
	type CoordinatorBrowserAuthCallbackInput,
	createCoordinatorBrowserAuthCallback,
} from "./coordinator-browser-auth-callback.js";
import {
	type CoordinatorBrowserAuthConfig,
	type CoordinatorBrowserAuthConfigField,
	type CoordinatorBrowserAuthSettings,
	captureCoordinatorBrowserAuthConfig,
} from "./coordinator-browser-auth-config.js";
import { type BrowserCsrfKey, isBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import {
	type CoordinatorBrowserLinkInput,
	createCoordinatorBrowserLinkHandlers,
} from "./coordinator-browser-link.js";
import {
	type CoordinatorBrowserLinkCompletionInput,
	createCoordinatorBrowserLinkCompletionHandlers,
} from "./coordinator-browser-link-completion.js";
import {
	type CoordinatorBrowserLinkStartInput,
	createCoordinatorBrowserLinkStart,
} from "./coordinator-browser-link-start.js";
import {
	type CoordinatorBrowserSigninStartInput,
	createCoordinatorBrowserSigninStart,
} from "./coordinator-browser-signin-start.js";
import type { CoordinatorOidcOptions } from "./coordinator-oidc.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

export interface CoordinatorBrowserAuthOptions {
	config: unknown;
	csrfKey?: BrowserCsrfKey;
	oidcOptions?: CoordinatorOidcOptions;
}
type EnabledSettings = Extract<CoordinatorBrowserAuthSettings, { kind: "enabled" }>;
export type CoordinatorBrowserAuthSnapshot =
	| Readonly<{ kind: "disabled" }>
	| Readonly<{
			kind: "invalid";
			error: "browser_auth_config_invalid";
			field: CoordinatorBrowserAuthConfigField | "csrfKey" | "oidcOptions";
	  }>
	| Readonly<{ kind: "enabled" }>;
type EnabledPayload = Readonly<{
	settings: EnabledSettings;
	config: Readonly<CoordinatorBrowserAuthConfig>;
	csrfKey: BrowserCsrfKey;
	oidcOptions: Readonly<CoordinatorOidcOptions>;
	callbackPath: string;
}>;
const enabledPayloads = new WeakMap<object, EnabledPayload>();
export type CoordinatorBrowserAuthStore = CoordinatorBrowserAccountInput["store"] &
	CoordinatorBrowserAuthCallbackInput["store"] &
	CoordinatorBrowserLinkInput["store"] &
	CoordinatorBrowserLinkCompletionInput["store"] &
	CoordinatorBrowserLinkStartInput["store"] &
	CoordinatorBrowserSigninStartInput["store"];
export type CoordinatorBrowserAuthClientKey = (context: Context) => string | null;
export interface CoordinatorBrowserAuth {
	readonly storeConfig: Readonly<CoordinatorAuthBrowserConfig>;
	register(app: Hono, clientKey: CoordinatorBrowserAuthClientKey): void;
}
export type CoordinatorBrowserAuthResult =
	| Readonly<{ ok: true; auth: CoordinatorBrowserAuth }>
	| Readonly<{
			ok: false;
			error: "browser_auth_disabled" | "browser_auth_config_invalid" | "browser_auth_setup_failed";
	  }>;

const FIXED_PATHS = [
	"/auth/sign-in",
	"/auth/link/start",
	"/auth/link/confirm",
	"/auth/link/cancel",
	"/auth/link/complete",
	"/auth/account",
	"/auth/logout",
];
function ownData(value: unknown, name: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (descriptor && !Object.hasOwn(descriptor, "value")) throw new Error();
	return descriptor?.value;
}
function invalid(
	field: Extract<CoordinatorBrowserAuthSnapshot, { kind: "invalid" }>["field"],
): CoordinatorBrowserAuthSnapshot {
	return Object.freeze({ kind: "invalid", error: "browser_auth_config_invalid", field });
}
function captureOidcOptions(value: unknown): Readonly<CoordinatorOidcOptions> {
	if (value === undefined) return Object.freeze({});
	const fetch = ownData(value, "fetch");
	const timeoutSeconds = ownData(value, "timeoutSeconds");
	if (fetch !== undefined && typeof fetch !== "function") throw new Error();
	if (
		timeoutSeconds !== undefined &&
		(typeof timeoutSeconds !== "number" ||
			!Number.isFinite(timeoutSeconds) ||
			timeoutSeconds < 1 ||
			timeoutSeconds > 30)
	)
		throw new Error();
	return Object.freeze({
		fetch: fetch as CoordinatorOidcOptions["fetch"],
		timeoutSeconds: timeoutSeconds as number | undefined,
	});
}
/** Capture secrets and transport references before any discovery awaits. */
export function captureCoordinatorBrowserAuthOptions(
	input: CoordinatorBrowserAuthOptions,
): CoordinatorBrowserAuthSnapshot {
	try {
		const settings = captureCoordinatorBrowserAuthConfig(ownData(input, "config"));
		if (settings.kind === "disabled") return Object.freeze({ kind: "disabled" });
		if (settings.kind === "invalid") return invalid(settings.field);
		const callbackPath = new URL(settings.store.redirectUri).pathname;
		if (!/^\/auth\/[A-Za-z0-9._~/-]+$/.test(callbackPath) || FIXED_PATHS.includes(callbackPath))
			return invalid("redirectUri");
		let csrfKey: unknown;
		try {
			csrfKey = ownData(input, "csrfKey");
		} catch {
			return invalid("csrfKey");
		}
		if (!isBrowserCsrfKey(csrfKey)) return invalid("csrfKey");
		let oidcOptions: Readonly<CoordinatorOidcOptions>;
		try {
			oidcOptions = captureOidcOptions(ownData(input, "oidcOptions"));
		} catch {
			return invalid("oidcOptions");
		}
		const config = Object.freeze({
			...settings.store,
			clientId: settings.oidc.clientId,
			clientSecret: settings.oidc.clientSecret,
		});
		const handle = Object.freeze({ kind: "enabled" as const });
		enabledPayloads.set(
			handle,
			Object.freeze({ settings, config, csrfKey, oidcOptions, callbackPath }),
		);
		return handle;
	} catch {
		return invalid("config");
	}
}

export function coordinatorBrowserAuthUnavailableResponse(): Response {
	return new Response("Authentication unavailable. Try again.", {
		status: 503,
		headers: {
			"Content-Type": "text/plain;charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
type BrowserHandler = (
	request: Request,
	clientKey: string,
) => Promise<Readonly<{ response: Response }>>;
type Route = Readonly<{ path: string; get?: BrowserHandler; post?: BrowserHandler }>;
function registerRoutes(
	app: Hono,
	routes: readonly Route[],
	clientKey: CoordinatorBrowserAuthClientKey,
): void {
	for (const route of routes) {
		app.all(route.path, async (context) => {
			try {
				const request = context.req.raw;
				let handler: BrowserHandler | undefined;
				if (request.method === "GET") handler = route.get;
				if (request.method === "POST") handler = route.post;
				if (!handler)
					return new Response("Method not allowed.", {
						status: 405,
						headers: {
							Allow: [route.get && "GET", route.post && "POST"].filter(Boolean).join(", "),
							"Cache-Control": "no-store",
							"Referrer-Policy": "no-referrer",
							"X-Content-Type-Options": "nosniff",
							"Content-Type": "text/plain;charset=utf-8",
						},
					});
				return (await handler(request, clientKey(context) ?? "")).response;
			} catch {
				return coordinatorBrowserAuthUnavailableResponse();
			}
		});
	}
}
/** Owns handlers, not the store lifetime. Nothing is mounted until all factories succeed. */
export async function createCoordinatorBrowserAuth(
	snapshot: CoordinatorBrowserAuthSnapshot,
	store: CoordinatorBrowserAuthStore,
	limiter: InMemoryRequestRateLimiter,
): Promise<CoordinatorBrowserAuthResult> {
	if (snapshot.kind === "disabled")
		return Object.freeze({ ok: false, error: "browser_auth_disabled" });
	if (snapshot.kind === "invalid")
		return Object.freeze({ ok: false, error: "browser_auth_config_invalid" });
	try {
		const payload = enabledPayloads.get(snapshot);
		if (!payload) return Object.freeze({ ok: false, error: "browser_auth_setup_failed" });
		const input = Object.freeze({
			config: payload.config,
			csrfKey: payload.csrfKey,
			oidcOptions: payload.oidcOptions,
			store,
			limiter,
		});
		const link = createCoordinatorBrowserLinkHandlers({
			...input,
			config: payload.settings.store,
		});
		const completion = createCoordinatorBrowserLinkCompletionHandlers({
			...input,
			config: payload.settings.store,
		});
		if (!link.ok || !completion.ok)
			return Object.freeze({ ok: false, error: "browser_auth_setup_failed" });
		const signin = await createCoordinatorBrowserSigninStart(input);
		const start = await createCoordinatorBrowserLinkStart(input);
		const callback = await createCoordinatorBrowserAuthCallback({
			...input,
			completeLink: link.handlers.completeLink,
		});
		const account = await createCoordinatorBrowserAccount(input);
		if (!signin.ok || !start.ok || !callback.ok || !account.ok)
			return Object.freeze({ ok: false, error: "browser_auth_setup_failed" });
		const routes: readonly Route[] = Object.freeze([
			{ path: "/auth/sign-in", get: signin.handlers.signInPage, post: signin.handlers.signInStart },
			{
				path: "/auth/link/start",
				get: start.handlers.linkStartPage,
				post: start.handlers.linkStart,
			},
			{ path: payload.callbackPath, get: callback.handlers.callback },
			{ path: "/auth/link/confirm", post: link.handlers.confirm },
			{ path: "/auth/link/cancel", post: link.handlers.cancel },
			{
				path: "/auth/link/complete",
				get: completion.handlers.page,
				post: completion.handlers.complete,
			},
			{ path: "/auth/account", get: account.handlers.account },
			{ path: "/auth/logout", post: account.handlers.logout },
		]);
		return Object.freeze({
			ok: true,
			auth: Object.freeze({
				storeConfig: payload.settings.store,
				register: (app: Hono, clientKey: CoordinatorBrowserAuthClientKey) =>
					registerRoutes(app, routes, clientKey),
			}),
		});
	} catch {
		return Object.freeze({ ok: false, error: "browser_auth_setup_failed" });
	}
}

export type CoordinatorBrowserAuthMaintenanceStore = Pick<
	CoordinatorAuthLinkStore,
	"maintainAuthLinkAttempts"
> &
	Pick<
		CoordinatorAuthBrowserTransactionStore,
		"retireAuthBrowserTransactions" | "purgeAuthSigninBrowserTransactions"
	> &
	Pick<
		CoordinatorAuthSessionStore,
		"purgeAuthGuardedSigninSessions" | "purgeAuthGuardedSigninReceipts"
	>;
export type CoordinatorBrowserAuthMaintenanceStep =
	| "link_attempts"
	| "browser_retirement"
	| "signin_transactions"
	| "signin_sessions"
	| "signin_receipts";
export type CoordinatorBrowserAuthMaintenanceResult =
	| Readonly<{ kind: "disabled" }>
	| Readonly<{
			kind: "failed";
			error: "maintenance_failed";
			step: CoordinatorBrowserAuthMaintenanceStep | "options";
	  }>
	| Readonly<{ kind: "maintained"; processedCount: number; more: boolean }>;
/** Explicit operator/scheduled work only; budgets apply independently to each stage. */
export async function maintainCoordinatorBrowserAuth(
	snapshot: CoordinatorBrowserAuthSnapshot,
	store: CoordinatorBrowserAuthMaintenanceStore,
	options: { maxBatches?: number } = {},
): Promise<CoordinatorBrowserAuthMaintenanceResult> {
	if (snapshot.kind === "disabled") return Object.freeze({ kind: "disabled" });
	let step: CoordinatorBrowserAuthMaintenanceStep | "options" = "options";
	try {
		const payload = enabledPayloads.get(snapshot);
		const maxBatches = options.maxBatches ?? 4;
		if (
			snapshot.kind !== "enabled" ||
			!payload ||
			!Number.isSafeInteger(maxBatches) ||
			maxBatches < 1 ||
			maxBatches > 8
		)
			throw new Error();
		const config = payload.settings.store;
		const scope = Object.freeze({ coordinatorId: config.coordinatorId });
		const stages = [
			{ step: "link_attempts", run: () => store.maintainAuthLinkAttempts(config, { limit: 32 }) },
			{
				step: "browser_retirement",
				run: () => store.retireAuthBrowserTransactions(config, { limit: 32 }),
			},
			{
				step: "signin_transactions",
				run: () => store.purgeAuthSigninBrowserTransactions(scope, { limit: 256 }),
			},
			{
				step: "signin_sessions",
				run: () => store.purgeAuthGuardedSigninSessions(scope, { limit: 256 }),
			},
			{
				step: "signin_receipts",
				run: () => store.purgeAuthGuardedSigninReceipts(scope, { limit: 256 }),
			},
		] as const;
		let processedCount = 0;
		let more = false;
		for (const stage of stages) {
			step = stage.step;
			const result = await runMaintenanceStage(stage.run, maxBatches);
			processedCount += result.processedCount;
			if (!Number.isSafeInteger(processedCount)) throw new Error();
			more ||= result.more;
		}
		return Object.freeze({ kind: "maintained", processedCount, more });
	} catch {
		return Object.freeze({ kind: "failed", error: "maintenance_failed", step });
	}
}
async function runMaintenanceStage(
	run: () => Promise<{ kind: string; processedCount?: number; more?: boolean }>,
	maxBatches: number,
): Promise<{ processedCount: number; more: boolean }> {
	let processedCount = 0;
	for (let batch = 0; batch < maxBatches; batch++) {
		const result = await run();
		if (
			result.kind === "rejected" ||
			typeof result.processedCount !== "number" ||
			!Number.isSafeInteger(result.processedCount) ||
			result.processedCount < 0 ||
			typeof result.more !== "boolean"
		)
			throw new Error();
		processedCount += result.processedCount;
		if (!Number.isSafeInteger(processedCount)) throw new Error();
		if (!result.more) return { processedCount, more: false };
	}
	return { processedCount, more: true };
}
