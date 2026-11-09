import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRootCommands } from "../command-tree.js";

const services = vi.hoisted(() => ({
	changedRead: false,
	identity: {
		device_id: null,
		actor_id_present: false,
		actor_id: null,
		config_path: null,
		runtime_root: null,
		workspace_id: null,
		home_dir: null,
		pack_compression: null,
		embedding_disabled: true,
		embedding_offline: true,
		embedding_model: "fixture-model",
		embedding_revision: null,
	},
	store: vi.fn(() => {
		throw new Error("unexpected database access");
	}),
}));
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			let read = false;
			return new Proxy(handle, {
				get(target, key) {
					if (key === "read")
						return async (...readArgs: unknown[]) => {
							read = true;
							return Reflect.apply(target.read, target, readArgs);
						};
					if (key === "stat")
						return async () => {
							const details = await target.stat();
							if (services.changedRead && read)
								return Object.assign(Object.create(details), { ctimeMs: details.ctimeMs + 1 });
							return details;
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});
vi.mock("@codemem/core", async (importActual) => ({
	...(await importActual<typeof import("@codemem/core")>()),
	buildViewerIdentityTarget: () => services.identity,
	MemoryStore: services.store,
	connect: services.store,
	connectReadOnly: services.store,
}));

const eventId = "recovery-fixture-private-event";
const receipt = `rejected-${createHash("sha256").update(eventId).digest("hex")}-400-invalid_payload.json`;
const envelope = {
	event_id: eventId,
	event_type: "user_prompt",
	session_id: "recovery-fixture-private-session",
	payload: { prompt_text: "recovery-fixture-private-text café" },
};
const serialized = ` \n${JSON.stringify(envelope, null, 2)}\t\n`;
const originalExitCode = process.exitCode;
let home: string;
let directory: string;
let dbPath: string;
let profile: Record<string, unknown>;
let statusBody: unknown;
let postResponse: () => Response;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-capture-recover-"));
	directory = join(home, ".codemem", "opencode-raw-event-spool");
	dbPath = join(home, "explicit.sqlite");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, receipt), serialized, { mode: 0o600 });
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_PLUGIN_LOG_PATH", join(home, "plugin.log"));
	vi.stubEnv("CODEMEM_DB", join(home, "wrong-env.sqlite"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_EMBEDDING_OFFLINE", "1");
	vi.stubEnv("CODEMEM_VIEWER_HOST", "127.0.0.1");
	vi.stubEnv("CODEMEM_VIEWER_PORT", "38888");
	profile = {
		service: "codemem-viewer",
		protocol_version: 1,
		min_supported_protocol_version: 1,
		db_path: dbPath,
		identity_target: services.identity,
	};
	statusBody = { ingest: { available: true, mode: "durable_queue", max_body_bytes: 1024 * 1024 } };
	postResponse = () => Response.json({ accepted: 1, queued: 1 }, { status: 202 });
	fetchMock = vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		if (url.origin !== "http://127.0.0.1:38888") throw new Error("unexpected origin");
		if (url.pathname === "/api/prompt-pack-profile") return Response.json(profile);
		if (url.pathname === "/api/raw-events/status") return Response.json(statusBody);
		if (url.pathname === "/api/raw-events" && init?.method === "POST") return postResponse();
		throw new Error("unexpected route");
	});
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	services.store.mockClear();
	services.changedRead = false;
	process.exitCode = undefined;
});

afterEach(async () => {
	expect(services.store).not.toHaveBeenCalled();
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await rm(home, { recursive: true, force: true });
});

function argumentsForRecovery() {
	return ["recover-rejected", receipt, "--db-path", dbPath, "-y", "--json"];
}

