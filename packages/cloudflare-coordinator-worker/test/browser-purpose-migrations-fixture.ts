import { join } from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";

export function readBrowserFixtureMigrations() {
	return readD1Migrations(join(import.meta.dirname, "../migrations"));
}
