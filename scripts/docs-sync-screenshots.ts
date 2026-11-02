import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Locator, Page, Route } from "@playwright/test";
import type {
	OverallSyncHealth,
	PeerSyncHealth,
	SyncDirectionHealth,
} from "../packages/ui/src/lib/sync-health.js";

// No application server, store, runtime configuration, or device keys are loaded.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATIC = resolve(ROOT, "packages/viewer-server/static");
const OUTPUT = resolve(ROOT, ".tmp/docs-screenshots");
const NOW = "2026-11-02T18:00:00.000Z";
const SUCCESS = "2026-11-02T17:57:00.000Z";
const DEVICES = ["Laptop", "Studio", "Workshop", "Notebook"] as const;
const IDENTITY = "docs-person";
const PROJECT = "docs-atlas-notes";
const requireFromUi = createRequire(new URL("../packages/ui/package.json", import.meta.url));
const { chromium, expect } = requireFromUi("@playwright/test") as typeof import("@playwright/test");

interface CaptureProfile {
	theme: "dark" | "light";
	name: string;
	viewport: { width: number; height: number };
	fullPage?: boolean;
	detailsDevice?: string;
}

function captureProfiles(): CaptureProfile[] {
	if (!process.argv.includes("--preview")) {
		return (["dark", "light"] as const).map((theme) => ({
			theme,
			name: `docs-devices-sync-${theme}`,
			viewport: { width: 1440, height: 1050 },
		}));
	}
	return [
		{ theme: "dark", name: "sync-overview-dark", viewport: { width: 1440, height: 900 } },
		{ theme: "light", name: "sync-overview-light", viewport: { width: 1440, height: 900 } },
		{
			theme: "dark",
			name: "sync-details-dark",
			viewport: { width: 1440, height: 1050 },
			detailsDevice: "notebook",
			fullPage: true,
		},
		{
			theme: "dark",
			name: "sync-overview-tablet",
			viewport: { width: 1024, height: 900 },
			fullPage: true,
		},
		{
			theme: "dark",
			name: "sync-overview-mobile",
			viewport: { width: 390, height: 844 },
			fullPage: true,
		},
	];
}

async function localFontStyles(): Promise<string> {
	const fonts = [
		{ family: "Geist", name: "geist" },
		{ family: "JetBrains Mono", name: "jetbrains-mono" },
	];
	const styles = await Promise.all(
		fonts.map(async ({ family, name }) => {
			const file = resolve(
				ROOT,
				`packages/ui/node_modules/@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`,
			);
			const bytes = await readFile(file);
			return `@font-face { font-family: "${family}"; font-style: normal; font-weight: 100 900; font-display: block; src: url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2"); }`;
		}),
	);
	return `<style>${styles.join("\n")}</style>`;
}

function direction(
	state: SyncDirectionHealth["state"],
	operations: number | null,
): SyncDirectionHealth {
	return {
		state,
		last_attempt_at: state === "not_verified" ? null : SUCCESS,
		last_success_at: state === "succeeded" ? SUCCESS : null,
		operations_24h: operations,
		pending_count: null,
		reason_code: state === "needs_attention" ? "transfer_failed" : null,
	};
}

function peerHealth(name: string): PeerSyncHealth {
	if (name === "Studio")
		return {
			state: "exchange_succeeded",
			send: direction("succeeded", 12),
			receive: direction("succeeded", 8),
		};
	if (name === "Workshop")
		return {
			state: "not_verified",
			send: direction("not_verified", null),
			receive: direction("succeeded", 5),
		};
	return {
		state: "needs_attention",
		send: direction("needs_attention", 0),
		receive: direction("not_verified", null),
	};
}

function devices() {
	return DEVICES.map((displayName) => ({
		version: 1,
		identityId: IDENTITY,
		deviceId: `docs-${displayName.toLowerCase()}`,
		displayName,
		status: "active",
	}));
}

function syncStatus() {
	const sync_health: OverallSyncHealth = {
		state: "needs_attention",
		peer_count: 3,
		attention_count: 1,
		unverified_count: 1,
		stale_count: 0,
	};
	return {
		sync_health,
		status: {
			enabled: true,
			device_id: "docs-laptop",
			actor_id: IDENTITY,
			sync_health,
			runtime: { phase: "running" },
		},
		peers: devices()
			.slice(1)
			.map((device) => ({
				peer_device_id: device.deviceId,
				name: device.displayName,
				actor_id: IDENTITY,
				actor_display_name: "Demo Developer",
				pinned: true,
				trust_state: "trusted",
				runtime_version: "0.47.3",
				runtime_version_observed_at: SUCCESS,
				status: { peer_state: "online", sync_status: "ok", ping_status: "ok" },
				sync_health: peerHealth(device.displayName),
				last_sync_at: SUCCESS,
				last_sync_status: device.displayName === "Notebook" ? "error" : "ok",
			})),
		attempts: [],
		legacy_devices: [],
		join_requests: [],
		sharing_review: [],
		coordinator: null,
	};
}

