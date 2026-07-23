import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildManualChecklist,
	buildOwnerSetupPlan,
	createDogfoodRunner,
	createRuntimePaths,
	parseDogfoodCommand,
	sanitizeDiagnosticText,
	type DogfoodDependencies,
	type DogfoodState,
} from "./dogfood.js";

const INITIAL_STATE: DogfoodState = {
	version: 1,
	createdAt: "2026-07-23T12:00:00.000Z",
	services: {
		"peer-a": "online",
		"peer-b": "online",
		"peer-c": "online",
	},
};

function createHarness(initialState: DogfoodState | null = null) {
	let state = initialState;
	const output: string[] = [];
	const dependencies: DogfoodDependencies = {
		state: {
			exists: vi.fn(() => state !== null),
			read: vi.fn(() => {
				if (!state) throw new Error("missing state");
				return state;
			}),
			write: vi.fn((next) => {
				state = next;
			}),
			remove: vi.fn(() => {
				state = null;
			}),
		},
		operations: {
			resourcesExist: vi.fn(() => false),
			up: vi.fn(),
			down: vi.fn(),
			ps: vi.fn(() => "peer-a running (healthy)"),
			fixture: vi.fn((service, action) => ({
				ok: true,
				action,
				profile: {
					identity_id: `identity-${service}`,
					identity_invariant: { active_local_count: 1, human_named: true },
				},
			})),
			configureAndEnrollOwner: vi.fn(),
			waitForViewers: vi.fn(async () => undefined),
			stop: vi.fn(),
			start: vi.fn(),
			restart: vi.fn(),
			copyDatabases: vi.fn(),
			writeSnapshot: vi.fn(),
			captureLogs: vi.fn(),
		},
		sanitizeDiagnostic: (message) => sanitizeDiagnosticText(message, "/repo"),
		writeOutput: (message) => output.push(message),
		now: () => "2026-07-23T12:00:00.000Z",
	};
	return { runner: createDogfoodRunner(dependencies), dependencies, output, getState: () => state };
}

describe("parseDogfoodCommand", () => {
	it.each([
		[["setup"], { name: "setup", build: false, reset: false }],
		[["--", "setup"], { name: "setup", build: false, reset: false }],
		[["setup", "--reset", "--build"], { name: "setup", build: true, reset: true }],
		[["status"], { name: "status" }],
		[["add-future", "selected"], { name: "add-future", project: "selected" }],
		[["offline", "teammate"], { name: "offline", target: "teammate" }],
		[["online", "second-device"], { name: "online", target: "second-device" }],
		[["restart", "teammate"], { name: "restart", target: "teammate" }],
		[["snapshot"], { name: "snapshot" }],
		[["logs"], { name: "logs" }],
		[["cleanup"], { name: "cleanup" }],
		[["--help"], { name: "help" }],
	] as const)("parses only the approved shape %#", (argv, expected) => {
		expect(parseDogfoodCommand(argv)).toEqual(expected);
	});

	it.each([
		[[]],
		[["setup", "--force"]],
		[["-h"]],
		[["setup", "--build", "--build"]],
		[["status", "--json"]],
		[["add-future", "other"]],
		[["offline", "owner"]],
		[["online"]],
		[["restart", "peer-b"]],
		[["cleanup", "anything"]],
		[["unknown"]],
	])("rejects unsupported arguments %#", (argv) => {
		expect(() => parseDogfoodCommand(argv)).toThrow("Usage:");
	});
});

