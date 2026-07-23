import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertStatus } from "../lib/assert.js";
import { ComposeManager } from "../lib/compose.js";
import {
	ADMIN_SECRET,
	CLI_PREFIX,
	GROUP_ID,
	readPeerIdentity,
	writePeerConfig,
} from "../lib/coordinator.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { waitFor } from "../lib/wait.js";
import type { FixtureAction } from "../scripts/dogfood-sharing-fixture.js";

const PROJECT_NAME = "codemem-dogfood";
const SERVICES = ["peer-a", "peer-b", "peer-c"] as const;
const VIEWER_URLS = {
	owner: "http://127.0.0.1:38881",
	teammate: "http://127.0.0.1:38882",
	"second-device": "http://127.0.0.1:38883",
} as const;
const TARGET_SERVICES = {
	teammate: "peer-b",
	"second-device": "peer-c",
} as const;
const FIXTURE_COMMAND = [
	"pnpm",
	"exec",
	"tsx",
	"--conditions",
	"source",
	"e2e/scripts/dogfood-sharing-fixture.ts",
] as const;

type DogfoodService = (typeof SERVICES)[number];
type DogfoodTarget = keyof typeof TARGET_SERVICES;
type ProjectTarget = "selected" | "unrelated";
type ServiceState = "online" | "offline";

export type DogfoodCommand =
	| { name: "setup"; build: boolean; reset: boolean }
	| { name: "status" }
	| { name: "add-future"; project: ProjectTarget }
	| { name: "offline" | "online" | "restart"; target: DogfoodTarget }
	| { name: "snapshot" | "logs" | "cleanup" | "help" };

export interface DogfoodState {
	version: 1;
	createdAt: string;
	services: Record<DogfoodService, ServiceState>;
}

export interface RuntimePaths {
	projectName: typeof PROJECT_NAME;
	composeFiles: [string, string];
	artifactsDir: string;
	statePath: string;
}

interface StateStore {
	exists(): boolean;
	read(): DogfoodState;
	write(state: DogfoodState): void;
	remove(): void;
}

interface DogfoodOperations {
	resourcesExist(): boolean;
	up(build: boolean): void;
	down(): void;
	ps(): string;
	fixture(service: DogfoodService, action: FixtureAction): unknown;
	configureAndEnrollOwner(): void;
	waitForViewers(): Promise<void>;
	stop(service: DogfoodService): void;
	start(service: DogfoodService): void;
	restart(service: DogfoodService): void;
	copyDatabases(): void;
	writeSnapshot(snapshot: Record<string, unknown>): void;
	captureLogs(): void;
}

interface FixtureIdentityProof {
	profile: {
		identity_id: string;
		identity_invariant: { active_local_count: number; human_named: boolean };
	};
}

function fixtureIdentityProof(value: unknown): FixtureIdentityProof | null {
	if (!value || typeof value !== "object") return null;
	const profile = (value as { profile?: unknown }).profile;
	if (!profile || typeof profile !== "object") return null;
	const identityId = String((profile as { identity_id?: unknown }).identity_id ?? "").trim();
	const invariant = (profile as { identity_invariant?: unknown }).identity_invariant;
	if (!identityId || !invariant || typeof invariant !== "object") return null;
	return {
		profile: {
			identity_id: identityId,
			identity_invariant: {
				active_local_count: Number(
					(invariant as { active_local_count?: unknown }).active_local_count ?? 0,
				),
				human_named: (invariant as { human_named?: unknown }).human_named === true,
			},
		},
	};
}

function assertDistinctFixtureIdentities(summaries: unknown[]): void {
	const proofs = summaries.map(fixtureIdentityProof);
	const identities = proofs.map((proof) => proof?.profile.identity_id ?? "");
	const valid = proofs.every(
		(proof) =>
			proof?.profile.identity_invariant.active_local_count === 1 &&
			proof.profile.identity_invariant.human_named,
	);
	if (!valid || new Set(identities).size !== summaries.length) {
		throw new Error("Each dogfood peer must prove one distinct active human-named local Identity.");
	}
}

