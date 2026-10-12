/// <reference types="node" />

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), mkdir: vi.fn() }));
vi.mock("node:fs", () => {
	const fs = { readFileSync: io.read, writeFileSync: io.write, mkdirSync: io.mkdir };
	return { ...fs, default: fs };
});

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const uiRoot = resolve(import.meta.dirname, "../..");
const canonicalHtml = realFs.readFileSync(resolve(uiRoot, "static/index.html"), "utf8");
const originalArgv = process.argv;

function output(filename: string): string {
	const call = io.write.mock.calls.find(([path]) => path === resolve(uiRoot, ".tmp", filename));
	if (!call) throw new Error(`Generator did not write ${filename}`);
	return call[1];
}

beforeEach(() => {
	process.argv = originalArgv.slice();
	vi.resetModules();
	io.read.mockReset().mockReturnValue(canonicalHtml);
	io.write.mockReset();
	io.mkdir.mockReset();
});

afterEach(() => {
	process.argv = originalArgv;
	vi.restoreAllMocks();
});

describe("gallery tooltip stylesheet fidelity", () => {
	it("preserves the tooltip positioning parent and its real opening animation", async () => {
		// Arrange: read canonical CSS through the existing mocked generator filesystem.
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		const rule = output("gallery-viewer.css").match(/\.tooltip-content\s*\{([^}]+)\}/)?.[1];
		// Assert: stabilizing arrow placement must not remove the production animation.
		expect(rule).toMatch(/position:\s*relative;/);
		expect(rule).toMatch(/animation:\s*tooltipFade/);
	});

	it("does not invent tooltip positioning when the canonical source omits it", async () => {
		// Arrange
		io.read.mockReturnValue(
			canonicalHtml.replace(/(\.tooltip-content\s*\{)\s*position:\s*relative;/, "$1"),
		);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		const rule = output("gallery-viewer.css").match(/\.tooltip-content\s*\{([^}]+)\}/)?.[1];
		// Assert: the gallery must expose canonical regressions, not repair them with fixture CSS.
		expect(rule).not.toMatch(/position:\s*relative;/);
		expect(rule).toMatch(/animation:\s*tooltipFade/);
	});
});