async function run(args = argumentsForRecovery()) {
	const command = registerRootCommands(new Command("codemem")).exitOverride();
	const diagnostics = command.commands.find((child) => child.name() === "diagnostics");
	const capture = diagnostics?.commands.find((child) => child.name() === "capture");
	expect(capture?.commands.some((child) => child.name() === "recover-rejected")).toBe(true);
	function overrideExits(parent: Command) {
		parent.exitOverride();
		for (const child of parent.commands) overrideExits(child);
	}
	overrideExits(command);
	try {
		await command.parseAsync(["diagnostics", "capture", ...args], { from: "user" });
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			!String(error.code).startsWith("commander.")
		)
			throw error;
		process.exitCode = 2;
	}
	return process.exitCode ?? 0;
}

function posts() {
	return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}

it.each([
	[202, { accepted: 1, queued: 1 }, "queued"],
	[200, { inserted: 1, skipped: 0, received: 1 }, "ingested"],
	[200, { inserted: 0, skipped: 1, received: 1 }, "ingested"],
])(
	"keeps an acknowledged HTTP %i receipt on request: %j",
	async (httpStatus, body, acknowledgement) => {
		// Arrange: keep the original inode, permissions, and whitespace as evidence.
		postResponse = () => Response.json(body, { status: httpStatus });
		const before = await stat(join(directory, receipt));
		// Act
		const code = await run([...argumentsForRecovery(), "--keep-receipt"]);
		// Assert
		expect(code).toBe(0);
		expect(posts()).toHaveLength(1);
		const output = vi
			.mocked(process.stdout.write)
			.mock.calls.map(([value]) => String(value))
			.join("");
		expect(JSON.parse(output)).toMatchObject({
			ok: true,
			recovery: { delivery: "accepted", acknowledgement, cleanup: "kept", lock: "released" },
		});
		expect(await stat(join(directory, receipt))).toMatchObject({
			ino: before.ino,
			mode: before.mode,
		});
		await expectRetained();
	},
);

it("explains that a successfully recovered receipt was retained at the user's request", async () => {
	// Arrange
	const args = argumentsForRecovery().filter((arg) => arg !== "--json");
	// Act
	const code = await run([...args, "--keep-receipt"]);
	// Assert
	expect(code).toBe(0);
	const output = JSON.stringify([
		...vi.mocked(process.stdout.write).mock.calls,
		...vi.mocked(console.log).mock.calls,
	]);
	expect(output).toMatch(/retain.*request|kept.*request/i);
	expect(output).toContain("Acknowledgement does not verify stored content.");
	await expectRetained();
});

it("reports incomplete recovery when keep-receipt loses lock ownership after ACK", async () => {
	// Arrange: swap the lock inode while returning a valid delivery ACK.
	const original = fetchMock.getMockImplementation();
	if (!original) throw new Error("missing fake fetch implementation");
	let replacementPath = "";
	let replacementBytes = Buffer.alloc(0);
	fetchMock.mockImplementation(async (input, init) => {
		const response = await original(input, init);
		if (init?.method === "POST") {
			const lock = (await readdir(directory)).find((name) => name.endsWith(".lock"));
			if (!lock) throw new Error("expected recovery lock");
			replacementPath = join(directory, lock);
			replacementBytes = await readFile(replacementPath);
			await rename(replacementPath, `${replacementPath}.original`);
			await writeFile(replacementPath, replacementBytes, { mode: 0o600 });
		}
		return response;
	});
	// Act
	const code = await run([...argumentsForRecovery(), "--keep-receipt"]);
	// Assert: ownership fails before the keep decision, and cannot report success.
	expect(code).toBe(1);
	expect(posts()).toHaveLength(1);
	const output = vi
		.mocked(process.stdout.write)
		.mock.calls.map(([value]) => String(value))
		.join("");
	expect(JSON.parse(output)).toMatchObject({
		ok: false,
		error: "retry_incomplete",
		recovery: {
			delivery: "accepted",
			acknowledgement: "queued",
			cleanup: "failed",
			lock: "release_failed",
		},
	});
	expect(await readFile(join(directory, receipt), "utf8")).toBe(serialized);
	expect(await readFile(replacementPath)).toEqual(replacementBytes);
});