function recipientIntent() {
	return {
		version: 1,
		identities: [
			{
				version: 1,
				identityId: IDENTITY,
				displayName: "Demo Developer",
				kind: "personal",
				verification: "local",
				status: "active",
				mergedIntoIdentityId: null,
			},
		],
		teams: [],
		teamMemberships: [],
		identityDevices: devices(),
		projectRecipients: [
			{
				version: 1,
				canonicalProjectIdentity: PROJECT,
				recipientKind: "identity",
				identityId: IDENTITY,
				intentSource: "user",
				policyRevision: "docs-revision",
				status: "active",
			},
		],
	};
}

function deviceInventory() {
	return {
		version: 1,
		items: devices().map((device) => ({
			...device,
			evidenceDeviceIds: [device.deviceId],
			state: "configured",
			suggestedIdentityId: null,
			validatedFingerprint: null,
			isLocal: device.displayName === "Laptop",
			sources: ["identity_binding"],
			conflictCodes: [],
		})),
		coordinatorEvidence: { availability: "available", safeErrorCode: null },
		truncated: false,
	};
}

function fixtures(): Map<string, unknown> {
	return new Map<string, unknown>([
		["/api/runtime", { version: "0.0.0-docs" }],
		["/api/viewer-status", { identity: { actor_id: IDENTITY } }],
		["/api/projects", { projects: ["Atlas Notes"] }],
		["/api/config", { config: {}, defaults: {}, effective: {} }],
		["/api/observer-status", { status: "disabled", enabled: false }],
		[
			"/api/update-status",
			{
				current_version: "0.0.0-docs",
				latest_version: null,
				update_available: false,
				stale: false,
				install_kind: "repo-dev",
				auto_update_eligible: false,
				error: null,
			},
		],
		["/api/sync/status", syncStatus()],
		["/api/sync/actors", { items: [] }],
		["/api/coordinator/admin/status", { configured: false, groups: [], devices: [] }],
		["/api/sync/share-operations", { items: [] }],
		[
			"/api/sync/projects",
			{
				projects: [
					{
						workspace_identity: PROJECT,
						identity_source: "git_remote",
						display_project: "Atlas Notes",
						memory_count: 24,
						read_only: false,
					},
				],
				has_more: false,
				limit: 250,
				offset: 0,
			},
		],
		["/api/sync/recipient-policy/v1/intent", recipientIntent()],
		["/api/sync/recipient-policy/v1/device-inventory", deviceInventory()],
		[
			"/api/sync/recipient-policy/v1/reconciliation-status",
			{
				version: 1,
				items: [
					{
						canonicalProjectIdentity: PROJECT,
						state: "active",
						label: "Up to date",
						explanation: "Future activity is ready for this device.",
						deliveredCopiesMayRemain: true,
						revocationWarning: "Previously delivered copies may remain.",
					},
				],
			},
		],
	]);
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

async function staticFile(pathname: string): Promise<string | null> {
	const asset = pathname.startsWith("/assets/") ? pathname.slice("/assets".length) : pathname;
	const candidate = resolve(
		STATIC,
		`.${decodeURIComponent(asset === "/" ? "/index.html" : asset)}`,
	);
	if (!candidate.startsWith(`${STATIC}${sep}`)) return null;
	try {
		const actual = await realpath(candidate);
		if (!actual.startsWith(`${STATIC}${sep}`) || !(await stat(actual)).isFile()) return null;
		return actual;
	} catch {
		return null;
	}
}

function fixtureJson(payload: unknown, options: { live: boolean }): string {
	if (!options.live) return JSON.stringify(payload);
	const now = Date.now();
	const times = new Map([
		[NOW, new Date(now).toISOString()],
		[SUCCESS, new Date(now - 3 * 60_000).toISOString()],
	]);
	return JSON.stringify(payload, (_key, value) =>
		typeof value === "string" ? (times.get(value) ?? value) : value,
	);
}

function serveFixtureApi(
	request: IncomingMessage,
	response: ServerResponse,
	pathname: string,
	mocks: Map<string, unknown>,
	options: { live: boolean },
): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { "Content-Type": "application/json", Allow: "GET, HEAD" });
		response.end(JSON.stringify({ error: "preview_read_only" }));
		return true;
	}
	if (!pathname.startsWith("/api/")) return false;
	const known = mocks.has(pathname);
	response.writeHead(known ? 200 : 404, { "Content-Type": "application/json" });
	const payload = known ? mocks.get(pathname) : { error: "unknown_preview_request" };
	response.end(request.method === "HEAD" ? undefined : fixtureJson(payload, options));
	return true;
}

