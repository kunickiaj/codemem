import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initDatabase, MemoryStore } from "../../packages/core/src/index.ts";

const DB_PATH = "/data/mem.sqlite";
const FIXTURE_TIME = "2026-07-23T12:00:00.000Z";
const TEAM_ID = "dogfood-policy-team";
const TEAM_NAME = "Dogfood Empty Test Team";

const PROJECTS = {
	selected: {
		project: "dogfood-selected-project",
		remote: "https://example.invalid/dogfood/selected.git",
		existingTitle: "DOGFOOD selected existing",
		futureTitle: "DOGFOOD selected future",
	},
	unrelated: {
		project: "dogfood-unrelated-project",
		remote: "https://example.invalid/dogfood/unrelated.git",
		existingTitle: "DOGFOOD unrelated existing",
		futureTitle: "DOGFOOD unrelated future",
	},
} as const;

const PROFILE_NAMES = {
	owner: "Dogfood Owner",
	teammate: "Dogfood Teammate",
	"second-device": "Dogfood Teammate Second Device",
} as const;

export type DogfoodProfile = keyof typeof PROFILE_NAMES;

export const FIXTURE_ACTIONS = [
	"setup-owner",
	"setup-teammate",
	"setup-second-device",
	"add-future-selected",
	"add-future-unrelated",
	"summary",
] as const;

export type FixtureAction = (typeof FIXTURE_ACTIONS)[number];

interface ProjectSummary {
	remote: string;
	memory_count: number;
	titles: string[];
}

export interface FixtureSummary {
	ok: true;
	action: FixtureAction;
	profile: {
		role: DogfoodProfile | null;
		identity_id: string;
		device_id: string;
		display_name: string;
	};
	team: {
		team_id: string;
		display_name: string;
		exists: boolean;
		member_count: number;
	};
	projects: {
		selected: ProjectSummary;
		unrelated: ProjectSummary;
	};
	separation: {
		distinct_remotes: boolean;
		overlapping_titles: string[];
		isolated: boolean;
	};
}

export function parseFixtureAction(args: readonly string[]): FixtureAction {
	const error = `Expected exactly --action <${FIXTURE_ACTIONS.join("|")}>`;
	if (args.length !== 2 || args[0] !== "--action") throw new Error(error);
	const value = args[1];
	if (!FIXTURE_ACTIONS.includes(value as FixtureAction)) throw new Error(error);
	return value as FixtureAction;
}

function profileFromDisplayName(displayName: string): DogfoodProfile | null {
	const match = Object.entries(PROFILE_NAMES).find(([, expected]) => expected === displayName);
	return (match?.[0] as DogfoodProfile | undefined) ?? null;
}

function ensureProfile(store: MemoryStore, role: DogfoodProfile): void {
	const displayName = PROFILE_NAMES[role];
	const existing = store.db
		.prepare("SELECT display_name FROM actors WHERE actor_id = ?")
		.get(store.actorId) as { display_name: string } | undefined;
	const existingRole = existing ? profileFromDisplayName(existing.display_name) : null;
	if (existingRole && existingRole !== role) {
		throw new Error(`Dogfood profile is already initialized as ${existingRole}`);
	}
	store.db
		.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES (?, ?, 1, 'active', ?, ?)
			 ON CONFLICT(actor_id) DO UPDATE SET
			 display_name = excluded.display_name, is_local = 1, status = 'active', updated_at = excluded.updated_at`,
		)
		.run(store.actorId, displayName, FIXTURE_TIME, FIXTURE_TIME);
}

function ensureEmptyTeam(store: MemoryStore): void {
	store.db
		.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'active', 'e2e', '1', 'native', NULL, ?, ?, ?)
			 ON CONFLICT(team_id) DO UPDATE SET
			 display_name = excluded.display_name, status = 'active', updated_at = excluded.updated_at`,
		)
		.run(TEAM_ID, TEAM_NAME, `team:${TEAM_ID}`, FIXTURE_TIME, FIXTURE_TIME);
}

function memoryExists(store: MemoryStore, remote: string, title: string): boolean {
	return Boolean(
		store.db
			.prepare(
				`SELECT 1
				 FROM memory_items mi
				 JOIN sessions s ON s.id = mi.session_id
				 WHERE mi.active = 1 AND s.git_remote = ? AND mi.title = ?
				 LIMIT 1`,
			)
			.get(remote, title),
	);
}