it.each(["confirmation", "non-ACK", "changed snapshot"])(
	"keep-receipt does not bypass %s failure",
	async (failure) => {
		// Arrange
		const args = [...argumentsForRecovery(), "--keep-receipt"];
		if (failure === "confirmation") args.splice(args.indexOf("-y"), 1);
		if (failure === "non-ACK")
			postResponse = () => Response.json({ accepted: 0, queued: 0 }, { status: 202 });
		services.changedRead = failure === "changed snapshot";
		// Act
		const code = await run(args);
		// Assert
		expect(code).toBe(failure === "confirmation" ? 2 : 1);
		expect(posts()).toHaveLength(failure === "non-ACK" ? 1 : 0);
		await expectRetained();
	},
);

it("advertises keep-receipt as an optional recovery flag", () => {
	// Arrange
	const root = registerRootCommands(new Command("codemem"));
	const diagnostics = root.commands.find((command) => command.name() === "diagnostics");
	const capture = diagnostics?.commands.find((command) => command.name() === "capture");
	const recovery = capture?.commands.find((command) => command.name() === "recover-rejected");
	// Act
	const help = recovery?.helpInformation();
	// Assert
	expect(help).toContain("--keep-receipt");
	expect(recovery?.options.find((option) => option.long === "--keep-receipt")?.required).toBe(
		false,
	);
});

function firstPost() {
	const request = posts()[0];
	if (!request) throw new Error("expected a delivery POST");
	return request;
}

async function expectRetained() {
	expect(await readFile(join(directory, receipt), "utf8")).toBe(serialized);
	expect(await readdir(directory)).toEqual([receipt]);
}

it("expands a quoted home-relative explicit database path before target validation", async () => {
	// Arrange: argv contains the literal tilde that survives shell quoting.
	const args = argumentsForRecovery();
	args[args.indexOf("--db-path") + 1] = "~/explicit.sqlite";
	// Act
	const code = await run(args);
	// Assert
	expect(code).toBe(0);
	expect(JSON.parse(String(firstPost()[1]?.body))).toMatchObject({ db_path: dbPath });
	expect(await readdir(directory)).toEqual([]);
});

it.each([
	[
		"missing",
		"receipt_not_found",
		"Retained receipt was not found. Run capture list-rejected again.",
	],
	["unsafe", "unsafe_entry", "Receipt must name a regular file."],
])(
	"reports a safe %s receipt inspection error without delivery",
	async (kind, errorCode, message) => {
		// Arrange: the selected name is valid, but the entry is missing or a symlink.
		const selectedReceipt = receipt.replace("400-invalid_payload", "413-payload_too_large");
		if (kind === "unsafe")
			await symlink(join(directory, receipt), join(directory, selectedReceipt));
		const args = argumentsForRecovery();
		args[1] = selectedReceipt;
		// Act
		const code = await run(args);
		// Assert
		const text = vi
			.mocked(process.stdout.write)
			.mock.calls.map(([value]) => String(value))
			.join("");
		expect(code).toBe(1);
		expect(JSON.parse(text)).toMatchObject({ error: errorCode, message });
		expect(text).not.toContain(home);
		expect(text).not.toContain(selectedReceipt);
		expect(text).not.toMatch(/recovery-fixture-private/);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await readFile(join(directory, receipt), "utf8")).toBe(serialized);
	},
);

it.each(["changed_during_read", "read_limit_exceeded"])(
	"reports a specific safe %s validation failure",
	async (validation) => {
		// Arrange: inject a deterministic metadata change or use a sparse oversized fixture.
		services.changedRead = validation === "changed_during_read";
		if (validation === "read_limit_exceeded")
			await truncate(join(directory, receipt), 16 * 1024 * 1024 + 1);
		const before = await readFile(join(directory, receipt));
		// Act
		const code = await run();
		// Assert
		const text = vi
			.mocked(process.stdout.write)
			.mock.calls.map(([value]) => String(value))
			.join("");
		expect(code).toBe(1);
		expect(JSON.parse(text)).toMatchObject({
			error: validation,
			message: expect.stringMatching(
				validation === "changed_during_read" ? /changed.*read/i : /16 MiB.*limit/i,
			),
		});
		expect(text).not.toContain(home);
		expect(text).not.toContain(receipt);
		expect(text).not.toMatch(/recovery-fixture-private/);
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await readFile(join(directory, receipt))).equals(before)).toBe(true);
		expect(await readdir(directory)).toEqual([receipt]);
	},
);

