import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	readCodememConfigFile: vi.fn(),
	readCodememConfigFileAtPath: vi.fn(),
	confirm: vi.fn(),
	isCancel: vi.fn((value) => typeof value === "symbol"),
	log: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	readCodememConfigFile: mocks.readCodememConfigFile,
	readCodememConfigFileAtPath: mocks.readCodememConfigFileAtPath,
}));
vi.mock("@clack/prompts", () => ({
	confirm: mocks.confirm,
	isCancel: mocks.isCancel,
	log: mocks.log,
}));

import { buildCoordinatorQualifyOwnerCommand } from "./coordinator-qualify-owner.js";

// Real CLI, action, config normalization and HTTP client; only transport and user I/O are mocked.
// These synthetic responses test the client contract, not server authority or a mounted endpoint.
const reference = `controller-v1:${"a".repeat(64)}`;
const config = {
	sync_coordinator_url: "https://saved.example.test",
	sync_coordinator_admin_secret: "fixture-admin-secret",
};
const preview = {
	state: "ready",
	attestation_id: reference,
	evidence_digest: "b".repeat(64),
	fingerprint: "c".repeat(64),
	coordinator_id: "coordinator-a",
	review_receipt_id: "receipt-a",
	link_id: "link-a",
	claim_id: "claim-a",
	identity_id: "identity-a",
	group_id: "group-a",
	device_id: "device-a",
};
const committed = {
	state: "created",
	qualification_id: "qualification-a",
	attestation_id: reference,
	coordinator_id: preview.coordinator_id,
	evidence_digest: preview.evidence_digest,
};
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const exitCode = process.exitCode;

function reply(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}
function run(args: string[] = [], attestationId = reference) {
	return buildCoordinatorQualifyOwnerCommand().parseAsync([attestationId, ...args], {
		from: "user",
	});
}
function output() {
	return JSON.stringify([
		...Object.values(mocks.log).map((log) => log.mock.calls),
		vi.mocked(process.stdout.write).mock.calls,
		vi.mocked(console.log).mock.calls,
	]);
}
function bodies() {
	return vi
		.mocked(fetch)
		.mock.calls.map(([, init]) => JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)));
}
beforeEach(() => {
	vi.resetAllMocks();
	for (const key of [
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
		"CODEMEM_SYNC_COORDINATOR_TIMEOUT_S",
	])
		vi.stubEnv(key, undefined);
	process.exitCode = undefined;
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	mocks.readCodememConfigFile.mockReturnValue(config);
	mocks.readCodememConfigFileAtPath.mockReturnValue(config);
	mocks.confirm.mockResolvedValue(false);
	mocks.isCancel.mockImplementation((value) => typeof value === "symbol");
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("unexpected extra request"))
		.mockResolvedValueOnce(reply(preview));
});
afterEach(() => {
	expect(output()).not.toContain(config.sync_coordinator_admin_secret);
	if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	if (stderrTty) Object.defineProperty(process.stderr, "isTTY", stderrTty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	process.exitCode = exitCode;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it.each(["created", "existing"])(
	"explicit Yes confirms the exact preview digest: %s",
	async (state) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		vi.mocked(fetch).mockResolvedValueOnce(reply({ ...committed, state }));
		// Act
		await run();
		// Assert
		expect(bodies()).toEqual([
			{ attestation_id: reference },
			{ attestation_id: reference, confirm_evidence_digest: preview.evidence_digest },
		]);
		for (const [url, init] of vi.mocked(fetch).mock.calls) {
			expect(url).toBe(`${config.sync_coordinator_url}/v1/admin/owner-qualifications`);
			expect(init).toMatchObject({ method: "POST", redirect: "error" });
			const headers = new Headers(init?.headers);
			expect(headers.get("x-codemem-coordinator-admin")).toBe(config.sync_coordinator_admin_secret);
			expect(headers.has("origin")).toBe(false);
		}
		expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ initialValue: false, output: process.stderr }),
		);
		expect(mocks.readCodememConfigFile).toHaveBeenCalledTimes(2);
		expect(mocks.log.success).toHaveBeenCalledExactlyOnceWith(
			"Linked account qualified for device enrollment. Team and Project access are unchanged.",
			{ output: process.stderr },
		);
		expect(output()).toContain("independently trusted transport-group grant is still separate");
		expect(process.exitCode).toBeUndefined();
	},
);

