import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildFilterBranchesWithContext } from "../filters.js";
import { createFixture, vector } from "./semantic-ranking.test-helper.js";

it("provides real vec0 rows and real authorization without runtime keys or inference", () => {
	// Arrange: use only a disposable database and HOME.
	const directory = mkdtempSync(join(tmpdir(), "semantic-ranking-fixture-"));
	vi.stubEnv("HOME", directory);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	const fixture = createFixture(directory);
	try {
		const visible = fixture.memory();
		const hidden = fixture.memory("hidden");
		fixture.rawVector(visible, vector(1));
		fixture.rawVector(hidden, vector(0));
		const branches = buildFilterBranchesWithContext(null, {
			...fixture.context,
			enforceScopeVisibility: true,
		});
		// Act: exercise the actual SQL scope predicate and native extension.
		const ids = branches.flatMap((branch) =>
			fixture.db
				.prepare(`SELECT id FROM memory_items WHERE ${branch.clauses.join(" AND ")}`)
				.all(...branch.params),
		);
		const native = fixture.db
			.prepare("SELECT memory_id FROM memory_vectors WHERE embedding MATCH ? AND k = 1")
			.all(Buffer.from(vector().buffer));
		// Assert: the closest row is hidden, while real authorization admits only the other row.
		expect({ ids, native }).toEqual({ ids: [{ id: visible }], native: [{ memory_id: hidden }] });
	} finally {
		fixture.db.close();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}
});
