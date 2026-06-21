import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
// serves .br/.gz — but ONLY for production builds, gated behind --precompress.
//
// The production `build` runs this AFTER vite, so the staged assets are final
// and we emit fresh sidecars. `build:watch` runs this BEFORE vite (and vite
// then rebuilds app.js on every change without re-staging), so emitting
// sidecars there would leave stale .gz/.br that serveStatic would serve instead
// of the freshly rebuilt bundle. In that mode we instead STRIP any existing
// sidecars so the server falls back to the live raw asset.
const precompress = process.argv.includes("--precompress");
for (const name of ["app.js", "themes.css", "tokens.css"]) {
	const filePath = join(viewerStaticDir, name);
	const gzPath = `${filePath}.gz`;
	const brPath = `${filePath}.br`;
	if (!precompress) {
		rmSync(gzPath, { force: true });
		rmSync(brPath, { force: true });
		continue;
	}
	if (!existsSync(filePath)) continue;
	const raw = readFileSync(filePath);
	writeFileSync(gzPath, gzipSync(raw, { level: 9 }));
	writeFileSync(
		brPath,
		brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }),
	);
}