async function startStaticServer(): Promise<{ server: Server; origin: string }> {
	const fonts = await localFontStyles();
	const live = process.argv.includes("--serve");
	const mocks = fixtures();
	const server = createServer((request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
		);
		void (async () => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (serveFixtureApi(request, response, url.pathname, mocks, { live })) return;
			const path = await staticFile(url.pathname);
			if (!path) {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, {
				"Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
				"Cache-Control": "no-store",
			});
			if (request.method === "HEAD") {
				response.end();
				return;
			}
			const body = await readFile(path);
			// Remove remote font links before parsing, so even preconnects stay offline.
			response.end(
				extname(path) === ".html"
					? body
							.toString()
							.replace(/<link\b[^>]*https:\/\/[^>]*>/g, "")
							.replace("</head>", `${fonts}</head>`)
					: body,
			);
		})().catch(() => {
			response.writeHead(500).end();
		});
	});
	await new Promise<void>((resolveListening, reject) => {
		server.once("error", reject);
		server.listen(live ? 18763 : 0, "127.0.0.1", resolveListening);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function routeRequest(
	route: Route,
	origin: string,
	failures: string[],
	mocks: Map<string, unknown>,
): Promise<void> {
	const request = route.request();
	const url = new URL(request.url());
	if (request.method() !== "GET" || url.origin !== origin) {
		failures.push("Blocked mutation or external request");
		await route.abort();
		return;
	}
	if (mocks.has(url.pathname)) {
		await route.fulfill({ status: 200, json: mocks.get(url.pathname) });
		return;
	}
	if (!url.pathname.startsWith("/api/") && (await staticFile(url.pathname))) {
		await route.continue();
		return;
	}
	failures.push(`Unexpected GET ${url.pathname}`);
	await route.abort();
}

async function verifyDirection(
	row: Locator,
	options: { index: number; label: string; value: string; state: string },
): Promise<void> {
	const metric = row.locator(".device-sync-direction").nth(options.index);
	await expect(metric.locator(".device-sync-metric-heading")).toContainText(options.label);
	await expect(metric.locator(".device-sync-metric-value strong > [aria-hidden]")).toHaveText(
		options.value,
	);
	await expect(metric).toHaveAttribute("data-state", options.state);
}

async function verifyDevices(page: Page): Promise<void> {
	await expect(
		page.locator(".devices-local-row").getByText("Owned by Demo Developer", { exact: true }),
	).toBeVisible();
	for (const name of DEVICES.slice(1))
		await expect(
			page
				.locator(`#device-identity-card-docs-${name.toLowerCase()}`)
				.getByText(name, { exact: true }),
		).toBeVisible();
	const studio = page.locator("#device-identity-card-docs-studio");
	await verifyDirection(studio, { index: 0, label: "Sent", value: "12", state: "succeeded" });
	await verifyDirection(studio, { index: 1, label: "Received", value: "8", state: "succeeded" });
	const workshop = page.locator("#device-identity-card-docs-workshop");
	await verifyDirection(workshop, {
		index: 0,
		label: "Sent",
		value: "—",
		state: "not_verified",
	});
	await verifyDirection(workshop, { index: 1, label: "Received", value: "5", state: "succeeded" });
	const notebook = page.locator("#device-identity-card-docs-notebook");
	await verifyDirection(notebook, {
		index: 0,
		label: "Sent",
		value: "0",
		state: "needs_attention",
	});
	await expect(notebook.locator(".device-sync-failure")).toBeVisible();
	await expect(page.locator(".sync-health-summary:visible")).toHaveAttribute(
		"data-state",
		"needs_attention",
	);
	await expect(page.locator(".device-sync-details[open]")).toHaveCount(0);
}

async function verifyLayout(page: Page, profile: CaptureProfile): Promise<void> {
	const layout = await page.evaluate(() => ({
		width: window.innerWidth,
		contentWidth: document.documentElement.scrollWidth,
	}));
	assert(layout.contentWidth <= layout.width, "Device metrics must not overflow the viewport");
	if (profile.fullPage || profile.detailsDevice) return;
	const lastRow = await page.locator("#device-identity-card-docs-workshop").boundingBox();
	assert(lastRow, "The final fixture device must be rendered");
	if (lastRow.y + lastRow.height > profile.viewport.height) {
		await page.screenshot({
			path: resolve(OUTPUT, `${profile.name}-layout-diagnostic.png`),
			fullPage: true,
			animations: "disabled",
		});
	}
	assert(
		lastRow.y + lastRow.height <= profile.viewport.height,
		`Device rows end at ${Math.ceil(lastRow.y + lastRow.height)}px in a ${profile.viewport.height}px viewport`,
	);
}

async function openSyncDetails(page: Page, device: string): Promise<void> {
	const row = page.locator(`#device-identity-card-docs-${device}`);
	const disclosure = row.locator(".device-sync-details");
	const toggle = disclosure.locator("summary");
	await toggle.focus();
	await toggle.press("Enter");
	await expect(disclosure).toHaveAttribute("open", "");
	await toggle.press("Space");
	await expect(disclosure).not.toHaveAttribute("open", "");
	await toggle.click();
	await expect(row.locator(".device-sync-details-content")).toBeVisible();
}

async function capture(browser: Browser, origin: string, profile: CaptureProfile): Promise<void> {
	const context: BrowserContext = await browser.newContext({
		viewport: profile.viewport,
		colorScheme: profile.theme,
		locale: "en-US",
		timezoneId: "America/Los_Angeles",
		deviceScaleFactor: 1,
		serviceWorkers: "block",
	});
	const failures: string[] = [];
	try {
		await context.route("**/*", (route) => routeRequest(route, origin, failures, fixtures()));
		await context.routeWebSocket(/.*/, (socket) => {
			failures.push("Blocked WebSocket");
			socket.close();
		});
		await context.addInitScript((mode) => {
			localStorage.setItem("codemem-theme", mode);
		}, profile.theme);
		const page = await context.newPage();
		page.on("pageerror", () => failures.push("Unexpected browser application error"));
		await page.clock.setFixedTime(new Date(NOW));
		await page.goto(`${origin}/#devices`, { waitUntil: "networkidle" });
		assert.equal(failures.length, 0, `Capture rejected: ${failures.join(", ")}`);
		await page.addStyleTag({ content: "#metaLine { display: none !important; }" });
		await verifyDevices(page);
		if (profile.detailsDevice) {
			await openSyncDetails(page, profile.detailsDevice);
		}
		await verifyLayout(page, profile);
		await page.evaluate(() =>
			Promise.all([
				document.fonts.load('400 14px "Geist"'),
				document.fonts.load('400 12px "JetBrains Mono"'),
			]),
		);
		await page.evaluate(() => document.fonts.ready);
		const loadedFamilies = await page.evaluate(() =>
			[...document.fonts]
				.filter((font) => font.status === "loaded")
				.map((font) => font.family.replaceAll('"', "")),
		);
		assert(loadedFamilies.includes("Geist"), "The viewer font must load from the local fixture");
		assert(loadedFamilies.includes("JetBrains Mono"), "The metric font must load locally");
		assert.equal(failures.length, 0, `Capture rejected: ${failures.join(", ")}`);
		await page.screenshot({
			path: resolve(OUTPUT, `${profile.name}.png`),
			fullPage: profile.fullPage ?? false,
			animations: "disabled",
		});
		assert.deepEqual(failures, []);
	} finally {
		await context.close();
	}
}

async function main(): Promise<void> {
	if (!existsSync(resolve(STATIC, "index.html")))
		throw new Error("Build viewer assets first: pnpm --filter @codemem/ui build");
	await mkdir(OUTPUT, { recursive: true });
	const { server, origin } = await startStaticServer();
	if (process.argv.includes("--serve")) {
		process.stdout.write(`Read-only fictional viewer: ${origin}/#devices\n`);
		return;
	}
	try {
		const browser = await chromium.launch({ headless: true });
		try {
			for (const profile of captureProfiles()) await capture(browser, origin, profile);
		} finally {
			await browser.close();
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolveClosed, reject) =>
			server.close((error) => (error ? reject(error) : resolveClosed())),
		);
	}
	process.stdout.write(
		"Captured fictional Devices screenshots in .tmp/docs-screenshots. Inspect both images before copying to docs/images.\n",
	);
}

void main().catch((error: unknown) => {
	// Avoid printing browser diagnostics containing machine-specific executable paths.
	const message = error instanceof Error ? error.message : "unknown error";
	const detail = message.startsWith("expect(") ? message : message.split("\n")[0];
	process.stderr.write(`Docs screenshot capture failed: ${detail}\n`);
	process.exitCode = 1;
});
