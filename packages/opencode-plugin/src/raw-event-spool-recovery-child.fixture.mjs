import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceUrl = new URL("../.opencode/lib/raw-event-spool.js", import.meta.url);
const [homeDir, receipt, mode, eventId] = process.argv.slice(2);

function barrier(type) {
	return new Promise((done) => {
		process.once("message", done);
		process.send({ type });
	});
}

async function main() {
	if (mode === "pid-holder") {
		await barrier("ready");
		process.disconnect();
		return;
	}
	let spool;
	if (mode === "after-ack" || mode === "retain-hold") {
		// Hold exactly at selected unlink, after the callback returned its acknowledgement.
		globalThis.recoveryTestBeforeUnlink = () => barrier("before-unlink");
		globalThis.recoveryTestBeforeRetainRead = () => barrier("retain-locked");
		const source = (await readFile(sourceUrl, "utf8"))
			.replace(/\brm,/, "rm as originalRm,")
			.replace(/\bopen,/, "open as originalOpen,")
			.replace(/from\s+["'](\.\.?\/[^"']+)["']/g, (_match, relative) =>
				`from ${JSON.stringify(pathToFileURL(resolve(dirname(fileURLToPath(sourceUrl)), relative)).href)}`)
			.concat(`\nconst rm = async (path, ...args) => {
				if (String(path).endsWith(${JSON.stringify(receipt)})) await globalThis.recoveryTestBeforeUnlink();
				return originalRm(path, ...args);
			};
			const open = async (path, ...args) => {
				if (${JSON.stringify(mode)} === "retain-hold" && String(path).endsWith(${JSON.stringify(`${receipt.split("-")[1]}.json`)})) {
					await globalThis.recoveryTestBeforeRetainRead();
				}
				return originalOpen(path, ...args);
			};\n`);
		spool = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
	} else {
		spool = await import(sourceUrl.href);
	}
	let result;
	if (mode === "retain" || mode === "retain-hold") {
		result = await spool.retainRejectedRawEventSpoolEntry({
			homeDir, eventId,
			status: mode === "retain-hold" ? 400 : 413,
			reason: mode === "retain-hold" ? "invalid_payload" : "payload_too_large",
		});
	} else {
		result = await spool.recoverRejectedRawEventSpoolEntry({
			homeDir, receipt,
			deliver: async ({ serialized }) => {
				if (mode === "hold") await barrier("before-delivery");
				process.send({ type: "delivered", serialized });
				return { acknowledged: true, acknowledgement: "queued" };
			},
		});
	}
	process.send({ type: "result", result }, () => process.disconnect());
}

main().catch((error) => {
	process.send({ type: "result", error: { code: error.code, name: error.name } }, () => process.disconnect());
});
