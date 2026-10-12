import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const uiRoot = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(uiRoot, "static/index.html"), "utf8");
const styles = [];
const links = [];
const blocks = source.matchAll(
	/<!--[\s\S]*?-->|<script(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/script(?:[\t\n\f\r /](?:[^>"']|"[^"]*"|'[^']*')*)?>|<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/style(?:[\t\n\f\r /](?:[^>"']|"[^"]*"|'[^']*')*)?>|<link(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
);
for (const [block] of blocks) {
	if (/^<style(?=[\t\n\f\r />])/i.test(block)) {
		const opening = block.match(/^<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>/i)[0];
		// Consume whole attributes so data-media and quoted text cannot supply media.
		const attributes = opening.slice(6, -1).matchAll(
			/([^\t\n\f\r /=>]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*"|'[^']*'|[^\t\n\f\r >]+))?/g,
		);
		const media = [...attributes].find((attribute) => attribute[1].toLowerCase() === "media")?.[0];
		const css = block
			.slice(opening.length)
			.replace(/<\/style(?:[\t\n\f\r /](?:[^>"']|"[^"]*"|'[^']*')*)?>$/i, "");
		const previous = styles.at(-1);
		if (media === undefined && previous && previous.media === undefined) {
			previous.css += `\n${css}`;
		} else {
			styles.push({ css, media });
		}
		continue;
	}
	if (!/^<link(?=[\t\n\f\r />])/i.test(block)) continue;
	const rel = block.match(/\srel\s*=\s*["']([^"']+)["']/i)?.[1];
	const href = block.match(/\shref\s*=\s*["']([^"']+)["']/i)?.[1];
	if (rel?.toLowerCase() !== "stylesheet" || !href?.startsWith("/assets/")) continue;
	if (styles.length) {
		throw new Error("Gallery: local stylesheet after inline viewer CSS would change cascade order");
	}
	links.push(block.replace(/(\shref\s*=\s*["'])\/assets\//i, "$1/static/"));
}
if (!styles.length) throw new Error("Gallery: canonical viewer stylesheet is missing");
if (!links.length) throw new Error("Gallery: canonical viewer style links are missing");
const localStylesheets = links.join("\n");
const outputRoot = resolve(uiRoot, ".tmp");
mkdirSync(outputRoot, { recursive: true });

const inlineStylesheets = styles
	.map(({ css, media }, index) => {
		let filename = "gallery-viewer.css";
		if (index > 0) filename = `gallery-viewer-${index}.css`;
		writeFileSync(resolve(outputRoot, filename), css);
		// Preserve HTML syntax verbatim; the browser interprets media and entities.
		const attribute = media === undefined ? "" : ` ${media}`;
		return `<link rel="stylesheet" href="/.tmp/${filename}"${attribute} />`;
	})
	.join("\n");

// Only the canonical local styles are reused: no app scripts, remote fonts,
// localStorage theme bootstrap, or production DOM are included.
writeFileSync(
	resolve(outputRoot, "gallery.html"),
	`<!doctype html>
<html lang="en" data-theme="dark" data-color-mode="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Shared controls gallery</title>
${localStylesheets}
${inlineStylesheets}
</head>
<body><div id="gallery-root"></div>
<script type="module" src="/src/gallery/entry.tsx"></script>
</body></html>`,
);
