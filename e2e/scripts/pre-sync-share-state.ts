import { connect } from "../../packages/core/src/db.ts";

/**
 * Read-only state for the pre-sync share scenario: the origins of the seeded
 * fixture memories, the imported memory without a known author, and the
 * inbound rejections this device recorded.
 */
const db = connect("/data/mem.sqlite");
try {
	console.log(
		JSON.stringify({
			origins: db
				.prepare(
					`SELECT COALESCE(origin_device_id, '') AS origin, visibility, COUNT(*) AS count
					 FROM memory_items WHERE title LIKE 'fixture-small memory %'
					 GROUP BY 1, 2 ORDER BY 1, 2`,
				)
				.all(),
			imported: db
				.prepare(
					`SELECT COALESCE(scope_id, 'local-default') AS scope_id, COALESCE(origin_device_id, '') AS origin
					 FROM memory_items WHERE title = 'imported pre-sync memory'`,
				)
				.all(),
			rejections: db
				.prepare("SELECT reason, scope_id, COUNT(*) AS count FROM sync_scope_rejections GROUP BY 1, 2")
				.all(),
		}),
	);
} finally {
	db.close();
}
