import type { Database } from "./db.js";

/**
 * A synthetic store shaped like a long-lived device's Projects inventory: 99 entries with 47
 * distinct names, 30 of them named after one repository, 77 identified only by a folder path,
 * and four entries whose name is not a usable Project name. Every name and path is invented.
 */
export const NOISE_FIXTURE_SHARED_SCOPE_ID = "team-noise-fixture";

const NOW = "2026-10-01T00:00:00.000Z";

export const NOISE_FIXTURE_UNUSABLE_NAMES = [
	"GitError: spawn git ENOENT",
	"/",
	"__sync_bootstrap__:peer-project",
	"\\",
] as const;

function session(
	db: Database,
	input: { cwd: string; project: string; gitRemote?: string | null; startedAt?: string },
): void {
	const sessionId = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch, user, tool_version)
				 VALUES (?, ?, ?, ?, 'main', 'fixture-user', 'test')`,
			)
			.run(input.startedAt ?? NOW, input.cwd, input.project, input.gitRemote ?? null)
			.lastInsertRowid,
	);
	db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, created_at, updated_at, visibility, project
		 ) VALUES (?, 'discovery', 'Fixture memory', 'Body', ?, ?, 'private', ?)`,
	).run(sessionId, NOW, NOW, input.project);
}

function remote(name: string): string {
	return `https://git.example.invalid/fixture-org/${name}.git`;
}

export function seedProjectInventoryNoiseFixture(db: Database): void {
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, 'Fixture team', 'team', 'coordinator', 1, 'active', ?, ?)`,
	).run(NOISE_FIXTURE_SHARED_SCOPE_ID, NOW, NOW);
	// One repository: its checkout with a remote, and 29 old folders recorded under its name.
	session(db, {
		cwd: "/fixture/src/alpha-repo",
		project: "alpha-repo",
		gitRemote: remote("alpha-repo"),
	});
	for (let index = 1; index <= 29; index++) {
		session(db, {
			cwd: `/fixture/worktrees/alpha-repo-${index}`,
			project: "alpha-repo",
			startedAt: `2026-0${1 + (index % 9)}-01T00:00:00.000Z`,
		});
	}
	// 21 Projects with a checkout that has a remote and one older folder without one.
	for (let index = 1; index <= 21; index++) {
		const name = `paired-${index}`;
		session(db, { cwd: `/fixture/src/${name}`, project: name, gitRemote: remote(name) });
		session(db, { cwd: `/fixture/old/${name}`, project: name });
	}
	// Two names used by folders in different Sharing domains: a person should check these.
	for (let index = 1; index <= 2; index++) {
		const name = `split-${index}`;
		session(db, { cwd: `/fixture/a/${name}`, project: name });
		session(db, { cwd: `/fixture/b/${name}`, project: name });
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 10, 'user', ?, ?)`,
		).run(`/fixture/b/${name}`, name, NOISE_FIXTURE_SHARED_SCOPE_ID, NOW, NOW);
	}
	// 19 Projects seen in one folder each.
	for (let index = 1; index <= 19; index++) {
		session(db, { cwd: `/fixture/single/solo-${index}`, project: `solo-${index}` });
	}
	// Names left by failed tool calls, a bare separator and an internal marker.
	NOISE_FIXTURE_UNUSABLE_NAMES.forEach((name, index) => {
		session(db, { cwd: `/fixture/junk/entry-${index}`, project: name });
	});
}
