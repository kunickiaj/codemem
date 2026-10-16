import type { Context, Hono } from "hono";
import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionPurposeStore,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import type { CoordinatorAuthLinkStore } from "./coordinator-auth-link-contract.js";
import {
	AUTH_SCHEMA_UPGRADE_REQUIRED,
	assertConfiguredAuthSchema,
	type CoordinatorAuthSchemaStore,
	CoordinatorAuthSchemaUpgradeRequiredError,
} from "./coordinator-auth-schema.js";
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
	ownerEnrollment?: CoordinatorBrowserOwnerEnrollmentFactory;
}
export interface CoordinatorBrowserOwnerEnrollmentAdapter {
	handle(request: Request, trustedClientKey: string): Promise<Response | null>;
	handleCallback(request: Request, trustedClientKey: string): Promise<Response>;
}
export type CoordinatorBrowserOwnerEnrollmentFactory = (
	input: Readonly<{
		config: Readonly<CoordinatorBrowserAuthConfig>;
		csrfKey: BrowserCsrfKey;
		oidcOptions: Readonly<CoordinatorOidcOptions>;
		limiter: InMemoryRequestRateLimiter;
	}>,
) => Promise<CoordinatorBrowserOwnerEnrollmentAdapter>;
type EnabledSettings = Extract<CoordinatorBrowserAuthSettings, { kind: "enabled" }>;
export type CoordinatorBrowserAuthSnapshot =
	| Readonly<{ kind: "disabled" }>
	| Readonly<{
			kind: "invalid";
			error: "browser_auth_config_invalid";
			field: CoordinatorBrowserAuthConfigField | "csrfKey" | "oidcOptions" | "ownerEnrollment";
	  }>
	| Readonly<{ kind: "enabled" }>;
type EnabledPayload = Readonly<{
	settings: EnabledSettings;
	config: Readonly<CoordinatorBrowserAuthConfig>;
	csrfKey: BrowserCsrfKey;
	oidcOptions: Readonly<CoordinatorOidcOptions>;
	callbackPath: string;
	ownerEnrollment?: CoordinatorBrowserOwnerEnrollmentFactory;
}>;
const enabledPayloads = new WeakMap<object, EnabledPayload>();
export type CoordinatorBrowserAuthStore = CoordinatorBrowserAccountInput["store"] &
	CoordinatorBrowserAuthCallbackInput["store"] &
	CoordinatorBrowserLinkInput["store"] &
	CoordinatorBrowserLinkCompletionInput["store"] &
	CoordinatorBrowserLinkStartInput["store"] &
	CoordinatorBrowserSigninStartInput["store"] &
	Partial<CoordinatorAuthBrowserTransactionPurposeStore & CoordinatorAuthSchemaStore>;
export type CoordinatorBrowserAuthClientKey = (context: Context) => string | null;
export interface CoordinatorBrowserAuth {
	readonly storeConfig: Readonly<CoordinatorAuthBrowserConfig>;
	register(app: Hono, clientKey: CoordinatorBrowserAuthClientKey): void;
}
export type CoordinatorBrowserAuthResult =
	| Readonly<{ ok: true; auth: CoordinatorBrowserAuth }>
	| Readonly<{
			ok: false;
			error:
				| "browser_auth_disabled"
				| "browser_auth_config_invalid"
				| "browser_auth_setup_failed"
				| "browser_auth_store_unavailable"
				| typeof AUTH_SCHEMA_UPGRADE_REQUIRED;
	  }>;

const FIXED_PATHS = [
	"/auth/sign-in",
	"/auth/link/start",
	"/auth/link/confirm",
	"/auth/link/cancel",
	"/auth/link/complete",
	"/auth/account",
	"/auth/logout",
	"/auth/owner/start",
	"/auth/owner/confirm",
];
const OWNER_PATHS = [
	"/auth/owner/start",
	"/auth/owner/confirm",
	"/v1/auth/owner-config",
	"/v1/auth/owner-attempts",
	"/v1/auth/owner-attempts/finalize",
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
		const ownerEnrollment = ownData(input, "ownerEnrollment");
		if (ownerEnrollment !== undefined && typeof ownerEnrollment !== "function")
			return invalid("ownerEnrollment");
		const handle = Object.freeze({ kind: "enabled" as const });
		enabledPayloads.set(
			handle,
			Object.freeze({
				settings,
				config,
				csrfKey,
				oidcOptions,
				callbackPath,
				ownerEnrollment: ownerEnrollment as CoordinatorBrowserOwnerEnrollmentFactory | undefined,
			}),
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
		const storeError = await browserAuthStoreError(store);
		if (storeError) return Object.freeze({ ok: false, error: storeError });
		const purposeStore = payload.ownerEnrollment ? capturePurposeStore(store) : undefined;
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
		const owner = await createOwnerAdapter(payload, limiter);
		const callback = await createCoordinatorBrowserAuthCallback({
			...input,
			completeLink: link.handlers.completeLink,
			ownerCallback: owner?.handleCallback,
			purposeStore,
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
			...ownerRoutes(owner),
		]);
		return browserAuthReady(payload.settings.store, routes);
	} catch (error) {
		return browserAuthSetupFailure(error);
	}
}

