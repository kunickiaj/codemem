import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

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

// Precompress text assets so the viewer server (serveStatic precompressed:true)
// serves .br/.gz. Done HERE, as the final build step, so every asset is the
// freshly-staged content: app.js was written into viewerStaticDir by vite, and
// the CSS above was just copied. Compressing in vite's writeBundle instead would
// race the CSS staging and emit stale/missing CSS siblings.
for (const name of ["app.js", "themes.css", "tokens.css"]) {
	const filePath = join(viewerStaticDir, name);
	if (!existsSync(filePath)) continue;
	const raw = readFileSync(filePath);
	writeFileSync(`${filePath}.gz`, gzipSync(raw, { level: 9 }));
	writeFileSync(
		`${filePath}.br`,
		brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }),
	);
}