export interface DogfoodDependencies {
	state: StateStore;
	operations: DogfoodOperations;
	sanitizeDiagnostic(message: string): string;
	writeOutput(message: string): void;
	now(): string;
}

export function buildOwnerSetupPlan(identity: {
	device_id: string;
	fingerprint: string;
	public_key: string;
}) {
	return {
		service: "peer-a" as const,
		restartService: "peer-a" as const,
		config: {
			actor_display_name: "Dogfood Owner",
			sync_device_name: "Dogfood Owner Device",
			sync_enabled: true,
			sync_host: "0.0.0.0",
			sync_port: 7337,
			sync_advertise: "http://peer-a:7337",
			sync_interval_s: 2,
			sync_coordinator_url: "http://coordinator:7347",
			sync_coordinator_group: GROUP_ID,
			sync_coordinator_admin_secret: ADMIN_SECRET,
		},
		groupCommand: [
			...CLI_PREFIX,
			"sync",
			"coordinator",
			"group-create",
			GROUP_ID,
			"--db-path",
			"/data/coordinator.sqlite",
		],
		enrollmentCommand: [
			...CLI_PREFIX,
			"sync",
			"coordinator",
			"enroll-device",
			GROUP_ID,
			identity.device_id,
			"--fingerprint",
			identity.fingerprint,
			"--public-key",
			identity.public_key,
			"--name",
			"Dogfood Owner Device",
			"--db-path",
			"/data/coordinator.sqlite",
			"--json",
		],
	};
}

const USAGE = `Usage: pnpm run dogfood -- <command>
Commands:
  setup [--build] [--reset]
  status
  add-future selected|unrelated
  offline teammate|second-device
  online teammate|second-device
  restart teammate|second-device
  snapshot
  logs
  cleanup`;

function usageError(): never {
	throw new Error(USAGE);
}

function parseSetup(flags: readonly string[]): DogfoodCommand {
	if (
		flags.some((flag) => flag !== "--build" && flag !== "--reset") ||
		new Set(flags).size !== flags.length
	) {
		return usageError();
	}
	return { name: "setup", build: flags.includes("--build"), reset: flags.includes("--reset") };
}

export function parseDogfoodCommand(args: readonly string[]): DogfoodCommand {
	const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
	const [name, ...values] = normalizedArgs;
	if (name === "--help") {
		if (values.length > 0) return usageError();
		return { name: "help" };
	}
	if (name === "setup") return parseSetup(values);
	if (["status", "snapshot", "logs", "cleanup"].includes(name ?? "")) {
		if (values.length > 0) return usageError();
		return { name: name as "status" | "snapshot" | "logs" | "cleanup" };
	}
	if (name === "add-future") {
		if (values.length !== 1 || (values[0] !== "selected" && values[0] !== "unrelated")) {
			return usageError();
		}
		return { name, project: values[0] };
	}
	if (name === "offline" || name === "online" || name === "restart") {
		if (values.length !== 1 || (values[0] !== "teammate" && values[0] !== "second-device")) {
			return usageError();
		}
		return { name, target: values[0] };
	}
	return usageError();
}

export function createRuntimePaths(repositoryRoot: string): RuntimePaths {
	const artifactsDir = resolve(repositoryRoot, ".tmp/dogfood");
	return {
		projectName: PROJECT_NAME,
		composeFiles: [
			resolve(repositoryRoot, "docker-compose.e2e.yml"),
			resolve(repositoryRoot, "docker-compose.dogfood.yml"),
		],
		artifactsDir,
		statePath: resolve(artifactsDir, "state.json"),
	};
}

