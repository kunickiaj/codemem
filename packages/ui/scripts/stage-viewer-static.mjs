import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const legacyStaticDir = join(repoRoot, "codemem", "viewer_static");
const viewerStaticDir = join(repoRoot, "packages", "viewer-server", "static");

if (!existsSync(legacyStaticDir)) {
	throw new Error(`Legacy viewer static directory missing: ${legacyStaticDir}`);
}

mkdirSync(viewerStaticDir, { recursive: true });

for (const entry of readdirSync(legacyStaticDir, { withFileTypes: true })) {
	if (!entry.isFile()) continue;
	if (entry.name === "app.js") continue;
	if (extname(entry.name) === ".map") continue;
	cpSync(join(legacyStaticDir, entry.name), join(viewerStaticDir, entry.name));
}