it.each(["receipt", "database", "confirmation"])(
	"requires explicit %s before any HTTP",
	async (missing) => {
		// Arrange: an environment database is deliberately present but cannot authorize recovery.
		const args = argumentsForRecovery();
		if (missing === "receipt") args.splice(1, 1);
		if (missing === "database") args.splice(args.indexOf("--db-path"), 2);
		if (missing === "confirmation") args.splice(args.indexOf("-y"), 1);
		// Act
		const code = await run(args);
		// Assert
		expect(code).toBe(2);
		expect(fetchMock).not.toHaveBeenCalled();
		await expectRetained();
	},
);

it.each([
	[202, { accepted: 1, queued: 1 }],
	[200, { inserted: 1, skipped: 0, received: 1 }],
	[200, { inserted: 0, skipped: 1, received: 1 }],
])(
	"removes the selected receipt only after strict HTTP %i acknowledgement %j",
	async (httpStatus, body) => {
		// Arrange
		postResponse = () => Response.json(body, { status: httpStatus });
		const otherReceipt = receipt.replace("400-invalid_payload", "413-payload_too_large");
		await writeFile(join(directory, otherReceipt), serialized, { mode: 0o600 });
		// Act
		const code = await run();
		// Assert: the original UTF-8 and whitespace must survive insertion into the batch envelope.
		expect(code).toBe(0);
		expect(posts()).toHaveLength(1);
		const [url, init] = firstPost();
		expect(String(url)).toBe("http://127.0.0.1:38888/api/raw-events");
		expect(init?.body).toEqual(expect.any(String));
		expect(String(init?.body)).toContain(serialized);
		expect(JSON.parse(String(init?.body))).toMatchObject({
			db_path: dbPath,
			identity_target: services.identity,
		});
		for (const [, request] of fetchMock.mock.calls) {
			expect(request?.redirect).toBe("error");
			expect(request?.signal).toBeInstanceOf(AbortSignal);
		}
		expect(await readdir(directory)).toEqual([otherReceipt]);
		expect(await readFile(join(directory, otherReceipt), "utf8")).toBe(serialized);
	},
);

it.each([
	[202, { accepted: 0, queued: 0 }],
	[202, { accepted: 1 }],
	[202, { accepted: 1, queued: 2 }],
	[202, { accepted: "1", queued: 1 }],
	[200, { inserted: 0, skipped: 0, received: 1 }],
	[200, { inserted: 1, skipped: 1, received: 1 }],
	[200, { inserted: 1, skipped: 0, received: 2 }],
	[200, { inserted: 1, skipped: 0 }],
	[200, { accepted: 1, queued: 1 }],
	[201, { accepted: 1, queued: 1 }],
	[400, { accepted: 1, queued: 1 }],
	[413, { accepted: 1, queued: 1 }],
	[503, { accepted: 1, queued: 1 }],
	[202, null],
	[202, []],
])("retains exact bytes for ambiguous HTTP %i acknowledgement %j", async (httpStatus, body) => {
	// Arrange
	postResponse = () => Response.json(body, { status: httpStatus });
	// Act
	const code = await run();
	// Assert
	expect(code).toBe(1);
	expect(posts()).toHaveLength(1);
	await expectRetained();
});

