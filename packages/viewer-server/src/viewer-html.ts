/**
 * Viewer HTML template.
 *
 * Returns the minimal HTML shell for the codemem viewer SPA.
 * Title is hardcoded to avoid XSS from user-supplied parameters.
 */

export function viewerHtml(): string {
	return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>codemem</title>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}