it.each([false, Symbol("cancel")])(
	"default No or cancel %s sends only a network preview",
	async (answer) => {
		// Arrange
		mocks.confirm.mockResolvedValue(answer);
		// Act
		await run();
		// Assert
		expect(bodies()).toEqual([{ attestation_id: reference }]);
		expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
		expect(mocks.log.info).toHaveBeenCalledWith("Nothing changed.", { output: process.stderr });
		expect(mocks.log.success).not.toHaveBeenCalled();
	},
);

it.each(["json", "stdin", "stderr"])(
	"%s performs a network preview without prompting or committing",
	async (mode) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		vi.mocked(fetch)
			.mockReset()
			.mockResolvedValue(reply({ ...preview, private_field: "do-not-display" }));
		if (mode === "stdin")
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
		if (mode === "stderr")
			Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
		// Act
		await run(mode === "json" ? ["--json"] : []);
		// Assert
		expect(bodies()).toEqual([{ attestation_id: reference }]);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(output()).not.toContain("do-not-display");
		if (mode === "json") {
			expect(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]?.[0]))).toEqual({
				preview,
				network_request: true,
				unchanged: true,
			});
		} else expect(output()).toContain("no qualification issued");
	},
);

it.each(["--config", "-c"])(
	"%s selects the exact config path for preview and confirmation",
	async (flag) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		vi.mocked(fetch).mockResolvedValueOnce(reply(committed));
		// Act
		await run([flag, "fixture.json"]);
		// Assert
		expect(mocks.readCodememConfigFileAtPath.mock.calls).toEqual([
			["fixture.json"],
			["fixture.json"],
		]);
		expect(mocks.readCodememConfigFile).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(2);
	},
);

it.each([
	{ sync_coordinator_url: "https://changed.example.test" },
	{ sync_coordinator_admin_secret: "changed-secret" },
	{ sync_coordinator_url: "" },
	{ sync_coordinator_admin_secret: "" },
])("configuration drift %j prevents confirmation POST", async (change) => {
	// Arrange
	mocks.confirm.mockResolvedValue(true);
	mocks.readCodememConfigFile
		.mockReturnValueOnce(config)
		.mockReturnValueOnce({ ...config, ...change });
	// Act
	await run();
	// Assert
	expect(bodies()).toEqual([{ attestation_id: reference }]);
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(output()).not.toContain("changed-secret");
	expect(output()).toContain("Operator configuration changed");
	expect(output()).not.toMatch(/outcome is unknown|may have committed/);
	expect(process.exitCode).toBe(1);
});

it.each(["missing-url", "missing-secret", "invalid-url", "removed-path", "read-throws"])(
	"config %s while confirmation is pending is a pre-dispatch configuration failure",
	async (mode) => {
		// Arrange: mutate the selected config only once the prompt is awaiting its answer.
		mocks.confirm.mockImplementation(async () => {
			if (mode === "removed-path") {
				// The production config reader returns {} when the selected path no longer exists.
				mocks.readCodememConfigFileAtPath.mockReturnValue({});
			} else if (mode === "read-throws") {
				mocks.readCodememConfigFileAtPath.mockImplementation(() => {
					throw new Error("private-config-content");
				});
			} else {
				const current = { ...config };
				if (mode === "missing-url") current.sync_coordinator_url = "";
				if (mode === "missing-secret") current.sync_coordinator_admin_secret = "";
				if (mode === "invalid-url")
					current.sync_coordinator_url = "https://user:private-password@example.test/path";
				mocks.readCodememConfigFileAtPath.mockReturnValue(current);
			}
			await Promise.resolve();
			return true;
		});
		// Act
		await run(["--config", "fixture.json"]);
		// Assert
		expect(bodies()).toEqual([{ attestation_id: reference }]);
		expect(mocks.readCodememConfigFileAtPath.mock.calls).toEqual([
			["fixture.json"],
			["fixture.json"],
		]);
		expect(output()).toContain("Operator configuration changed");
		expect(output()).not.toMatch(
			/outcome is unknown|may have committed|private-config-content|private-password/,
		);
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	},
);

it.each([false, Symbol("cancel")])(
	"answer %s remains cancelled even when config disappears at the prompt",
	async (answer) => {
		// Arrange
		mocks.confirm.mockImplementation(async () => {
			mocks.readCodememConfigFile.mockImplementation(() => {
				throw new Error("private-config-content");
			});
			return answer;
		});
		// Act
		await run();
		// Assert
		expect(bodies()).toEqual([{ attestation_id: reference }]);
		expect(mocks.readCodememConfigFile).toHaveBeenCalledTimes(1);
		expect(output()).toContain("Nothing changed.");
		expect(output()).not.toMatch(/outcome is unknown|may have committed|private-config-content/);
		expect(mocks.log.error).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	},
);

