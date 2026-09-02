import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "codemem-packed-embedding-runtime-"));

function fail(message, result) {
	if (result?.stdout) process.stderr.write(result.stdout);
	if (result?.stderr) process.stderr.write(result.stderr);
	throw new Error(message);
}

function run(command, args, options = {}) {
	const { cwd = packageRoot, env = process.env, timeoutMs = 300_000 } = options;
	const useWindowsShell =
		process.platform === "win32" && (command === "npm" || command === "pnpm");
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env,
		shell: useWindowsShell,
		timeout: timeoutMs,
	});
	if (result.error) {
		fail(
			`Command failed: ${command} ${args.join(" ")} (${result.error.code ?? result.error.message})`,
			result,
		);
	}
	if (result.status !== 0) {
		fail(
			`Command failed: ${command} ${args.join(" ")} (status ${String(result.status)}, signal ${String(result.signal)})`,
			result,
		);
	}
	return result;
}

try {
	if (
		process.env.CODEMEM_EXPECT_WINDOWS_X64 === "1" &&
		(process.platform !== "win32" || process.arch !== "x64")
	) {
		fail(`Expected win32/x64, received ${process.platform}/${process.arch}`);
	}
	run("pnpm", ["pack", "--pack-destination", tempDir]);
	const tarballs = readdirSync(tempDir).filter((fileName) => fileName.endsWith(".tgz"));
	if (tarballs.length !== 1) fail(`pnpm pack produced ${tarballs.length} runtime tarballs`);
	const tarball = join(tempDir, tarballs[0]);

	const installDir = join(tempDir, "install");
	mkdirSync(installDir, { recursive: true });
	writeFileSync(join(installDir, "package.json"), JSON.stringify({ private: true }), "utf8");
	// The pinned onnxruntime-node package bundles the Windows x64 CPU binding;
	// skip its optional installer download and assert the bundled file below.
	const cpuOnlyEnv = { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" };
	run("npm", ["install", tarball], { cwd: installDir, env: cpuOnlyEnv });

	const ortBinary = join(
		installDir,
		"node_modules",
		"onnxruntime-node",
		"bin",
		"napi-v6",
		process.platform,
		process.arch,
		"onnxruntime_binding.node",
	);
	if (!existsSync(ortBinary)) fail(`Packed install is missing ONNX Runtime at ${ortBinary}`);

	const inferenceProbe = `
		const assert = (condition, message) => {
			if (condition) return;
			console.error(message);
			process.exit(1);
		};
		const { createEmbeddingRuntime } = await import("@codemem/embeddings");
		const client = await createEmbeddingRuntime({
			model: "Xenova/bge-small-en-v1.5",
			revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
		});
		const vectors = await client.embed(["Windows packed runtime probe", "A distinct probe sentence"]);
		assert(vectors.length === 2, "Expected two embedding vectors");
		assert(vectors.every((vector) => vector.length === 384), "Expected 384-dimensional vectors");
		assert(vectors.every((vector) => vector.every(Number.isFinite)), "Embedding contains non-finite values");
		assert(vectors.every((vector) => vector.some((value) => value !== 0)), "Embedding is all zeros");
		assert(vectors[0].some((value, index) => value !== vectors[1][index]), "Distinct inputs produced identical embeddings");
		process.exit(0);
	`;
	run(process.execPath, ["--input-type=module", "--eval", inferenceProbe], {
		cwd: installDir,
		timeoutMs: 600_000,
	});
} finally {
	try {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	} catch {
		// Cleanup must not replace the probe's actionable failure on Windows.
	}
}