describe("fixed runtime paths", () => {
	it("resolves both Compose files and dogfood artifacts from the repository root", () => {
		const paths = createRuntimePaths("/repo");

		expect(paths).toEqual({
			projectName: "codemem-dogfood",
			composeFiles: [
				resolve("/repo", "docker-compose.e2e.yml"),
				resolve("/repo", "docker-compose.dogfood.yml"),
			],
			artifactsDir: resolve("/repo", ".tmp/dogfood"),
			statePath: resolve("/repo", ".tmp/dogfood/state.json"),
		});
	});

	it("redacts repository paths and the fixed coordinator credential from diagnostics", () => {
		expect(
			sanitizeDiagnosticText(
				"failed under /Users/example/codemem/.tmp/dogfood with e2e-admin-secret",
				"/Users/example/codemem",
			),
		).toBe("failed under <repo>/.tmp/dogfood with <redacted>");
	});

	it("redacts every hostile repetition instead of only the first occurrence", () => {
		const diagnostic = [
			"/private/repo/.tmp/dogfood e2e-admin-secret",
			"/private/repo/state.json e2e-admin-secret",
		].join("\n");

		expect(sanitizeDiagnosticText(diagnostic, "/private/repo")).toBe(
			"<repo>/.tmp/dogfood <redacted>\n<repo>/state.json <redacted>",
		);
	});

	it("builds an owner-only coordinator setup plan", () => {
		const plan = buildOwnerSetupPlan({
			device_id: "owner-device",
			fingerprint: "owner-fingerprint",
			public_key: "owner-public-key",
		});

		expect(plan.service).toBe("peer-a");
		expect(plan.restartService).toBe("peer-a");
		expect(plan.config.sync_advertise).toBe("http://peer-a:7337");
		expect(plan.enrollmentCommand).toContain("owner-device");
		expect(JSON.stringify(plan)).not.toMatch(/peer-b|peer-c|invite/u);
	});
});

