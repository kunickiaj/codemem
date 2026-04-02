import { connect } from "../../packages/core/src/db.ts";

function parseArgs(argv: string[]): { dbPath: string; prefix: string } {
	let dbPath = "/data/mem.sqlite";
	let prefix = "fixture-small memory ";
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db-path") {
			dbPath = String(argv[index + 1] ?? dbPath);
			index += 1;
		} else if (arg === "--prefix") {
			prefix = String(argv[index + 1] ?? prefix);
			index += 1;
		}
	}
	return { dbPath, prefix };
}

const { dbPath, prefix } = parseArgs(process.argv);
const db = connect(dbPath);
try {
	const rows = db
		.prepare(
			`SELECT title, visibility
			   FROM memory_items
			  WHERE active = 1 AND title LIKE ?
			  ORDER BY title`,
		)
		.all(`${prefix}%`) as Array<{ title: string; visibility: string | null }>;
	const sharedTitles = rows
		.filter((row) => String(row.visibility ?? "shared").trim() !== "private")
		.map((row) => row.title);
	const privateTitles = rows
		.filter((row) => String(row.visibility ?? "").trim() === "private")
		.map((row) => row.title);
	console.log(
		JSON.stringify(
			{
				total: rows.length,
				shared_count: sharedTitles.length,
				private_count: privateTitles.length,
				shared_titles: sharedTitles,
				private_titles: privateTitles,
			},
			null,
			2,
		),
	);
} finally {
	db.close();
}