function ensureMemory(
	store: MemoryStore,
	project: (typeof PROJECTS)[keyof typeof PROJECTS],
	title: string,
): void {
	if (memoryExists(store, project.remote, title)) return;
	const sessionId = store.startSession({
		cwd: `/workspace/${project.project}`,
		project: project.project,
		gitRemote: project.remote,
		gitBranch: "main",
		user: "dogfood",
		toolVersion: "dogfood-sharing-fixture",
	});
	store.remember(
		sessionId,
		"discovery",
		title,
		`${title}: synthetic content for the disposable sharing sandbox.`,
		0.9,
		["dogfood-sharing-fixture"],
		{
			visibility: "shared",
			created_at: FIXTURE_TIME,
			updated_at: FIXTURE_TIME,
		},
	);
	store.endSession(sessionId, { fixture: title });
}

function assertOwnerBaseline(store: MemoryStore): void {
	const teamExists = store.db
		.prepare("SELECT 1 FROM policy_teams WHERE team_id = ?")
		.get(TEAM_ID);
	const baselineExists = Object.values(PROJECTS).every((project) =>
		memoryExists(store, project.remote, project.existingTitle),
	);
	if (!teamExists || !baselineExists) {
		throw new Error("Owner fixture is not initialized; run setup-owner first");
	}
}

function projectSummary(store: MemoryStore, key: keyof typeof PROJECTS): ProjectSummary {
	const project = PROJECTS[key];
	const rows = store.db
		.prepare(
			`SELECT mi.title
			 FROM memory_items mi
			 JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.active = 1 AND s.git_remote = ?
			 ORDER BY mi.title`,
		)
		.all(project.remote) as Array<{ title: string }>;
	const titles = rows.map((row) => row.title);
	return { remote: project.remote, memory_count: titles.length, titles };
}

export function buildSafeSummary(
	store: MemoryStore,
	action: FixtureAction,
): FixtureSummary {
	const selected = projectSummary(store, "selected");
	const unrelated = projectSummary(store, "unrelated");
	const selectedTitles = new Set(selected.titles);
	const overlappingTitles = unrelated.titles.filter((title) => selectedTitles.has(title));
	const actor = store.db
		.prepare("SELECT display_name FROM actors WHERE actor_id = ?")
		.get(store.actorId) as { display_name: string } | undefined;
	const teamExists = Boolean(
		store.db.prepare("SELECT 1 FROM policy_teams WHERE team_id = ?").get(TEAM_ID),
	);
	const memberCount = Number(
		store.db
			.prepare(
				"SELECT COUNT(*) FROM policy_team_memberships WHERE team_id = ? AND status = 'active'",
			)
			.pluck()
			.get(TEAM_ID),
	);
	return {
		ok: true,
		action,
		profile: {
			role: actor ? profileFromDisplayName(actor.display_name) : null,
			identity_id: store.actorId,
			device_id: store.deviceId,
			display_name: actor?.display_name ?? store.actorDisplayName,
		},
		team: {
			team_id: TEAM_ID,
			display_name: TEAM_NAME,
			exists: teamExists,
			member_count: memberCount,
		},
		projects: { selected, unrelated },
		separation: {
			distinct_remotes: selected.remote !== unrelated.remote,
			overlapping_titles: overlappingTitles,
			isolated: selected.remote !== unrelated.remote && overlappingTitles.length === 0,
		},
	};
}

export async function runFixtureAction(
	store: MemoryStore,
	action: FixtureAction,
): Promise<FixtureSummary> {
	if (action === "setup-owner") {
		ensureProfile(store, "owner");
		ensureEmptyTeam(store);
		ensureMemory(store, PROJECTS.selected, PROJECTS.selected.existingTitle);
		ensureMemory(store, PROJECTS.unrelated, PROJECTS.unrelated.existingTitle);
	}
	if (action === "setup-teammate") ensureProfile(store, "teammate");
	if (action === "setup-second-device") ensureProfile(store, "second-device");
	if (action === "add-future-selected") {
		assertOwnerBaseline(store);
		ensureMemory(store, PROJECTS.selected, PROJECTS.selected.futureTitle);
	}
	if (action === "add-future-unrelated") {
		assertOwnerBaseline(store);
		ensureMemory(store, PROJECTS.unrelated, PROJECTS.unrelated.futureTitle);
	}
	await store.flushPendingVectorWrites();
	return buildSafeSummary(store, action);
}

async function main(): Promise<void> {
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	const action = parseFixtureAction(process.argv.slice(2));
	initDatabase(DB_PATH);
	const store = new MemoryStore(DB_PATH);
	try {
		const summary = await runFixtureAction(store, action);
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	} finally {
		store.close();
	}
}

const entrypoint = process.argv[1]
	? pathToFileURL(resolve(process.argv[1])).href
	: null;
if (entrypoint === import.meta.url) {
	void main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
