/**
 * Node options for Vitest worker processes in projects that load Core from source.
 *
 * Core's tests start the semantic worker from TypeScript source, so each worker thread strips
 * types with Node's WebAssembly type stripper. Node 24's V8 (13.6) can free a WebAssembly
 * import wrapper twice when one thread is using it while another thread ends, and then
 * aborts the whole process with "Check failed: jit_page.has_value()" (SIGTRAP). Vitest
 * reports the dead fork as "Worker exited unexpectedly", which fails the run even when every
 * test passed (nodejs/node#66366; the backport, nodejs/node#66376, is not in a Node 24
 * release yet).
 *
 * Turning off V8's garbage collection of WebAssembly code closes that race. Dead WebAssembly
 * code then stays allocated for the life of the fork, a few MB. A crash for any other reason
 * still kills the fork and fails the run. Node 26 ships a V8 with the fix, so it gets no
 * flag. Remove this once CI's Node 24 includes the backport.
 */
export function testWorkerExecArgv(nodeVersion: string = process.versions.node): string[] {
	return nodeVersion.split(".")[0] === "24" ? ["--no-wasm-code-gc"] : [];
}
