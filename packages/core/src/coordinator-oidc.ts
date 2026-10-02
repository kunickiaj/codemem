import * as oidc from "openid-client";
import {
	type CoordinatorAccountReference,
	isCoordinatorAccountIssuer,
	parseCoordinatorAccountReference,
} from "./coordinator-auth-contract.js";

export interface CoordinatorOidcProviderConfig {
	issuer: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

/** Trusted transport options, not a JSON configuration surface. */
export interface CoordinatorOidcOptions {
	fetch?: oidc.CustomFetch;
	timeoutSeconds?: number;
}

/** Secret transaction material: keep server-side, never in browser JSON. */
export type CoordinatorOidcMaterial = { state: string; nonce: string; pkceVerifier: string };

/** Display metadata only; these fields never grant permissions. */
export interface CoordinatorOidcProfile {
	displayName?: string;
	email?: string;
	emailVerified?: boolean;
	pictureUrl?: string;
}

type CallbackResult =
	| { ok: true; account: CoordinatorAccountReference; profile: CoordinatorOidcProfile }
	| { ok: false; error: "invalid_callback" | "oidc_verification_failed" };

export interface CoordinatorOidcClient {
	createAuthorizationRequest(): Promise<{
		authorizationUrl: string;
		material: CoordinatorOidcMaterial;
	}>;
	verifyCallback(
		input: { callbackUrl: string; material: CoordinatorOidcMaterial },
		options?: { fetchUserInfo?: boolean },
	): Promise<CallbackResult>;
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const MATERIAL = /^[A-Za-z0-9._~-]{43,128}$/;

function capture(value: unknown, keys: string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error();
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && !Object.hasOwn(descriptor, "value")) throw new Error();
		result[key] = descriptor?.value;
	}
	return result;
}

function httpsUrl(value: unknown, options: { allowQuery: boolean }): URL | undefined {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		CONTROL.test(value) ||
		value.includes("\\") ||
		value.includes("#") ||
		(!options.allowQuery && value.includes("?")) ||
		!/^https:\/\//i.test(value)
	)
		return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
			return undefined;
		}
		return url;
	} catch {
		return undefined;
	}
}

function credential(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length <= maximum &&
		value.trim().length > 0 &&
		value.trim() === value &&
		!CONTROL.test(value)
	);
}

function captureConfiguration(config: unknown, options: unknown) {
	const c = capture(config, ["issuer", "clientId", "clientSecret", "redirectUri"]);
	const o = capture(options === undefined ? {} : options, ["fetch", "timeoutSeconds"]);
	const redirect = httpsUrl(c.redirectUri, { allowQuery: false });
	if (
		!isCoordinatorAccountIssuer(c.issuer) ||
		!httpsUrl(c.issuer, { allowQuery: false }) ||
		!credential(c.clientId, 256) ||
		!credential(c.clientSecret, 4096) ||
		typeof c.redirectUri !== "string" ||
		!redirect ||
		redirect.href !== c.redirectUri ||
		(o.fetch !== undefined && typeof o.fetch !== "function")
	)
		throw new Error();
	const timeout = o.timeoutSeconds === undefined ? 10 : o.timeoutSeconds;
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 30) {
		throw new Error();
	}
	return {
		issuer: c.issuer,
		clientId: c.clientId,
		clientSecret: c.clientSecret,
		redirectUri: c.redirectUri,
		fetch: o.fetch as oidc.CustomFetch | undefined,
		timeout,
	};
}

function validateMetadata(config: oidc.Configuration, issuer: string): void {
	const metadata = config.serverMetadata();
	if (metadata.issuer !== issuer) throw new Error();
	for (const endpoint of [
		metadata.authorization_endpoint,
		metadata.token_endpoint,
		metadata.jwks_uri,
	]) {
		if (!httpsUrl(endpoint, { allowQuery: true })) throw new Error();
	}
	if (
		metadata.userinfo_endpoint !== undefined &&
		!httpsUrl(metadata.userinfo_endpoint, { allowQuery: true })
	)
		throw new Error();
}

function captureCallback(input: unknown, options: unknown, redirectUri: string) {
	const i = capture(input, ["callbackUrl", "material"]);
	const m = capture(i.material, ["state", "nonce", "pkceVerifier"]);
	const o = capture(options === undefined ? {} : options, ["fetchUserInfo"]);
	if (o.fetchUserInfo !== undefined && typeof o.fetchUserInfo !== "boolean") throw new Error();
	if (
		typeof m.state !== "string" ||
		!MATERIAL.test(m.state) ||
		typeof m.nonce !== "string" ||
		!MATERIAL.test(m.nonce) ||
		typeof m.pkceVerifier !== "string" ||
		!MATERIAL.test(m.pkceVerifier)
	)
		throw new Error();
	const url = httpsUrl(i.callbackUrl, { allowQuery: true });
	const redirect = new URL(redirectUri);
	if (!url || url.origin !== redirect.origin || url.pathname !== redirect.pathname)
		throw new Error();
	return {
		url,
		state: m.state,
		nonce: m.nonce,
		pkceVerifier: m.pkceVerifier,
		fetchUserInfo: o.fetchUserInfo === true,
	};
}