describe("gallery HTML generator", () => {
	it("preserves canonical CSS byte for byte without importing viewer DOM or scripts", async () => {
		// Arrange: use the actual canonical stylesheet, not a copied fixture snapshot.
		const canonical = new DOMParser().parseFromString(canonicalHtml, "text/html");
		const styles = [...canonical.querySelectorAll("style")]
			.map((style) => style.textContent)
			.join("\n");
		// Act: filesystem writes are mocked so no production or generated files change.
		await import("../../scripts/make-gallery-html.mjs");
		const generated = new DOMParser().parseFromString(output("gallery.html"), "text/html");
		// Assert
		expect(output("gallery-viewer.css")).toBe(styles);
		expect(output("gallery-viewer.css")).not.toMatch(/@font-face|@import|url\(\s*["']?https?:/i);
		expect(styles.length).toBeGreaterThan(1000);
		expect(generated.body.children).toHaveLength(2);
		expect(generated.querySelector("#gallery-root")).not.toBeNull();
		expect(generated.querySelectorAll("style,iframe")).toHaveLength(0);
		expect(io.read).toHaveBeenCalledExactlyOnceWith(resolve(uiRoot, "static/index.html"), "utf8");
		expect(io.write.mock.calls.map(([path]) => path)).toEqual([
			resolve(uiRoot, ".tmp/gallery-viewer.css"),
			resolve(uiRoot, ".tmp/gallery.html"),
		]);
		expect(io.mkdir).toHaveBeenCalledExactlyOnceWith(resolve(uiRoot, ".tmp"), { recursive: true });
		expect(io.read.mock.invocationCallOrder[0]).toBeLessThan(io.mkdir.mock.invocationCallOrder[0]);
		expect(io.mkdir.mock.invocationCallOrder[0]).toBeLessThan(io.write.mock.invocationCallOrder[0]);
	});

	it("loads only gallery entry and local shared styles, with no API, remote fonts or app bootstrap", async () => {
		// Arrange
		const canonical = new DOMParser().parseFromString(canonicalHtml, "text/html");
		const allowedStyles = [...canonical.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
			.map((link) => link.getAttribute("href") || "")
			.filter((href) => href.startsWith("/assets/"))
			.map((href) => href.replace("/assets/", "/static/"));
		allowedStyles.push("/.tmp/gallery-viewer.css");
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		const html = output("gallery.html");
		const page = new DOMParser().parseFromString(html, "text/html");
		// Assert
		expect(
			[...page.querySelectorAll("link")].map((link) => [link.rel, link.getAttribute("href")]),
		).toEqual(allowedStyles.map((href) => ["stylesheet", href]));
		const scripts = [...page.querySelectorAll("script")];
		expect(scripts).toHaveLength(1);
		expect(scripts[0].type).toBe("module");
		expect(scripts[0].getAttribute("src")).toBe("/src/gallery/entry.tsx");
		expect(scripts[0].textContent).toBe("");
		expect(page.documentElement.dataset).toMatchObject({ theme: "dark", colorMode: "dark" });
		expect(html).not.toMatch(
			/https?:|\/\/|\/api\b|app\.(?:js|ts)|localStorage|@font-face|fontsource|fonts\./,
		);
	});

	it("keeps multiple style blocks in order without normalizing CSS or copying surrounding scripts", async () => {
		// Arrange: preserve browser-tolerated braces and whitespace too.
		io.read.mockReturnValue(
			'<link rel="stylesheet" href="/assets/tokens.css"><script src="/app.js"></script><style>\n.a { color: red; } }\n</style><p>Viewer</p><style>/* second */\n.b{color:blue}</style>',
		);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		// Assert
		expect(output("gallery-viewer.css")).toBe("\n.a { color: red; } }\n");
		expect(output("gallery-viewer-1.css")).toBe("/* second */\n.b{color:blue}");
		const page = new DOMParser().parseFromString(output("gallery.html"), "text/html");
		expect([...page.querySelectorAll("link")].map((link) => link.getAttribute("href"))).toEqual([
			"/static/tokens.css",
			"/.tmp/gallery-viewer.css",
			"/.tmp/gallery-viewer-1.css",
		]);
		expect(output("gallery.html")).not.toContain("/app.js");
		expect(output("gallery.html")).not.toContain("<p>Viewer</p>");
	});

	it("preserves a legal import at the start of a second stylesheet instead of merging after rules", async () => {
		// Arrange: an import after .one{} in a merged sheet would be ignored by the browser.
		const first = ".one{}";
		const second = '@import "/static/synthetic-import.css"; .two{}';
		io.read.mockReturnValue(
			`<link rel=stylesheet href=/assets/base.css><style>${first}</style><style>${second}</style>`,
		);
		// Act: mock all output IO; no HTTP request is needed to preserve sheet boundaries.
		await import("../../scripts/make-gallery-html.mjs");
		const page = new DOMParser().parseFromString(output("gallery.html"), "text/html");
		// Assert: each original stylesheet retains its bytes and its position.
		expect(output("gallery-viewer.css")).toBe(first);
		expect(output("gallery-viewer-1.css")).toBe(second);
		expect([...page.querySelectorAll("link")].map((link) => link.getAttribute("href"))).toEqual([
			"/static/base.css",
			"/.tmp/gallery-viewer.css",
			"/.tmp/gallery-viewer-1.css",
		]);
	});

	it.each(["", "<style src='missing.css'>", "<link rel='stylesheet' href='/viewer.css'>"])(
		"rejects a canonical source without complete style blocks: %j",
		async (source) => {
			// Arrange
			io.read.mockReturnValue(source);
			// Act
			const generate = import("../../scripts/make-gallery-html.mjs");
			// Assert
			await expect(generate).rejects.toThrow("Gallery: canonical viewer stylesheet is missing");
			expect(io.write).not.toHaveBeenCalled();
			expect(io.mkdir).not.toHaveBeenCalled();
		},
	);

	it("propagates a failed canonical read without writing partial generated files", async () => {
		// Arrange
		io.read.mockImplementation(() => {
			throw new Error("Synthetic read failure");
		});
		// Act
		const generate = import("../../scripts/make-gallery-html.mjs");
		// Assert
		await expect(generate).rejects.toThrow("Synthetic read failure");
		expect(io.write).not.toHaveBeenCalled();
		expect(io.mkdir).not.toHaveBeenCalled();
	});
});

describe("gallery inline stylesheet media", () => {
	it.each([
		['media="print"', "print"],
		["media='screen and (min-width: 40rem)'", "screen and (min-width: 40rem)"],
		['media="screen and (width &#62; 40rem)"', "screen and (width > 40rem)"],
		['media="screen and (width > 800px)"', "screen and (width > 800px)"],
		["MeDiA='screen and (width >= 800px)'", "screen and (width >= 800px)"],
		["MeDiA = PRINT", "PRINT"],
		['MEDIA="screen\nand (min-width: 40rem)"', "screen\nand (min-width: 40rem)"],
		['media=""', ""],
		["media=ALL", "ALL"],
	])("preserves raw %s on its own stylesheet link", async (attribute, media) => {
		// Arrange: the browser, not the generator, decodes entities and media queries.
		const css = '\n@charset "UTF-8"; @keyframes KeepCase { to { opacity: 0; } }\n';
		io.read.mockReturnValue(
			`<link rel="stylesheet" href="/assets/base.css"><StYlE ${attribute}>${css}</sTyLe>`,
		);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		const html = output("gallery.html");
		const links = new DOMParser().parseFromString(html, "text/html").querySelectorAll("link");
		// Assert: CSS bytes and media survive without an unconditional replacement link.
		expect(output("gallery-viewer.css")).toBe(css);
		expect(html).toContain(`href="/.tmp/gallery-viewer.css" ${attribute}`);
		expect(
			[...links].map((link) => [link.getAttribute("href"), link.getAttribute("media")]),
		).toEqual([
			["/static/base.css", null],
			["/.tmp/gallery-viewer.css", media],
		]);
	});

	it("preserves quoted tag boundaries without exposing script literals as styles", async () => {
		// Arrange: quoted greater-than signs do not terminate HTML tags.
		const css = "\n.real{--KeepCase:RED}\n";
		const link =
			'<LINK REL="stylesheet" HREF="/assets/base.css" MEDIA="screen and (width > 800px)">';
		io.read.mockReturnValue(
			`<SCRIPT data-note="a > b">const fake = '<style>.fake{}</style>';</sCrIpT data-note='a > b'>${link}<STYLE>${css}</sTyLe data-note="a > b">`,
		);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		// Assert: retain the complete local link and CSS, never the script's fake CSS.
		expect(output("gallery-viewer.css")).toBe(css);
		expect(output("gallery.html")).toContain(link.replace("/assets/", "/static/"));
		expect(output("gallery.html")).not.toMatch(/\.fake|const fake/);
	});

	it("keeps every unconditional and conditional stylesheet in source order", async () => {
		// Arrange: data attributes and quoted attribute values must not supply media.
		io.read.mockReturnValue(`<link rel="stylesheet" href="/assets/base.css">
<style data-media="print">.first{}</style><style title=' media="print"'>.second{}</style>
<style media=print>.print{}</style><style media=print>.alsoPrint{}</style>
<style>.last{}</style><style>.end{}</style>`);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		const page = new DOMParser().parseFromString(output("gallery.html"), "text/html");
		// Assert: retain stylesheet boundaries even when adjacent media attributes match.
		expect(output("gallery-viewer.css")).toBe(".first{}");
		expect(output("gallery-viewer-1.css")).toBe(".second{}");
		expect(output("gallery-viewer-2.css")).toBe(".print{}");
		expect(output("gallery-viewer-3.css")).toBe(".alsoPrint{}");
		expect(output("gallery-viewer-4.css")).toBe(".last{}");
		expect(output("gallery-viewer-5.css")).toBe(".end{}");
		expect(
			[...page.querySelectorAll("link")].map((link) => [
				link.getAttribute("href"),
				link.getAttribute("media"),
			]),
		).toEqual([
			["/static/base.css", null],
			["/.tmp/gallery-viewer.css", null],
			["/.tmp/gallery-viewer-1.css", null],
			["/.tmp/gallery-viewer-2.css", "print"],
			["/.tmp/gallery-viewer-3.css", "print"],
			["/.tmp/gallery-viewer-4.css", null],
			["/.tmp/gallery-viewer-5.css", null],
		]);
	});

	it("rejects a local link after conditional CSS before creating any output", async () => {
		// Arrange
		io.read.mockReturnValue(
			'<link rel="stylesheet" href="/assets/base.css"><style media=print>.print{}</style><link rel="stylesheet" href="/assets/late.css">',
		);
		// Act
		const generate = import("../../scripts/make-gallery-html.mjs");
		// Assert
		await expect(generate).rejects.toThrow(
			"Gallery: local stylesheet after inline viewer CSS would change cascade order",
		);
		expect(io.mkdir).not.toHaveBeenCalled();
		expect(io.write).not.toHaveBeenCalled();
	});
});

describe("gallery canonical stylesheet links", () => {
	it.each([
		`<LINK data-note=' href="/assets/fake.css" rel="preload"' rEl = StYlEsHeEt hReF = /assets/Case.css?v=2&amp;x=3>`,
		`<link title=" href='/assets/fake.css' rel='preload'" REL='alternate\tSTYLESHEET\nnext' HREF = "/assets/Case.css?v=2&amp;x=3" href='/assets/duplicate.css' rel=preload>`,
	])("rewrites only the first real href in %s", async (link) => {
		// Arrange: retain raw attributes and entities; rel is an ASCII-whitespace token list.
		io.read.mockReturnValue(`${link}<style>.Case{--Keep:RED}</style>`);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		// Assert
		expect(output("gallery-viewer.css")).toBe(".Case{--Keep:RED}");
		expect(output("gallery.html")).toContain(link.replace("/assets/Case.css", "/static/Case.css"));
	});

	it.each([
		`<link title=' rel="stylesheet" href="/assets/fake.css"'>`,
		`<link rel=stylesheet data-href=/assets/fake.css title=' href="/assets/fake.css"'>`,
		`<link data-rel=stylesheet href=/assets/fake.css title=' rel="stylesheet"'>`,
		`<link rel=preload rel=stylesheet href=/assets/fake.css>`,
		`<link rel=stylesheet href=/remote.css href=/assets/fake.css>`,
		`<link rel="prestylesheet stylesheet\u00a0next" href=/assets/fake.css>`,
		`<link rel=stylesheet href=/Assets/fake.css>`,
	])("rejects pseudo attributes or nonmatching first values: %s", async (link) => {
		// Arrange: exact names, first duplicate values and case-sensitive asset paths matter.
		io.read.mockReturnValue(`${link}<style>.fixture{}</style>`);
		// Act
		const generate = import("../../scripts/make-gallery-html.mjs");
		// Assert
		await expect(generate).rejects.toThrow("Gallery: canonical viewer style links are missing");
		expect(io.mkdir).not.toHaveBeenCalled();
		expect(io.write).not.toHaveBeenCalled();
	});

	it("rejects unquoted token-list local links after inline CSS before outputs", async () => {
		// Arrange
		io.read.mockReturnValue(
			'<link rel=stylesheet href=/assets/base.css><style>.fixture{}</style><link rel="next STYLESHEET" href=/assets/late.css>',
		);
		// Act
		const generate = import("../../scripts/make-gallery-html.mjs");
		// Assert
		await expect(generate).rejects.toThrow(
			"Gallery: local stylesheet after inline viewer CSS would change cascade order",
		);
		expect(io.mkdir).not.toHaveBeenCalled();
		expect(io.write).not.toHaveBeenCalled();
	});

	it.each([
		["LINK", "REL", "HREF", "STYLESHEET", "STYLE", "style"],
		["LiNk", "rEl", "hReF", "StyleSheet", "StYlE", "sTyLe"],
	])("preserves CSS and attributes for %s markup", async (link, rel, href, value, style, end) => {
		// Arrange: HTML names and the stylesheet rel value are case-insensitive, CSS is not.
		const css = "\n.CaseSensitive { --Token: RED; } /* Keep BYTES */\n";
		const attributes = `${rel}='${value}' ${href}='/assets/Case.css?v=2' MEDIA='screen' data-fixture='KeepCase'`;
		io.read.mockReturnValue(`<${link} ${attributes}><${style}>${css}</${end}>`);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		// Assert
		expect(output("gallery-viewer.css")).toBe(css);
		expect(output("gallery.html")).toContain(
			`<${link} ${attributes.replace("/assets/", "/static/")}>`,
		);
	});

	it("mirrors newly added local styles in order, preserving attributes while excluding remote fonts", async () => {
		// Arrange
		io.read.mockReturnValue(`
<link rel="preconnect" href="https://fonts.example.test">
<link rel="stylesheet" href="https://fonts.example.test/font.css">
<link rel="stylesheet" href="/assets/first.css" media="screen">
<link href='/assets/new-control.css?v=2' rel='stylesheet' data-fixture='new'>
<link rel="preload" href="/assets/not-a-stylesheet.css">
<style>.fixture{color:red}</style>`);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		const page = new DOMParser().parseFromString(output("gallery.html"), "text/html");
		const links = [...page.querySelectorAll("link")];
		// Assert
		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"/static/first.css",
			"/static/new-control.css?v=2",
			"/.tmp/gallery-viewer.css",
		]);
		expect(links[0].media).toBe("screen");
		expect(links[1].dataset.fixture).toBe("new");
		expect(output("gallery.html")).not.toContain("fonts.example.test");
		expect(output("gallery.html")).not.toContain("not-a-stylesheet.css");
	});

	it.each([
		"<style>.fixture{}</style>",
		"<STYLE>.fixture{}</sTyLe><LINK REL='PRELOAD' HREF='/assets/control.css'>",
		'<style>.fixture{}</style><link rel="stylesheet" href="https://fonts.example.test/font.css">',
		'<style>.fixture{}</style><link rel="preload" href="/assets/control.css">',
	])("rejects canonical CSS with no local stylesheet links: %j", async (source) => {
		// Arrange
		io.read.mockReturnValue(source);
		// Act
		const generate = import("../../scripts/make-gallery-html.mjs");
		// Assert
		await expect(generate).rejects.toThrow("Gallery: canonical viewer style links are missing");
		expect(io.write).not.toHaveBeenCalled();
		expect(io.mkdir).not.toHaveBeenCalled();
	});
});

describe("gallery stable stdin source", () => {
	it("reads stdin instead of the canonical path and preserves exact CSS", async () => {
		// Arrange: caller supplies stable canonical bytes without a second disk read.
		process.argv.push("--stdin");
		const css = "\n.Case{--Keep:RED} /* stable bytes */\n";
		io.read.mockReturnValue(`<link rel=stylesheet href=/assets/base.css><style>${css}</style>`);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		// Assert
		expect(io.read).toHaveBeenCalledExactlyOnceWith(0, "utf8");
		expect(output("gallery-viewer.css")).toBe(css);
		expect(output("gallery.html")).toContain("href=/static/base.css");
	});

	it.each(["invalid source", "read error"])(
		"fails before outputs for stdin %s",
		async (failure) => {
			// Arrange
			process.argv.push("--stdin");
			io.read.mockImplementation(() => {
				if (failure === "read error") throw new Error("Synthetic stdin failure");
				return "<style>.fixture{}</style>";
			});
			// Act
			const generate = import("../../scripts/make-gallery-html.mjs");
			// Assert
			await expect(generate).rejects.toThrow(
				failure === "read error"
					? "Synthetic stdin failure"
					: "Gallery: canonical viewer style links are missing",
			);
			expect(io.read).toHaveBeenCalledExactlyOnceWith(0, "utf8");
			expect(io.mkdir).not.toHaveBeenCalled();
			expect(io.write).not.toHaveBeenCalled();
		},
	);
});

describe("gallery canonical cascade order", () => {
	it.each(
		[" ", "\t", "\n", "\f", "\r", " data-end='yes'", "/"].flatMap((suffix) =>
			["before", "after"].map((position) => [suffix, position]),
		),
	)("ignores script literals with end suffix %j %s real CSS", async (suffix, position) => {
		// Arrange: a prefix end tag must not end script raw text either.
		const css = "\n.real { --KeepCase: RED; }\n";
		const real = `<LINK REL='stylesheet' HREF='/assets/real.css'><STYLE>${css}</style>`;
		const script = `<SCRIPT>const fake = '</script-not-a-tag><link rel="stylesheet" href="/assets/fake.css"><style>.fake{}</style>';</sCrIpT${suffix}>`;
		io.read.mockReturnValue(position === "before" ? script + real : real + script);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		// Assert
		expect(output("gallery-viewer.css")).toBe(css);
		expect(output("gallery.html")).toContain("HREF='/static/real.css'");
		expect(output("gallery.html")).not.toMatch(/fake\.css|\.fake|const fake/);
	});

	it.each(
		[" ", "\t", "\n", "\f", "\r", " data-end='yes'", "/"].flatMap((suffix) =>
			[false, true].map((late) => ({ suffix, late })),
		),
	)("handles style end $suffix with late stylesheet $late", async ({ suffix, late }) => {
		// Arrange: tolerate HTML end syntax without changing bytes or cascade order.
		const css = "\n.real { --KeepCase: RED; }\n";
		const tail = late ? "<LINK REL='stylesheet' HREF='/assets/late.css'>" : "";
		io.read.mockReturnValue(
			`<link rel='stylesheet' href='/assets/real.css'><STYLE>${css}</sTyLe${suffix}>${tail}`,
		);
		// Act
		const generate = import("../../scripts/make-gallery-html.mjs");
		// Assert
		if (late) {
			await expect(generate).rejects.toThrow(
				"Gallery: local stylesheet after inline viewer CSS would change cascade order",
			);
			expect(io.mkdir).not.toHaveBeenCalled();
			expect(io.write).not.toHaveBeenCalled();
			return;
		}
		await generate;
		expect(output("gallery-viewer.css")).toBe(css);
	});

	it("does not recognize script, style or link prefix names as real tags", async () => {
		// Arrange: a script prefix must not hide real styles, other prefixes must not supply them.
		const css = ".real{--KeepCase:RED}";
		io.read.mockReturnValue(
			`<link-not-a-tag rel='stylesheet' href='/assets/fake.css'><style-not-a-tag>.fake{}</style-not-a-tag><script-not-a-tag><link rel='stylesheet' href='/assets/real.css'><style>${css}</style></script-not-a-tag>`,
		);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		// Assert
		expect(output("gallery-viewer.css")).toBe(css);
		expect(output("gallery.html")).toContain("href='/static/real.css'");
		expect(output("gallery.html")).not.toMatch(/fake\.css|\.fake/);
	});

	it.each([
		["SCRIPT", "sCrIpT", "before"],
		["ScRiPt", "script", "before"],
		["SCRIPT", "sCrIpT", "after"],
		["ScRiPt", "script", "after"],
	])("ignores %s literals closed by %s %s real CSS", async (opening, closing, position) => {
		// Arrange: script raw text must not supply canonical CSS or change its cascade order.
		const css = "\n.real { color: red; } /* Keep BYTES */\n";
		const real = `<link rel="stylesheet" href="/assets/real.css"><style>${css}</style>`;
		const script = `<${opening}>const fake = '<link rel="stylesheet" href="/assets/fake.css"><style>.fake{}</style>';</${closing}>`;
		io.read.mockReturnValue(position === "before" ? script + real : real + script);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		// Assert
		expect(output("gallery-viewer.css")).toBe(css);
		expect(output("gallery.html")).toContain('href="/static/real.css"');
		expect(output("gallery.html")).not.toMatch(/fake\.css|\.fake|const fake/);
	});

	it.each([
		'<style>.first{}</style><link rel="stylesheet" href="/assets/late.css">',
		"<STYLE>.first{}</sTyLe><LINK REL='STYLESHEET' HREF='/assets/late.css'>",
		"<StYlE>.first{}</style><LiNk rEl='StyleSheet' hReF='/assets/late.css'>",
		'<style>.first{}</style><link rel="stylesheet" href="/assets/between.css"><style>.second{}</style>',
	])(
		"rejects a local stylesheet after inline CSS without writing reordered output: %j",
		async (tail) => {
			// Arrange
			io.read.mockReturnValue(`<link rel="stylesheet" href="/assets/first.css">${tail}`);
			// Act
			const generate = import("../../scripts/make-gallery-html.mjs");
			// Assert
			await expect(generate).rejects.toThrow(
				"Gallery: local stylesheet after inline viewer CSS would change cascade order",
			);
			expect(io.write).not.toHaveBeenCalled();
			expect(io.mkdir).not.toHaveBeenCalled();
		},
	);

	it("ignores commented blocks and script literals while preserving legacy comments inside real CSS", async () => {
		// Arrange: style content is raw text, including its legacy HTML comment delimiters.
		const css = "\n<!--\n.fixture { color: red; }\n-->\n";
		io.read.mockReturnValue(`
<!-- <link rel="stylesheet" href="/assets/comment.css"><style>.comment{}</style> -->
<script>const template = '<link rel="stylesheet" href="/assets/script.css"><style>.script{}</style>';</script>
<link rel="stylesheet" href="/assets/real.css">
<style>${css}</style>
<!-- <link rel="stylesheet" href="/assets/comment-after.css"><style>.commentAfter{}</style> -->
<script>const later = '<link rel="stylesheet" href="/assets/script-after.css">';</script>`);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		const page = new DOMParser().parseFromString(output("gallery.html"), "text/html");
		// Assert
		expect(output("gallery-viewer.css")).toBe(css);
		expect([...page.querySelectorAll("link")].map((link) => link.getAttribute("href"))).toEqual([
			"/static/real.css",
			"/.tmp/gallery-viewer.css",
		]);
		expect(output("gallery.html")).not.toMatch(
			/comment(?:-after)?\.css|script(?:-after)?\.css|const template|const later/,
		);
	});

	it("reads real attributes with whitespace around equals without mistaking data attributes for href or rel", async () => {
		// Arrange
		io.read.mockReturnValue(`
<link rel="stylesheet" data-href="/assets/fake-href.css">
<link data-rel="stylesheet" href="/assets/fake-rel.css">
<link data-href="/assets/data.css" data-rel="preload" rel = 'stylesheet' href = '/assets/actual.css' media = 'screen'>
<style>.fixture{}</style>`);
		// Act
		await import("../../scripts/make-gallery-html.mjs");
		const page = new DOMParser().parseFromString(output("gallery.html"), "text/html");
		const links = [...page.querySelectorAll("link")];
		// Assert
		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"/static/actual.css",
			"/.tmp/gallery-viewer.css",
		]);
		expect(links[0].media).toBe("screen");
		expect(links[0].dataset.href).toBe("/assets/data.css");
		expect(links[0].dataset.rel).toBe("preload");
		expect(output("gallery.html")).not.toMatch(/fake-href\.css|fake-rel\.css/);
	});
});