export function sanitizeDiagnosticText(text: string, repositoryRoot: string): string {
	return text
		.split(repositoryRoot)
		.join("<repo>")
		.split(ADMIN_SECRET)
		.join("<redacted>");
}

export function buildManualChecklist(): string {
	return `Dogfood viewers:
  Owner: ${VIEWER_URLS.owner}
  Teammate: ${VIEWER_URLS.teammate}
  Second device: ${VIEWER_URLS["second-device"]}

Manual invitation checklist:
  1. Assign the selected Project to the test Team in the owner UI.
  2. Create an exact-Project invitation in the owner UI and accept it in the teammate UI.
  3. Create a Team invitation in the owner UI and accept it in the same teammate profile.
  4. Create an add-device invitation for the teammate Identity.
  5. Accept the add-device invitation in the second-device UI.
  6. Add selected and unrelated future memories and verify exact delivery and isolation.
  7. Exercise offline revocation, recovery, and restart persistence manually.`;
}

function requireState(dependencies: DogfoodDependencies): DogfoodState {
	if (!dependencies.state.exists()) {
		throw new Error("Dogfood sandbox is not set up; run setup first.");
	}
	return dependencies.state.read();
}

function updatedServiceState(
	state: DogfoodState,
	service: DogfoodService,
	status: ServiceState,
): DogfoodState {
	return { ...state, services: { ...state.services, [service]: status } };
}

async function runSetup(
	dependencies: DogfoodDependencies,
	command: Extract<DogfoodCommand, { name: "setup" }>,
): Promise<void> {
	if (!command.reset && dependencies.state.exists()) {
		throw new Error("Dogfood sandbox state already exists; rerun setup with --reset.");
	}
	if (!command.reset && dependencies.operations.resourcesExist()) {
		throw new Error("Dogfood sandbox resources already exist; rerun setup with --reset.");
	}
	if (command.reset) {
		dependencies.operations.down();
		dependencies.state.remove();
	}
	dependencies.operations.up(command.build);
	const fixtureSummaries = [
		dependencies.operations.fixture("peer-a", "setup-owner"),
		dependencies.operations.fixture("peer-b", "setup-teammate"),
		dependencies.operations.fixture("peer-c", "setup-second-device"),
	];
	assertDistinctFixtureIdentities(fixtureSummaries);
	dependencies.operations.configureAndEnrollOwner();
	await dependencies.operations.waitForViewers();
	dependencies.state.write({
		version: 1,
		createdAt: dependencies.now(),
		services: { "peer-a": "online", "peer-b": "online", "peer-c": "online" },
	});
	dependencies.writeOutput(buildManualChecklist());
}

function runLifecycle(
	dependencies: DogfoodDependencies,
	command: Extract<DogfoodCommand, { name: "offline" | "online" | "restart" }>,
): void {
	const state = requireState(dependencies);
	const service = TARGET_SERVICES[command.target];
	const current = state.services[service];
	if (command.name === "offline") {
		if (current === "offline") {
			throw new Error(`${command.target} is already offline; no changes made.`);
		}
		dependencies.operations.stop(service);
		dependencies.state.write(updatedServiceState(state, service, "offline"));
		return;
	}
	if (command.name === "online") {
		if (current === "online") {
			throw new Error(`${command.target} is already online; no changes made.`);
		}
		dependencies.operations.start(service);
		dependencies.state.write(updatedServiceState(state, service, "online"));
		return;
	}
	if (current === "offline") throw new Error(`${command.target} is offline; run online first.`);
	dependencies.operations.restart(service);
}

function statusOutput(state: DogfoodState, composeStatus: string): string {
	return [
		"Dogfood sandbox status:",
		`  Owner: ${state.services["peer-a"]} — ${VIEWER_URLS.owner}`,
		`  Teammate: ${state.services["peer-b"]} — ${VIEWER_URLS.teammate}`,
		`  Second device: ${state.services["peer-c"]} — ${VIEWER_URLS["second-device"]}`,
		"Compose containers:",
		composeStatus.trim() || "  No container status returned.",
	].join("\n");
}