function displayString(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value)
	);
}

function projectProfile(claims: unknown): CoordinatorOidcProfile {
	const c = capture(claims, ["name", "email", "email_verified", "picture"]);
	const profile: CoordinatorOidcProfile = {};
	if (displayString(c.name, 256)) profile.displayName = c.name;
	if (displayString(c.email, 320)) profile.email = c.email;
	if (profile.email !== undefined && typeof c.email_verified === "boolean") {
		profile.emailVerified = c.email_verified;
	}
	// Rendering needs its own image policy; this adapter never fetches pictures.
	if (displayString(c.picture, 2048) && httpsUrl(c.picture, { allowQuery: true })) {
		profile.pictureUrl = c.picture;
	}
	return profile;
}

function mergeProfile(
	profile: CoordinatorOidcProfile,
	extra: CoordinatorOidcProfile,
): CoordinatorOidcProfile {
	const merged = { ...profile, ...extra };
	if (extra.email !== undefined && extra.emailVerified === undefined) delete merged.emailVerified;
	return merged;
}

async function authorizationRequest(config: oidc.Configuration, redirectUri: string) {
	try {
		const material = {
			state: oidc.randomState(),
			nonce: oidc.randomNonce(),
			pkceVerifier: oidc.randomPKCECodeVerifier(),
		};
		const challenge = await oidc.calculatePKCECodeChallenge(material.pkceVerifier);
		const url = oidc.buildAuthorizationUrl(config, {
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid email profile",
			state: material.state,
			nonce: material.nonce,
			code_challenge: challenge,
			code_challenge_method: "S256",
			response_mode: "query",
			access_type: "online",
		});
		return { authorizationUrl: url.href, material };
	} catch {
		throw new Error("oidc_request_failed");
	}
}

function adapter(
	config: oidc.Configuration,
	issuer: string,
	redirectUri: string,
): CoordinatorOidcClient {
	return {
		createAuthorizationRequest: () => authorizationRequest(config, redirectUri),
		async verifyCallback(input, options): Promise<CallbackResult> {
			let callback: ReturnType<typeof captureCallback>;
			try {
				callback = captureCallback(input, options, redirectUri);
			} catch {
				return { ok: false, error: "invalid_callback" };
			}
			try {
				const tokens = await oidc.authorizationCodeGrant(config, callback.url, {
					pkceCodeVerifier: callback.pkceVerifier,
					expectedState: callback.state,
					expectedNonce: callback.nonce,
					idTokenExpected: true,
				});
				const claims = tokens.claims();
				if (!claims || claims.iss !== issuer) throw new Error();
				const reference = parseCoordinatorAccountReference(
					{ issuer: claims.iss, subject: claims.sub },
					{ issuer },
				);
				if (!reference.ok) throw new Error();
				let profile = projectProfile(claims);
				if (callback.fetchUserInfo) {
					const userInfo = await oidc.fetchUserInfo(
						config,
						tokens.access_token,
						reference.account.subject,
					);
					profile = mergeProfile(profile, projectProfile(userInfo));
				}
				return { ok: true, account: { ...reference.account }, profile };
			} catch {
				return { ok: false, error: "oidc_verification_failed" };
			}
		},
	};
}

/**
 * Proof verification only. Durable transaction consumption and browser binding
 * belong to the caller; an in-memory replay set cannot replace those checks.
 */
export async function createCoordinatorOidcClient(
	config: CoordinatorOidcProviderConfig,
	options?: CoordinatorOidcOptions,
): Promise<
	| { ok: true; client: CoordinatorOidcClient }
	| { ok: false; error: "invalid_provider_configuration" | "oidc_discovery_failed" }
> {
	let captured: ReturnType<typeof captureConfiguration>;
	try {
		captured = captureConfiguration(config, options);
	} catch {
		return { ok: false, error: "invalid_provider_configuration" };
	}
	try {
		const privateConfig = await oidc.discovery(
			new URL(captured.issuer),
			captured.clientId,
			{
				client_secret: captured.clientSecret,
				id_token_signed_response_alg: "RS256",
				[oidc.clockTolerance]: 0,
			},
			oidc.ClientSecretPost(captured.clientSecret),
			{
				[oidc.customFetch]: captured.fetch,
				timeout: captured.timeout,
				execute: [oidc.enableNonRepudiationChecks],
			},
		);
		validateMetadata(privateConfig, captured.issuer);
		return { ok: true, client: adapter(privateConfig, captured.issuer, captured.redirectUri) };
	} catch {
		return { ok: false, error: "oidc_discovery_failed" };
	}
}