it.each(["wrong service", "wrong database", "wrong identity", "missing identity", "protocol"])(
	"denies %s profile without delivery",
	async (kind) => {
		// Arrange
		if (kind === "wrong service") profile.service = "other-service";
		if (kind === "wrong database") profile.db_path = join(home, "other.sqlite");
		if (kind === "wrong identity")
			profile.identity_target = { ...services.identity, device_id: "other" };
		if (kind === "missing identity") delete profile.identity_target;
		if (kind === "protocol") {
			profile.protocol_version = 999;
			profile.min_supported_protocol_version = 999;
		}
		// Act
		const code = await run();
		// Assert
		expect(code).toBe(1);
		expect(posts()).toHaveLength(0);
		await expectRetained();
	},
);

it.each([
	{},
	{ ingest: { available: false, max_body_bytes: 1024 } },
	{ ingest: { available: true } },
	{ ingest: { available: true, max_body_bytes: 0 } },
	{ ingest: { available: true, max_body_bytes: "1024" } },
])("denies unavailable or malformed status %j before delivery", async (body) => {
	// Arrange
	statusBody = body;
	// Act
	const code = await run();
	// Assert
	expect(code).toBe(1);
	expect(posts()).toHaveLength(0);
	await expectRetained();
});

it.each(["profile", "status", "post"])(
	"preserves bytes on a %s redirect without following it",
	async (stage) => {
		// Arrange
		const route = {
			profile: "/api/prompt-pack-profile",
			status: "/api/raw-events/status",
			post: "/api/raw-events",
		}[stage];
		const original = fetchMock.getMockImplementation();
		if (!original) throw new Error("missing fake fetch implementation");
		fetchMock.mockImplementation(async (input, init) => {
			if (new URL(String(input)).pathname === route)
				return new Response(null, {
					status: 307,
					headers: { Location: "https://unapproved.invalid/private" },
				});
			return original(input, init);
		});
		// Act
		const code = await run();
		// Assert
		expect(code).toBe(1);
		expect(posts()).toHaveLength(stage === "post" ? 1 : 0);
		expect(
			fetchMock.mock.calls.every(
				([url]) => new URL(String(url)).origin === "http://127.0.0.1:38888",
			),
		).toBe(true);
		await expectRetained();
	},
);

it.each(["network", "timeout", "invalid JSON"])(
	"preserves bytes on delivery %s without retry or fallback",
	async (kind) => {
		// Arrange
		postResponse = () => {
			if (kind === "invalid JSON") return new Response("{private-diagnostic", { status: 202 });
			if (kind === "timeout") throw new DOMException("private-diagnostic", "TimeoutError");
			throw new TypeError("private-diagnostic");
		};
		// Act
		const code = await run();
		// Assert
		expect(code).toBe(1);
		expect(posts()).toHaveLength(1);
		await expectRetained();
		expect(JSON.stringify(vi.mocked(process.stdout.write).mock.calls)).not.toMatch(
			/private-diagnostic|recovery-fixture-private/,
		);
	},
);

it.each(["profile", "status"])(
	"retains bytes when %s preflight returns invalid JSON",
	async (stage) => {
		// Arrange
		const route = stage === "profile" ? "/api/prompt-pack-profile" : "/api/raw-events/status";
		const original = fetchMock.getMockImplementation();
		if (!original) throw new Error("missing fake fetch implementation");
		fetchMock.mockImplementation(async (input, init) => {
			if (new URL(String(input)).pathname === route)
				return new Response("{private-diagnostic", { status: 200 });
			return original(input, init);
		});
		// Act
		const code = await run();
		// Assert
		expect(code).toBe(1);
		expect(posts()).toHaveLength(0);
		await expectRetained();
	},
);

it.each(["../escape.json", "rejected-malformed.json"])(
	"rejects malformed receipt %s without delivery",
	async (invalidReceipt) => {
		// Arrange
		const args = argumentsForRecovery();
		args[1] = invalidReceipt;
		// Act
		const code = await run(args);
		// Assert
		expect(code).toBe(2);
		expect(posts()).toHaveLength(0);
		await expectRetained();
	},
);

