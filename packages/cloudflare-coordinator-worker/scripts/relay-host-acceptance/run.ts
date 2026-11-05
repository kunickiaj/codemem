// Relay host acceptance: runs the same device-level stages against the Durable Object
// relay, a Node relay co-hosted with the coordinator, and a standalone Node relay.
// Local only: no network beyond loopback, no Cloudflare account, no deploy.
//
//   pnpm --filter @codemem/cloudflare-coordinator-worker relay:acceptance -- [--host do|node-cohosted|node-standalone|all]
//
// Each host takes about 12 minutes, most of it the five healthy minutes relay
// readiness needs. Keys, certificates and databases go under .tmp/relay-host-acceptance/.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOSTS = ["do", "node-cohosted", "node-standalone"] as const;
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");

function selectedHosts(): string[] {
	const index = process.argv.indexOf("--host");
	const value = index === -1 ? "all" : (process.argv[index + 1] ?? "");
	if (value === "all") return [...HOSTS];
	if (!(HOSTS as readonly string[]).includes(value)) throw new Error(`--host must be one of ${HOSTS.join(", ")}, or all`);
	return [value];
}

/** A throwaway CA and a 127.0.0.1 leaf. RSA works with both OpenSSL and LibreSSL. */
function testCertificates(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const openssl = (args: string[]) =>
		execFileSync(process.env.OPENSSL ?? "openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
	openssl(["req", "-x509", "-sha256", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1",
		"-subj", "/CN=relay-host-acceptance CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
	openssl(["req", "-sha256", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=127.0.0.1"]);
	execFileSync("sh", ["-c", "printf 'subjectAltName=IP:127.0.0.1\\nextendedKeyUsage=serverAuth\\n' > leaf.cnf"], { cwd: dir });
	openssl(["x509", "-req", "-sha256", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
		"-out", "leaf.pem", "-days", "1", "-extfile", "leaf.cnf"]);
}

function runHost(host: string, root: string, tlsDir: string): Promise<boolean> {
	const runDir = join(root, host);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const child = spawn(
		process.execPath,
		[join(repo, "node_modules/tsx/dist/cli.mjs"), "--conditions", "source", join(here, "driver.ts"), host, runDir, tlsDir],
		{ cwd: repo, env: { ...process.env, NODE_EXTRA_CA_CERTS: join(tlsDir, "ca.pem") }, stdio: ["ignore", "inherit", "inherit"] },
	);
	return new Promise((resolve) => child.once("exit", (code) => resolve(code === 0)));
}

const root = join(repo, ".tmp/relay-host-acceptance", new Date().toISOString().replaceAll(":", "-"));
const tlsDir = join(root, "tls");
testCertificates(tlsDir);
const outcomes: Record<string, boolean> = {};
for (const host of selectedHosts()) outcomes[host] = await runHost(host, root, tlsDir);
process.stdout.write(`${JSON.stringify({ stage: "summary", outcomes, evidence: root })}\n`);
process.exit(Object.values(outcomes).every(Boolean) ? 0 : 1);