it.each([
	{ sync_coordinator_url: "" },
	{ sync_coordinator_admin_secret: "" },
	{ sync_coordinator_url: "http://remote.example.test" },
	{ sync_coordinator_url: "https://user:private-password@example.test" },
	{ sync_coordinator_url: "https://saved.example.test/path" },
])("invalid admin configuration %j fails before network or prompt", async (change) => {
	// Arrange
	mocks.readCodememConfigFile.mockReturnValue({ ...config, ...change });
	// Act
	await run(["--json"]);
	// Assert
	expect(fetch).not.toHaveBeenCalled();
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(output()).not.toContain("private-password");
	expect(output()).toContain("qualification_unavailable");
	expect(output()).toContain("inactive");
	expect(process.exitCode).toBe(1);
});

it.each([
	"wrong",
	`controller-v1:${"A".repeat(64)}`,
	`${reference}\n`,
	reference.slice(0, -1),
	` ${reference}`,
])("rejects nonexact controller reference %j before reading config", async (input) => {
	// Arrange
	mocks.confirm.mockResolvedValue(true);
	// Act
	await run(["--json"], input);
	// Assert
	expect(mocks.readCodememConfigFile).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(output()).toContain("qualification_invalid_input");
	expect(process.exitCode).toBe(2);
});

it.each([
	{ state: "created" },
	{ attestation_id: `controller-v1:${"d".repeat(64)}` },
	{ evidence_digest: "B".repeat(64) },
	{ evidence_digest: `${preview.evidence_digest}\n` },
	{ fingerprint: "short" },
	{ coordinator_id: "" },
	{ review_receipt_id: " receipt " },
	{ link_id: "link\ncontrol" },
	{ claim_id: "claim\u200bhidden" },
	{ identity_id: null },
	{ group_id: "x".repeat(257) },
	{ device_id: 123 },
])("malformed preview %j never prompts, commits, or reports qualification", async (change) => {
	// Arrange
	vi.mocked(fetch)
		.mockReset()
		.mockResolvedValue(reply({ ...preview, ...change }));
	mocks.confirm.mockResolvedValue(true);
	// Act
	await run();
	// Assert
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(output()).toContain("preview invalid");
	expect(process.exitCode).toBe(1);
});

it.each([
	{ state: "ready" },
	{ qualification_id: "" },
	{ qualification_id: "id\u0000bad" },
	{ attestation_id: "wrong" },
	{ coordinator_id: "other" },
	{ evidence_digest: "d".repeat(64) },
])(
	"malformed commit %j reports unknown outcome without retry or rollback claims",
	async (change) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		vi.mocked(fetch).mockResolvedValueOnce(reply({ ...committed, ...change }));
		// Act
		await run();
		// Assert
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(output()).toContain("may have committed");
		expect(output()).toContain("do not assume rollback or retry automatically");
		expect(process.exitCode).toBe(1);
	},
);

it.each(["preview_changed", "qualification_conflict", "unavailable", "invalid_input"])(
	"server denial %s never retries",
	async (code) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		vi.mocked(fetch).mockResolvedValueOnce(
			reply({ error: code, detail: "private-server-body" }, 409),
		);
		// Act
		await run();
		// Assert
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(output()).toContain("Qualification denied");
		expect(output()).toContain("no automatic retry");
		expect(output()).not.toMatch(/outcome is unknown|may have committed/);
		expect(output()).not.toContain("private-server-body");
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	},
);

it.each(["qualification_outcome_unknown", "private-server-error"])(
	"commit error %s remains unknown and redacted",
	async (code) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		vi.mocked(fetch).mockResolvedValueOnce(reply({ error: code }, 503));
		// Act
		await run();
		// Assert
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(output()).toContain("may have committed");
		expect(output()).not.toContain("private-server-error");
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	},
);

it.each([
	[500, "preview_changed"],
	[503, "preview_changed"],
	[500, "qualification_conflict"],
	[503, "qualification_conflict"],
	[500, "unavailable"],
	[503, "unavailable"],
	[503, "invalid_input"],
])("HTTP %s with denial-shaped code %s remains an unknown commit outcome", async (status, code) => {
	// Arrange: use the real public action so HTTP status survives transport parsing.
	mocks.confirm.mockResolvedValue(true);
	vi.mocked(fetch).mockResolvedValueOnce(
		reply({ error: code, detail: config.sync_coordinator_admin_secret }, status as number),
	);
	// Act
	await run();
	// Assert
	expect(bodies()).toEqual([
		{ attestation_id: reference },
		{ attestation_id: reference, confirm_evidence_digest: preview.evidence_digest },
	]);
	expect(output()).toContain("outcome is unknown");
	expect(output()).toContain("may have committed");
	expect(output()).toContain("do not assume rollback or retry automatically");
	expect(output()).not.toContain("Qualification denied");
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});