describe("dogfood runner", () => {
	it("refuses setup when fixed state exists without mutating the environment", async () => {
		const { runner, dependencies } = createHarness(INITIAL_STATE);

		await expect(runner.run({ name: "setup", build: false, reset: false })).rejects.toThrow(
			"already exists",
		);
		expect(dependencies.operations.up).not.toHaveBeenCalled();
		expect(dependencies.operations.down).not.toHaveBeenCalled();
		expect(dependencies.operations.resourcesExist).not.toHaveBeenCalled();
	});

	it("refuses setup when fixed Compose resources exist without metadata", async () => {
		const { runner, dependencies } = createHarness();
		vi.mocked(dependencies.operations.resourcesExist).mockReturnValue(true);

		await expect(runner.run({ name: "setup", build: false, reset: false })).rejects.toThrow(
			"resources already exist",
		);
		expect(dependencies.operations.up).not.toHaveBeenCalled();
		expect(dependencies.operations.down).not.toHaveBeenCalled();
		expect(dependencies.state.write).not.toHaveBeenCalled();
	});

	it("checks fixed resources before a fresh successful setup", async () => {
		const { runner, dependencies, output, getState } = createHarness();
		vi.mocked(dependencies.operations.fixture).mockImplementation((service, action) => ({
			ok: true,
			action,
			profile: {
				identity_id: `identity-${service}`,
				identity_invariant: { active_local_count: 1, human_named: true },
			},
		}));

		await runner.run({ name: "setup", build: false, reset: false });

		expect(dependencies.operations.resourcesExist).toHaveBeenCalledTimes(1);
		expect(dependencies.operations.down).not.toHaveBeenCalled();
		expect(getState()?.services).toEqual(INITIAL_STATE.services);
		expect(output).toHaveLength(1);
		expect(
			vi.mocked(dependencies.operations.resourcesExist).mock.invocationCallOrder[0] ?? 0,
		).toBeLessThan(vi.mocked(dependencies.operations.up).mock.invocationCallOrder[0] ?? 0);
	});

	it("rejects setup when peer fixture summaries do not prove distinct local Identities", async () => {
		const { runner, dependencies } = createHarness();
		vi.mocked(dependencies.operations.fixture).mockImplementation((_service, action) => ({
			ok: true,
			action,
			profile: {
				identity_id: "local:local",
				identity_invariant: { active_local_count: 1, human_named: false },
			},
		}));

		await expect(runner.run({ name: "setup", build: false, reset: false })).rejects.toThrow(
			"distinct active human-named local Identity",
		);
		expect(dependencies.operations.configureAndEnrollOwner).not.toHaveBeenCalled();
		expect(dependencies.state.write).not.toHaveBeenCalled();
	});

	it("rejects otherwise-valid peer proofs that reuse the same Identity", async () => {
		const { runner, dependencies } = createHarness();
		vi.mocked(dependencies.operations.fixture).mockImplementation((_service, action) => ({
			ok: true,
			action,
			profile: {
				identity_id: "identity-reused-by-all-peers",
				identity_invariant: { active_local_count: 1, human_named: true },
			},
		}));

		await expect(runner.run({ name: "setup", build: false, reset: false })).rejects.toThrow(
			"distinct active human-named local Identity",
		);
		expect(dependencies.operations.configureAndEnrollOwner).not.toHaveBeenCalled();
		expect(dependencies.state.write).not.toHaveBeenCalled();
	});

	it("resets only the fixed sandbox before deterministic setup", async () => {
		const { runner, dependencies, getState } = createHarness(INITIAL_STATE);

		await runner.run({ name: "setup", build: true, reset: true });

		expect(dependencies.operations.down).toHaveBeenCalledTimes(1);
		expect(dependencies.operations.up).toHaveBeenCalledWith(true);
		expect(dependencies.operations.fixture).toHaveBeenNthCalledWith(1, "peer-a", "setup-owner");
		expect(dependencies.operations.fixture).toHaveBeenNthCalledWith(2, "peer-b", "setup-teammate");
		expect(dependencies.operations.fixture).toHaveBeenNthCalledWith(
			3,
			"peer-c",
			"setup-second-device",
		);
		expect(dependencies.operations.configureAndEnrollOwner).toHaveBeenCalledTimes(1);
		expect(dependencies.operations.waitForViewers).toHaveBeenCalledTimes(1);
		expect(getState()?.services).toEqual(INITIAL_STATE.services);
		const order = [
			vi.mocked(dependencies.operations.down).mock.invocationCallOrder[0],
			vi.mocked(dependencies.state.remove).mock.invocationCallOrder[0],
			vi.mocked(dependencies.operations.up).mock.invocationCallOrder[0],
			vi.mocked(dependencies.operations.fixture).mock.invocationCallOrder.at(-1),
			vi.mocked(dependencies.operations.configureAndEnrollOwner).mock.invocationCallOrder[0],
			vi.mocked(dependencies.operations.waitForViewers).mock.invocationCallOrder[0],
			vi.mocked(dependencies.state.write).mock.invocationCallOrder[0],
		];
		expect(order).toEqual(order.toSorted((left, right) => (left ?? 0) - (right ?? 0)));
	});

	it.each([
		"inspection",
		"up",
		"owner-fixture",
		"teammate-fixture",
		"second-device-fixture",
		"enrollment",
		"readiness",
	] as const)(
		"does not persist success state or print a checklist when %s fails",
		async (stage) => {
			const { runner, dependencies, output, getState } = createHarness();
			const failure = new Error(`${stage} failed`);
			if (stage === "inspection") {
				vi.mocked(dependencies.operations.resourcesExist).mockImplementation(() => {
					throw failure;
				});
			}
			if (stage === "up") {
				vi.mocked(dependencies.operations.up).mockImplementation(() => {
					throw failure;
				});
			}
			if (stage.endsWith("-fixture")) {
				const failedAction = `setup-${stage.replace("-fixture", "")}`;
				vi.mocked(dependencies.operations.fixture).mockImplementation((_service, action) => {
					if (action === failedAction) {
						throw failure;
					}
					return { ok: true, action };
				});
			}
			if (stage === "enrollment") {
				vi.mocked(dependencies.operations.configureAndEnrollOwner).mockImplementation(() => {
					throw failure;
				});
			}
			if (stage === "readiness") {
				vi.mocked(dependencies.operations.waitForViewers).mockRejectedValue(failure);
			}

			await expect(runner.run({ name: "setup", build: false, reset: false })).rejects.toThrow(
				`${stage} failed`,
			);
			expect(dependencies.state.write).not.toHaveBeenCalled();
			expect(getState()).toBeNull();
			expect(output).toEqual([]);
		},
	);

	it("preserves state and does not start setup when reset teardown fails", async () => {
		const { runner, dependencies, output, getState } = createHarness(INITIAL_STATE);
		vi.mocked(dependencies.operations.down).mockImplementation(() => {
			throw new Error("teardown failed");
		});

		await expect(runner.run({ name: "setup", build: false, reset: true })).rejects.toThrow(
			"teardown failed",
		);
		expect(dependencies.state.remove).not.toHaveBeenCalled();
		expect(dependencies.operations.up).not.toHaveBeenCalled();
		expect(getState()).toEqual(INITIAL_STATE);
		expect(output).toEqual([]);
	});

	it("adds future memories only through the owner fixture action", async () => {
		const { runner, dependencies } = createHarness(INITIAL_STATE);

		await runner.run({ name: "add-future", project: "unrelated" });

		expect(dependencies.operations.fixture).toHaveBeenCalledWith(
			"peer-a",
			"add-future-unrelated",
		);
	});

	it("reports fixed viewer URLs and redacts hostile Compose diagnostics", async () => {
		const { runner, dependencies, output } = createHarness(INITIAL_STATE);
		vi.mocked(dependencies.operations.ps).mockReturnValue(
			"/repo/.tmp/dogfood e2e-admin-secret /repo e2e-admin-secret",
		);

		await runner.run({ name: "status" });

		expect(output.join("\n")).toContain("http://127.0.0.1:38881");
		expect(output.join("\n")).toContain("<repo>/.tmp/dogfood <redacted> <repo> <redacted>");
		expect(output.join("\n")).not.toContain("/repo");
		expect(output.join("\n")).not.toContain("e2e-admin-secret");
	});

	it("maps lifecycle targets to fixed peer services", async () => {
		const { runner, dependencies, getState } = createHarness(INITIAL_STATE);

		await runner.run({ name: "offline", target: "teammate" });
		await runner.run({ name: "restart", target: "second-device" });

		expect(dependencies.operations.stop).toHaveBeenCalledWith("peer-b");
		expect(dependencies.operations.restart).toHaveBeenCalledWith("peer-c");
		expect(getState()?.services["peer-b"]).toBe("offline");
	});

	it("brings an offline target online once and refuses an already-online target", async () => {
		const offlineState: DogfoodState = {
			...INITIAL_STATE,
			services: { ...INITIAL_STATE.services, "peer-c": "offline" },
		};
		const { runner, dependencies, getState } = createHarness(offlineState);

		await runner.run({ name: "online", target: "second-device" });
		await expect(runner.run({ name: "online", target: "second-device" })).rejects.toThrow(
			"already online",
		);
		expect(dependencies.operations.start).toHaveBeenCalledTimes(1);
		expect(dependencies.operations.start).toHaveBeenCalledWith("peer-c");
		expect(getState()?.services["peer-c"]).toBe("online");
	});

	it.each([
		["offline", "stop", INITIAL_STATE],
		[
			"online",
			"start",
			{
				...INITIAL_STATE,
				services: { ...INITIAL_STATE.services, "peer-b": "offline" },
			},
		],
		["restart", "restart", INITIAL_STATE],
	] as const)(
		"preserves state when %s Compose mutation fails",
		async (command, operation, state) => {
			const { runner, dependencies, getState } = createHarness(state);
			vi.mocked(dependencies.operations[operation]).mockImplementation(() => {
				throw new Error(`${operation} failed`);
			});

			await expect(runner.run({ name: command, target: "teammate" })).rejects.toThrow(
				`${operation} failed`,
			);
			expect(dependencies.state.write).not.toHaveBeenCalled();
			expect(getState()).toEqual(state);
		},
	);

	it("rejects invalid lifecycle transitions before Compose mutation", async () => {
		const offlineState: DogfoodState = {
			...INITIAL_STATE,
			services: { ...INITIAL_STATE.services, "peer-b": "offline" },
		};
		const { runner, dependencies } = createHarness(offlineState);

		await expect(runner.run({ name: "offline", target: "teammate" })).rejects.toThrow(
			"already offline",
		);
		await expect(runner.run({ name: "restart", target: "teammate" })).rejects.toThrow(
			"is offline",
		);
		expect(dependencies.operations.stop).not.toHaveBeenCalled();
		expect(dependencies.operations.restart).not.toHaveBeenCalled();
	});

	it("captures snapshots without printing payloads or private paths", async () => {
		const { runner, dependencies, output } = createHarness(INITIAL_STATE);

		await runner.run({ name: "snapshot" });

		expect(dependencies.operations.fixture).toHaveBeenCalledTimes(3);
		expect(dependencies.operations.copyDatabases).toHaveBeenCalledTimes(1);
		expect(dependencies.operations.writeSnapshot).toHaveBeenCalledTimes(1);
		expect(output.join("\n")).toBe("Snapshot captured under .tmp/dogfood.");
	});

	it("snapshots an intentionally offline peer without executing inside it", async () => {
		const state: DogfoodState = {
			...INITIAL_STATE,
			services: { ...INITIAL_STATE.services, "peer-b": "offline" },
		};
		const { runner, dependencies } = createHarness(state);

		await runner.run({ name: "snapshot" });

		expect(dependencies.operations.fixture).not.toHaveBeenCalledWith("peer-b", "summary");
		expect(dependencies.operations.writeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				summaries: expect.objectContaining({ "peer-b": { status: "offline" } }),
			}),
		);
	});

	it("captures logs without forwarding raw Compose output", async () => {
		const { runner, dependencies, output } = createHarness(INITIAL_STATE);

		await runner.run({ name: "logs" });

		expect(dependencies.operations.captureLogs).toHaveBeenCalledTimes(1);
		expect(output).toEqual(["Logs captured under .tmp/dogfood."]);
	});

	it("does not report log capture success when Compose logs fail", async () => {
		const { runner, dependencies, output } = createHarness(INITIAL_STATE);
		vi.mocked(dependencies.operations.captureLogs).mockImplementation(() => {
			throw new Error("logs failed");
		});

		await expect(runner.run({ name: "logs" })).rejects.toThrow("logs failed");
		expect(output).toEqual([]);
	});

	it("cleans up twice idempotently even when state is absent", async () => {
		const { runner, dependencies, output } = createHarness();

		await runner.run({ name: "cleanup" });
		await runner.run({ name: "cleanup" });

		expect(dependencies.operations.down).toHaveBeenCalledTimes(2);
		expect(dependencies.state.remove).toHaveBeenCalledTimes(2);
		expect(output).toEqual([
			"Dogfood sandbox cleaned up.",
			"Dogfood sandbox cleaned up.",
		]);
	});

	it("preserves state and artifacts when cleanup teardown fails", async () => {
		const { runner, dependencies, output, getState } = createHarness(INITIAL_STATE);
		vi.mocked(dependencies.operations.down).mockImplementation(() => {
			throw new Error("teardown failed");
		});

		await expect(runner.run({ name: "cleanup" })).rejects.toThrow("teardown failed");
		expect(dependencies.state.remove).not.toHaveBeenCalled();
		expect(getState()).toEqual(INITIAL_STATE);
		expect(output).toEqual([]);
	});

	it.each([
		{ name: "status" },
		{ name: "add-future", project: "selected" },
		{ name: "offline", target: "teammate" },
		{ name: "snapshot" },
		{ name: "logs" },
	] as const)("refuses $name mutation or diagnostics without state", async (command) => {
		const { runner, dependencies } = createHarness();

		await expect(runner.run(command)).rejects.toThrow("run setup first");
		expect(dependencies.operations.fixture).not.toHaveBeenCalled();
		expect(dependencies.operations.stop).not.toHaveBeenCalled();
		expect(dependencies.operations.ps).not.toHaveBeenCalled();
		expect(dependencies.operations.captureLogs).not.toHaveBeenCalled();
	});
});

describe("manual checklist", () => {
	it("prints all fixed viewer URLs and keeps invitations manual", () => {
		const checklist = buildManualChecklist();

		expect(checklist).toContain("http://127.0.0.1:38881");
		expect(checklist).toContain("http://127.0.0.1:38882");
		expect(checklist).toContain("http://127.0.0.1:38883");
		expect(checklist).toContain("Create an exact-Project invitation in the owner UI");
		expect(checklist).toContain("Accept the add-device invitation in the second-device UI");
	});
});