export function createDogfoodRunner(dependencies: DogfoodDependencies) {
	return {
		async run(command: DogfoodCommand): Promise<void> {
			if (command.name === "help") {
				dependencies.writeOutput(USAGE);
				return;
			}
			if (command.name === "cleanup") {
				dependencies.operations.down();
				dependencies.state.remove();
				dependencies.writeOutput("Dogfood sandbox cleaned up.");
				return;
			}
			if (command.name === "setup") return runSetup(dependencies, command);
			if (command.name === "offline" || command.name === "online" || command.name === "restart") {
				runLifecycle(dependencies, command);
				return;
			}
			const state = requireState(dependencies);
			if (command.name === "status") {
				const composeStatus = dependencies.operations.ps();
				dependencies.writeOutput(
					statusOutput(state, dependencies.sanitizeDiagnostic(composeStatus)),
				);
				return;
			}
			if (command.name === "add-future") {
				dependencies.operations.fixture("peer-a", `add-future-${command.project}`);
				dependencies.writeOutput(`Added the fixed ${command.project} future memory.`);
				return;
			}
			if (command.name === "logs") {
				dependencies.operations.captureLogs();
				dependencies.writeOutput("Logs captured under .tmp/dogfood.");
				return;
			}
			const summaries = Object.fromEntries(
				SERVICES.map((service) => [
					service,
					state.services[service] === "online"
						? dependencies.operations.fixture(service, "summary")
						: { status: "offline" },
				]),
			);
			dependencies.operations.copyDatabases();
			dependencies.operations.writeSnapshot({ capturedAt: dependencies.now(), state, summaries });
			dependencies.writeOutput("Snapshot captured under .tmp/dogfood.");
		},
	};
}

function isDogfoodState(value: unknown): value is DogfoodState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<DogfoodState>;
	return (
		candidate.version === 1 &&
		typeof candidate.createdAt === "string" &&
		SERVICES.every(
			(service) =>
				candidate.services?.[service] === "online" || candidate.services?.[service] === "offline",
		)
	);
}

function createStateStore(paths: RuntimePaths): StateStore {
	return {
		exists: () => existsSync(paths.statePath),
		read: () => {
			const parsed: unknown = JSON.parse(readFileSync(paths.statePath, "utf8"));
			if (!isDogfoodState(parsed)) {
				throw new Error("Dogfood state is invalid; run cleanup, then setup.");
			}
			return parsed;
		},
		write: (state) => {
			mkdirSync(paths.artifactsDir, { recursive: true });
			writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		},
		remove: () => rmSync(paths.artifactsDir, { recursive: true, force: true }),
	};
}

function createContext(compose: ComposeManager, artifactsDir: string): ScenarioContext {
	return {
		compose,
		artifactsDir,
		keepStackOnFailure: true,
		recordNote: () => undefined,
		captureFailure: () => undefined,
	};
}

function withBuildFlag(build: boolean, operation: () => void): void {
	const previous = process.env.CODEMEM_E2E_BUILD;
	try {
		process.env.CODEMEM_E2E_BUILD = build ? "1" : "0";
		operation();
	} finally {
		if (previous === undefined) delete process.env.CODEMEM_E2E_BUILD;
		else process.env.CODEMEM_E2E_BUILD = previous;
	}
}

