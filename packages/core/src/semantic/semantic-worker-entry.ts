import { registerHooks } from "node:module";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Only the source worker needs .js -> .ts resolution for the repository's NodeNext imports.
// This hook is local to this thread; emitted workers use ordinary static JS modules.
if (import.meta.url.endsWith(".ts")) {
	const sourceRoot = pathToFileURL(resolve(import.meta.dirname, "..") + sep).href;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (
				context.parentURL?.startsWith(sourceRoot) &&
				specifier.startsWith(".") &&
				specifier.endsWith(".js")
			) {
				return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
			}
			return nextResolve(specifier, context);
		},
	});
}
await import("./semantic-worker-job.js");
