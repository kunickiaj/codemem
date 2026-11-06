import { BlockList, isIP } from "node:net";
import { createMiddleware } from "hono/factory";

export interface ViewerAuthorityOptions {
	/** Trusted configured host, actual port and optional bound IP, or null before listening. */
	getListenerAddress: () => { host: string; port: number; address?: string } | null;
}

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_ADDRESSES.addAddress("::1", "ipv6");

function listenerHostname(host: string): string | null {
	if (typeof host !== "string" || !host) return null;
	if (/[\s/@\\?#%]/u.test(host)) return null;
	if (
		[...host].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	) {
		return null;
	}
	const authority = isIP(host) === 6 ? `[${host}]` : host;
	if (authority.includes(":") && !/^\[[0-9a-fA-F:.]+\]$/.test(authority)) return null;
	try {
		// Trusted configuration may use Node-supported numeric shorthand or DNS forms.
		// Canonicalize before classification so shorthand cannot enable external mode.
		const hostname = new URL(`http://${authority}`).hostname;
		if (hostname.startsWith("[")) return hostname.slice(1, -1);
		return hostname.replace(/\.$/, "");
	} catch {
		return null;
	}
}

function loopbackAliases(hostname: string): readonly string[] | null {
	if (hostname === "localhost") return ["localhost", "127.0.0.1", "[::1]"];
	if (isIP(hostname) === 6) {
		// Node also matches IPv4-mapped IPv6 against the IPv4 loopback subnet.
		if (LOOPBACK_ADDRESSES.check(hostname, "ipv6")) return [`[${hostname}]`, "localhost"];
		return null;
	}
	if (isIP(hostname) === 4 && LOOPBACK_ADDRESSES.check(hostname, "ipv4"))
		return [hostname, "localhost"];
	return null;
}

function listenerPolicy(
	options: ViewerAuthorityOptions,
): { aliases: readonly string[] | null; port: number } | null {
	try {
		const address = options.getListenerAddress();
		if (!address || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
			return null;
		}
		const hostname = listenerHostname(address.host);
		if (!hostname) return null;
		if (address.address === undefined) {
			return { aliases: loopbackAliases(hostname), port: address.port };
		}
		if (typeof address.address !== "string" || !isIP(address.address)) return null;
		const boundHostname = listenerHostname(address.address);
		if (!boundHostname) return null;
		const aliases = loopbackAliases(boundHostname);
		if (!aliases) return { aliases: null, port: address.port };
		const configuredAlias = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
		// Only the bound IP decides exposure. Keep intentional DNS names and localhost aliases.
		const configuredAliases = hostname === "localhost" ? loopbackAliases(hostname) : null;
		return {
			aliases: [...new Set([...aliases, configuredAlias, ...(configuredAliases ?? [])])],
			port: address.port,
		};
	} catch {
		// An unavailable or invalid trusted callback must never disable protection.
		return null;
	}
}

function parseHost(host: string, protocol: string): URL | null {
	// URL parsing alone accepts userinfo, paths, whitespace, and numeric shorthand.
	const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(host);
	if (!match?.[1]) return null;
	if (match[2] !== undefined) {
		const port = Number(match[2]);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	}
	try {
		const parsed = new URL(`${protocol}//${host}`);
		const hostname = match[1].toLowerCase();
		if (!hostname.startsWith("[") && parsed.hostname !== hostname) return null;
		return parsed;
	} catch {
		return null;
	}
}

function validLoopbackAuthority(
	requestUrl: string,
	host: string | undefined,
	policy: { aliases: readonly string[]; port: number },
): boolean {
	if (!host) return false;
	try {
		const url = new URL(requestUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (url.username || url.password) return false;
		const authority = parseHost(host, url.protocol);
		if (!authority || authority.host !== url.host) return false;
		const port = Number(authority.port || (url.protocol === "https:" ? 443 : 80));
		return port === policy.port && policy.aliases.includes(authority.hostname);
	} catch {
		return false;
	}
}

/**
 * Protect every loopback viewer request before preflight and route dispatch.
 * Explicit external listeners retain their existing external-auth requirements.
 * Proxy forwarding headers never supply trusted listener or request authority.
 */
export function viewerAuthorityGuard(options?: ViewerAuthorityOptions) {
	return createMiddleware(async (c, next) => {
		// Listener-less embedding callers own authority validation at their boundary.
		if (!options) return next();
		const policy = listenerPolicy(options);
		if (!policy) return c.json({ error: "forbidden" }, 403);
		if (
			policy.aliases &&
			!validLoopbackAuthority(c.req.url, c.req.header("Host"), {
				...policy,
				aliases: policy.aliases,
			})
		) {
			return c.json({ error: "forbidden" }, 403);
		}
		await next();
	});
}
