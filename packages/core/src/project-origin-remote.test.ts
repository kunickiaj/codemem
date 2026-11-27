import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real git runs. The wrapper only counts how often a child process is started.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const { execFileSync } = await import("node:child_process");
const { resolveGitRepositoryIdentity } = await import("./project.js");

let dir: string;

/** A repository whose config file has the given text. */
function repository(name: string, config: string): string {
	const root = join(dir, name);
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, ".git", "config"), config);
	return root;
}

function origin(url: string): string {
	return `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`;
}

function setConfig(root: string, config: string): void {
	writeFileSync(join(root, ".git", "config"), config);
}

function childProcessesDuring(work: () => void): number {
	const before = vi.mocked(execFileSync).mock.calls.length;
	work();
	return vi.mocked(execFileSync).mock.calls.length - before;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-origin-remote-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("the origin remote of a repository", () => {
	it("is asked of git once while the config file reads the same", () => {
		const root = repository("one", origin("https://example.test/acme/one.git"));

		const first = resolveGitRepositoryIdentity(root);
		const repeats = childProcessesDuring(() => {
			for (let call = 0; call < 20; call++) {
				expect(resolveGitRepositoryIdentity(root)).toEqual(first);
			}
		});

		expect(first?.identity).toBe("https://example.test/acme/one.git");
		expect(repeats).toBe(0);
	});

	it("is asked again as soon as the config file changes", () => {
		const root = repository("moved", origin("https://example.test/acme/before.git"));
		resolveGitRepositoryIdentity(root);
		setConfig(root, origin("https://example.test/acme/after.git"));

		let identity: string | undefined;
		const asked = childProcessesDuring(() => {
			identity = resolveGitRepositoryIdentity(root)?.identity;
		});

		expect(identity).toBe("https://example.test/acme/after.git");
		expect(asked).toBe(1);
	});

	it("is seen when a remote is added to a repository that had none", () => {
		const root = repository("later", "[core]\n\tbare = false\n");
		const without = resolveGitRepositoryIdentity(root);
		setConfig(root, origin("https://example.test/acme/later.git"));

		expect(without?.source).toBe("git_common_dir");
		expect(resolveGitRepositoryIdentity(root)).toMatchObject({
			identity: "https://example.test/acme/later.git",
			source: "git_remote",
		});
	});

	it("is remembered as absent for a repository without one", () => {
		const root = repository("local", "[core]\n\tbare = false\n");

		const first = resolveGitRepositoryIdentity(root);
		const repeats = childProcessesDuring(() => {
			expect(resolveGitRepositoryIdentity(root)).toEqual(first);
		});

		expect(first?.source).toBe("git_common_dir");
		expect(repeats).toBe(0);
	});

	it("is kept apart for two repositories whose config files read the same", () => {
		const config = origin("../shared.git");
		const first = repository("a/checkout", config);
		const second = repository("b/checkout", config);

		const identities = [first, second, first, second].map(
			(root) => resolveGitRepositoryIdentity(root)?.identity,
		);

		// A relative remote resolves against its own repository.
		expect(identities[0]).not.toBe(identities[1]);
		expect(identities.slice(2)).toEqual(identities.slice(0, 2));
	});
});

describe("a config file that includes another", () => {
	it("is asked of git every time, so a change in the included file is seen", () => {
		const included = join(dir, "remote.inc");
		writeFileSync(included, origin("https://example.test/acme/included-before.git"));
		const root = repository("including", `[include]\n\tpath = ${included}\n`);

		const before = resolveGitRepositoryIdentity(root)?.identity;
		writeFileSync(included, origin("https://example.test/acme/included-after.git"));
		let after: string | undefined;
		const asked = childProcessesDuring(() => {
			after = resolveGitRepositoryIdentity(root)?.identity;
		});

		expect(before).toBe("https://example.test/acme/included-before.git");
		expect(after).toBe("https://example.test/acme/included-after.git");
		expect(asked).toBe(1);
	});
});

describe("a config file that changes before git reads it", () => {
	it("does not have git's answer for the new text remembered for the old one", async () => {
		const first = origin("https://example.test/acme/first.git");
		const root = repository("racing", first);
		const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		// The file is rewritten after it was read here and before git reads it.
		vi.mocked(execFileSync).mockImplementationOnce(((...args: Parameters<typeof execFileSync>) => {
			setConfig(root, origin("https://example.test/acme/second.git"));
			return actual.execFileSync(...args);
		}) as typeof execFileSync);

		const during = resolveGitRepositoryIdentity(root)?.identity;
		setConfig(root, first);
		const restored = resolveGitRepositoryIdentity(root)?.identity;

		expect(during).toBe("https://example.test/acme/second.git");
		expect(restored).toBe("https://example.test/acme/first.git");
	});
});

describe("a config file git cannot answer for", () => {
	it("is not remembered when it is missing", () => {
		const root = join(dir, "bare-marker");
		mkdirSync(join(root, ".git"), { recursive: true });

		const asked = childProcessesDuring(() => {
			resolveGitRepositoryIdentity(root);
			resolveGitRepositoryIdentity(root);
		});

		expect(resolveGitRepositoryIdentity(root)?.source).toBe("git_common_dir");
		expect(asked).toBe(2);
	});

	it("is not remembered when it is not a valid config file", () => {
		const root = repository("broken", '[remote "origin"\n\turl = https://example.test/x.git\n');

		const asked = childProcessesDuring(() => {
			resolveGitRepositoryIdentity(root);
			resolveGitRepositoryIdentity(root);
		});

		expect(asked).toBe(2);
	});
});
