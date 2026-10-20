import type { OwnerEnrollmentStart } from "./owner-enrollment-start.js";

export const OWNER_ADMISSION_BODY_MAX_BYTES = 16 * 1024;
const START_FIELDS = [
	"attemptId",
	"deviceId",
	"publicKey",
	"loopbackRedirect",
	"browserStartCode",
	"signature",
];

/** Dedicated multipart limit. The ordinary browser forms stay at 4 KiB. */
async function readBytes(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^[0-9]{1,10}$/.test(declared) || Number(declared) > OWNER_ADMISSION_BODY_MAX_BYTES)
	)
		return null;
	if (!request.body) return null;
	const reader = request.body.getReader();
	const bytes = new Uint8Array(OWNER_ADMISSION_BODY_MAX_BYTES);
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return bytes.subarray(0, size);
			if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > bytes.length - size) {
				void reader.cancel().catch(() => {});
				return null;
			}
			bytes.set(chunk.value, size);
			size += chunk.value.byteLength;
		}
	} catch {
		void reader.cancel().catch(() => {});
		return null;
	} finally {
		reader.releaseLock();
	}
}

/** The file format is deliberately only two object levels with string leaves.
 * Validate that grammar before JSON.parse so duplicate keys (including escaped aliases)
 * cannot disappear during parsing. No general JSON parser or permissive normalization.
 */
function parseStart(raw: string): OwnerEnrollmentStart | null {
	const string = '"(?:[^"\\\\\u0000-\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
	const pair = `${string}\\s*:\\s*${string}`;
	if (
		!new RegExp(
			`^\\s*\\{\\s*"start"\\s*:\\s*\\{\\s*${pair}(?:\\s*,\\s*${pair})*\\s*\\}\\s*\\}\\s*$`,
		).test(raw)
	)
		return null;
	const fields = new Set<string>();
	for (const match of raw.matchAll(new RegExp(`(${string})\\s*:\\s*${string}`, "g"))) {
		const name: unknown = JSON.parse(match[1] ?? "null");
		if (typeof name !== "string" || !START_FIELDS.includes(name) || fields.has(name)) return null;
		fields.add(name);
	}
	if (fields.size !== START_FIELDS.length) return null;
	return Object.freeze((JSON.parse(raw) as { start: OwnerEnrollmentStart }).start);
}

/** Read the entire bounded body BEFORE invoking the runtime multipart parser. */
export async function readOwnerAdmissionUpload(
	request: Request,
): Promise<{ csrf: string; start: OwnerEnrollmentStart } | null> {
	try {
		const contentType = request.headers.get("content-type") ?? "";
		if (contentType.length > 256 || !/^multipart\/form-data\s*;/i.test(contentType)) return null;
		const bytes = await readBytes(request);
		if (!bytes) return null;
		const form = await new Request(request.url, {
			method: "POST",
			headers: { "Content-Type": contentType },
			body: bytes,
		}).formData();
		const entries = [...form.entries()];
		if (
			entries.length !== 2 ||
			form.getAll("csrf").length !== 1 ||
			form.getAll("request").length !== 1
		)
			return null;
		const csrf = form.get("csrf");
		const file = form.get("request");
		if (typeof csrf !== "string" || !(file instanceof File)) return null;
		const start = parseStart(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()),
		);
		return start ? { csrf, start } : null;
	} catch {
		return null;
	}
}