it.each(["JSON", "identity", "UTF-8"])(
	"refuses invalid retained %s without delivery or rewriting",
	async (kind) => {
		// Arrange
		let bytes = Buffer.from("{private-corrupt");
		if (kind === "identity")
			bytes = Buffer.from(JSON.stringify({ ...envelope, event_id: "other" }));
		if (kind === "UTF-8") bytes = Buffer.from([0xff, 0x20]);
		await writeFile(join(directory, receipt), bytes, { mode: 0o600 });
		// Act
		const code = await run();
		// Assert
		expect(code).toBe(1);
		expect(posts()).toHaveLength(0);
		expect(await readFile(join(directory, receipt))).toEqual(bytes);
		expect(await readdir(directory)).toEqual([receipt]);
	},
);

it.each(["bad-port", "0", "65536"])(
	"rejects malformed viewer port %s before any HTTP",
	async (port) => {
		// Arrange
		vi.stubEnv("CODEMEM_VIEWER_PORT", port);
		// Act
		const code = await run();
		// Assert
		expect(code).toBeGreaterThan(0);
		expect(fetchMock).not.toHaveBeenCalled();
		await expectRetained();
	},
);

it.each(["example.invalid", "127.0.0.1@evil.invalid", "127.0.0.1/path", "0.0.0.0"])(
	"rejects unapproved viewer host %s before any HTTP",
	async (host) => {
		// Arrange
		vi.stubEnv("CODEMEM_VIEWER_HOST", host);
		// Act
		const code = await run();
		// Assert
		expect(code).toBeGreaterThan(0);
		expect(fetchMock).not.toHaveBeenCalled();
		await expectRetained();
	},
);

it.each(["profile", "status"])("does not fall back after denied %s preflight", async (stage) => {
	// Arrange
	const route = stage === "profile" ? "/api/prompt-pack-profile" : "/api/raw-events/status";
	const original = fetchMock.getMockImplementation();
	if (!original) throw new Error("missing fake fetch implementation");
	fetchMock.mockImplementation(async (input, init) => {
		if (new URL(String(input)).pathname === route)
			return Response.json({ error: "denied" }, { status: 403 });
		return original(input, init);
	});
	// Act
	const code = await run();
	// Assert
	expect(code).toBe(1);
	expect(posts()).toHaveLength(0);
	expect(fetchMock.mock.calls).toHaveLength(stage === "profile" ? 1 : 2);
	await expectRetained();
});

it.each([0, -1])(
	"enforces the full UTF-8 request cap at actual envelope size %+i",
	async (offset) => {
		// Arrange: a non-ACK captures the valid request without consuming the retained receipt.
		postResponse = () => Response.json({ accepted: 0, queued: 0 }, { status: 202 });
		expect(await run()).toBe(1);
		expect(posts()).toHaveLength(1);
		const firstBody = String(firstPost()[1]?.body);
		const fullBytes = Buffer.byteLength(firstBody, "utf8");
		expect(fullBytes).toBeGreaterThan(Buffer.byteLength(serialized, "utf8"));
		expect(fullBytes).toBeGreaterThan(firstBody.length);
		statusBody = {
			ingest: { available: true, mode: "durable_queue", max_body_bytes: fullBytes + offset },
		};
		postResponse = () => Response.json({ accepted: 1, queued: 1 }, { status: 202 });
		fetchMock.mockClear();
		process.exitCode = undefined;
		// Act
		const code = await run();
		// Assert: a one-byte excess must fail even though the retained event alone fits.
		if (offset === 0) {
			expect(code).toBe(0);
			expect(posts()).toHaveLength(1);
			expect(Buffer.byteLength(String(firstPost()[1]?.body), "utf8")).toBe(fullBytes);
			expect(await readdir(directory)).toEqual([]);
		} else {
			expect(code).toBe(1);
			expect(posts()).toHaveLength(0);
			await expectRetained();
		}
	},
);
