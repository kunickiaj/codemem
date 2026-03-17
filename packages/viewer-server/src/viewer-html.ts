/**
 * Generate the viewer index HTML shell.
 *
 * The actual frontend is a pre-built SPA bundle at viewer_static/app.js.
 * This just provides the minimal HTML wrapper that loads it.
 */

export function viewerHtml(options?: { title?: string }): string {
	const title = options?.title ?? "codemem";
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${title}</title>
</head>
<body>
	<div id="root"></div>
	<script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}