it.each([401, 403, 404, 429, 500, 302])(
	"preview HTTP %s fails closed with fixed inactive guidance",
	async (status) => {
		// Arrange
		vi.mocked(fetch)
			.mockReset()
			.mockResolvedValue(reply({ error: "private-remote-error" }, status));
		// Act
		await run(["--json"]);
		// Assert
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(fetch).mock.calls[0]?.[1]?.redirect).toBe("error");
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(output()).not.toContain("private-remote-error");
		expect(output()).toContain("qualification_unavailable");
		expect(output()).toContain("inactive");
		expect(process.exitCode).toBe(1);
	},
);

it.each(["null", "[]", "not-json", "", JSON.stringify({ padding: "x".repeat(16385) })])(
	"invalid or oversized wire payload fails without displaying raw content (%#)",
	async (raw) => {
		// Arrange
		vi.mocked(fetch).mockReset().mockResolvedValue(new Response(raw));
		// Act
		await run(["--json"]);
		// Assert
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(output()).toContain("qualification_unavailable");
		expect(output()).not.toContain("padding");
		expect(process.exitCode).toBe(1);
	},
);

it("lost commit reply produces unknown outcome and never reissues", async () => {
	// Arrange
	mocks.confirm.mockResolvedValue(true);
	vi.mocked(fetch).mockRejectedValueOnce(new Error("private-cookie-and-response"));
	// Act
	await run();
	// Assert
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(output()).toContain("outcome is unknown");
	expect(output()).not.toContain("private-cookie-and-response");
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});

it("configuration read errors never print private content or request a preview", async () => {
	// Arrange
	mocks.readCodememConfigFile.mockImplementation(() => {
		throw new Error("private-profile-content");
	});
	// Act
	await run();
	// Assert
	expect(fetch).not.toHaveBeenCalled();
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(output()).not.toContain("private-profile-content");
	expect(process.exitCode).toBe(1);
});

it.each(["--identity-id", "--link-id", "--email", "--admin-secret", "--yes", "--db-path"])(
	"rejects caller nomination or bypass flag %s",
	async (flag) => {
		// Arrange
		const command = buildCoordinatorQualifyOwnerCommand()
			.exitOverride()
			.configureOutput({ writeErr: () => {} });
		// Act
		const parsing = command.parseAsync([reference, flag, "attacker"], { from: "user" });
		// Assert
		await expect(parsing).rejects.toMatchObject({ code: "commander.unknownOption" });
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.confirm).not.toHaveBeenCalled();
	},
);

it("uses the saved environment target and credential without printing either credential", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "https://environment.example.test");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "environment-secret");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_TIMEOUT_S", "9");
	const timeout = vi.spyOn(AbortSignal, "timeout");
	// Act
	await run(["--json"]);
	// Assert
	expect(fetch).toHaveBeenCalledExactlyOnceWith(
		"https://environment.example.test/v1/admin/owner-qualifications",
		expect.objectContaining({ redirect: "error" }),
	);
	expect(
		new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).get("x-codemem-coordinator-admin"),
	).toBe("environment-secret");
	expect(timeout).toHaveBeenCalledWith(9000);
	expect(output()).not.toContain("environment-secret");
});

it.each([0, 12])(
	"saved timeout %s uses the shared parser and a minimum one second",
	async (seconds) => {
		// Arrange
		mocks.readCodememConfigFile.mockReturnValue({ ...config, sync_coordinator_timeout_s: seconds });
		const timeout = vi.spyOn(AbortSignal, "timeout");
		// Act
		await run(["--json"]);
		// Assert
		expect(timeout).toHaveBeenCalledWith(Math.max(1, seconds) * 1000);
		expect(bodies()).toEqual([{ attestation_id: reference }]);
	},
);

it.each([{ args: [] }, { args: [reference, "extra"] }])(
	"rejects missing or excess positional arguments %j",
	async ({ args }) => {
		// Arrange
		const command = buildCoordinatorQualifyOwnerCommand()
			.exitOverride()
			.configureOutput({ writeErr: () => {} });
		// Act
		const parsing = command.parseAsync(args, { from: "user" });
		// Assert
		await expect(parsing).rejects.toMatchObject({ code: expect.stringMatching(/^commander\./u) });
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.confirm).not.toHaveBeenCalled();
	},
);