function browserAuthReady(
	storeConfig: CoordinatorAuthBrowserConfig,
	routes: readonly Route[],
): CoordinatorBrowserAuthResult {
	return Object.freeze({
		ok: true,
		auth: Object.freeze({
			storeConfig,
			register: (app: Hono, clientKey: CoordinatorBrowserAuthClientKey) =>
				registerRoutes(app, routes, clientKey),
		}),
	});
}

async function browserAuthStoreError(
	store: CoordinatorBrowserAuthStore,
): Promise<typeof AUTH_SCHEMA_UPGRADE_REQUIRED | "browser_auth_store_unavailable" | null> {
	try {
		await assertConfiguredAuthSchema(store);
		return null;
	} catch (error) {
		if (error instanceof CoordinatorAuthSchemaUpgradeRequiredError)
			return AUTH_SCHEMA_UPGRADE_REQUIRED;
		return "browser_auth_store_unavailable";
	}
}

function browserAuthSetupFailure(error: unknown): CoordinatorBrowserAuthResult {
	if (error instanceof CoordinatorAuthSchemaUpgradeRequiredError)
		return Object.freeze({ ok: false, error: AUTH_SCHEMA_UPGRADE_REQUIRED });
	return Object.freeze({ ok: false, error: "browser_auth_setup_failed" });
}

function ownerRoutes(owner: CoordinatorBrowserOwnerEnrollmentAdapter | undefined): Route[] {
	if (!owner) return [];
	const handler: BrowserHandler = async (request, key) => ({
		response: (await owner.handle(request, key)) ?? coordinatorBrowserAuthUnavailableResponse(),
	});
	return OWNER_PATHS.map((path) => ({ path, get: handler, post: handler }));
}

async function createOwnerAdapter(
	payload: EnabledPayload,
	limiter: InMemoryRequestRateLimiter,
): Promise<CoordinatorBrowserOwnerEnrollmentAdapter | undefined> {
	if (!payload.ownerEnrollment) return undefined;
	const adapter = await payload.ownerEnrollment(
		Object.freeze({
			config: payload.config,
			csrfKey: payload.csrfKey,
			oidcOptions: payload.oidcOptions,
			limiter,
		}),
	);
	const handle = ownData(adapter, "handle");
	const handleCallback = ownData(adapter, "handleCallback");
	if (typeof handle !== "function" || typeof handleCallback !== "function") throw new Error();
	return Object.freeze({
		handle: (...args: Parameters<CoordinatorBrowserOwnerEnrollmentAdapter["handle"]>) =>
			Reflect.apply(handle, adapter, args),
		handleCallback: (
			...args: Parameters<CoordinatorBrowserOwnerEnrollmentAdapter["handleCallback"]>
		) => Reflect.apply(handleCallback, adapter, args),
	});
}

function capturePurposeStore(
	store: CoordinatorBrowserAuthStore,
): CoordinatorAuthBrowserTransactionPurposeStore {
	let cursor: object | null = store;
	const seen = new Set<object>();
	while (cursor !== null) {
		if (seen.has(cursor)) throw new Error();
		seen.add(cursor);
		const descriptor = Object.getOwnPropertyDescriptor(cursor, "readAuthBrowserTransactionPurpose");
		if (descriptor) {
			if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function")
				throw new Error();
			const method =
				descriptor.value as CoordinatorAuthBrowserTransactionPurposeStore["readAuthBrowserTransactionPurpose"];
			return Object.freeze({
				readAuthBrowserTransactionPurpose: (
					...args: Parameters<
						CoordinatorAuthBrowserTransactionPurposeStore["readAuthBrowserTransactionPurpose"]
					>
				) => Reflect.apply(method, store, args),
			});
		}
		cursor = Object.getPrototypeOf(cursor);
	}
	throw new Error();
}

export type CoordinatorBrowserAuthMaintenanceStore = Pick<
	CoordinatorAuthLinkStore,
	"maintainAuthLinkAttempts"
> &
	Pick<
		CoordinatorAuthBrowserTransactionStore,
		| "retireAuthBrowserTransactions"
		| "purgeAuthSigninBrowserTransactions"
		| "maintainAuthBrowserTransactions"
	> &
	Pick<
		CoordinatorAuthSessionStore,
		"purgeAuthGuardedSigninSessions" | "purgeAuthGuardedSigninReceipts"
	>;
export type CoordinatorBrowserAuthMaintenanceStep =
	| "link_attempts"
	| "browser_retirement"
	| "browser_expiry"
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
				step: "browser_expiry",
				run: () => store.maintainAuthBrowserTransactions(scope, { limit: 32 }),
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
