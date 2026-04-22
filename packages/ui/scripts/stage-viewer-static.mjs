import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const sourceStaticDir = join(repoRoot, "packages", "ui", "static");
const viewerStaticDir = join(repoRoot, "packages", "viewer-server", "static");

if (!existsSync(sourceStaticDir)) {
	throw new Error(`Viewer static source directory missing: ${sourceStaticDir}`);
}

mkdirSync(viewerStaticDir, { recursive: true });

for (const entry of readdirSync(sourceStaticDir, { withFileTypes: true })) {
	if (!entry.isFile()) continue;
	if (entry.name === "app.js") continue;
	if (extname(entry.name) === ".map") continue;
	cpSync(join(sourceStaticDir, entry.name), join(viewerStaticDir, entry.name));
}