function createOperations(paths: RuntimePaths): DogfoodOperations {
	const compose = new ComposeManager({
		composeFiles: paths.composeFiles,
		profiles: ["bootstrap"],
		artifactsDir: paths.artifactsDir,
		projectName: paths.projectName,
	});
	const context = createContext(compose, paths.artifactsDir);
	const ensureArtifacts = () => mkdirSync(resolve(paths.artifactsDir, "db"), { recursive: true });
	return {
		resourcesExist: () => {
			ensureArtifacts();
			return compose.hasProjectResources("dogfood-resources");
		},
		up: (build) => {
			ensureArtifacts();
			withBuildFlag(build, () => compose.up([...SERVICES, "coordinator"], "01-compose-up"));
		},
		down: () => {
			ensureArtifacts();
			compose.down("compose-down");
		},
		ps: () => {
			ensureArtifacts();
			return compose.ps("status-compose-ps").stdout;
		},
		fixture: (service, action) => {
			ensureArtifacts();
			const result = compose.exec(
				service,
				[...FIXTURE_COMMAND, "--action", action],
				`fixture-${service}-${action}`,
				120_000,
			);
			assertStatus(result.status, 0, `${service} fixture action ${action} failed`);
			return JSON.parse(result.stdout) as unknown;
		},
		configureAndEnrollOwner: () => {
			const identity = readPeerIdentity(context, "peer-a", "read-owner-identity");
			const plan = buildOwnerSetupPlan(identity);
			writePeerConfig(
				context,
				plan.service,
				plan.config,
				"configure-owner",
			);
			const group = compose.exec(
				"coordinator",
				plan.groupCommand,
				"create-owner-group",
			);
			assertStatus(group.status, 0, "failed to create dogfood coordinator group");
			const enrolled = compose.exec(
				"coordinator",
				plan.enrollmentCommand,
				"enroll-owner",
			);
			assertStatus(enrolled.status, 0, "failed to enroll dogfood owner");
			compose.restart(plan.restartService, "restart-configured-owner");
		},
		waitForViewers: async () => {
			await waitFor(
				async () => {
					const responses = await Promise.all(
						Object.values(VIEWER_URLS).map((url) => fetch(`${url}/api/stats`)),
					);
					if (responses.some((response) => response.status !== 200)) {
						throw new Error("one or more viewers are not ready");
					}
				},
				{ description: "dogfood viewers", timeoutMs: 120_000, intervalMs: 2_000 },
			);
		},
		stop: (service) => compose.stop(service, `offline-${service}`),
		start: (service) => compose.start(service, `online-${service}`),
		restart: (service) => compose.restart(service, `restart-${service}`),
		copyDatabases: () => {
			ensureArtifacts();
			for (const service of SERVICES) {
				compose.copyFromContainer(
					`${service}:/data/mem.sqlite`,
					resolve(paths.artifactsDir, "db", `${service}.sqlite`),
					`snapshot-${service}-db`,
					false,
				);
			}
			compose.copyFromContainer(
				"coordinator:/data/coordinator.sqlite",
				resolve(paths.artifactsDir, "db", "coordinator.sqlite"),
				"snapshot-coordinator-db",
				false,
			);
		},
		writeSnapshot: (snapshot) => {
			ensureArtifacts();
			writeFileSync(
				resolve(paths.artifactsDir, "snapshot.json"),
				`${JSON.stringify(snapshot, null, 2)}\n`,
				"utf8",
			);
		},
		captureLogs: () => {
			ensureArtifacts();
			compose.logs("dogfood-logs");
		},
	};
}

function createRuntimeDependencies(repositoryRoot: string): DogfoodDependencies {
	const paths = createRuntimePaths(repositoryRoot);
	return {
		state: createStateStore(paths),
		operations: createOperations(paths),
		sanitizeDiagnostic: (message) => sanitizeDiagnosticText(message, repositoryRoot),
		writeOutput: (message) => process.stdout.write(`${message}\n`),
		now: () => new Date().toISOString(),
	};
}

async function main(): Promise<void> {
	const command = parseDogfoodCommand(process.argv.slice(2));
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	await createDogfoodRunner(createRuntimeDependencies(repositoryRoot)).run(command);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
	void main().catch((error) => {
		const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${sanitizeDiagnosticText(message, repositoryRoot)}\n`);
		process.exitCode = 1;
	});
}
