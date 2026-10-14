import Database from "better-sqlite3";
import {
	type CoordinatorDeviceLocalEvidence,
	readCoordinatorDeviceLocalEvidence,
} from "./coordinator-device-local.js";
import { buildAuthHeaders, verifySignature } from "./sync-auth.js";

function signerError(): Error {
	return new Error("Account-link device unavailable.");
}

/** Read existing public evidence without migrations, identity creation, or DB maintenance. */
export function readAccountLinkDevice(dbPath: string): CoordinatorDeviceLocalEvidence {
	try {
		if (typeof dbPath !== "string" || !dbPath || dbPath === ":memory:") throw signerError();
		const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
		try {
			const device = readCoordinatorDeviceLocalEvidence(db);
			if (!device) throw signerError();
			return device;
		} finally {
			db.close();
		}
	} catch {
		throw signerError();
	}
}

export function signAccountLinkRequest(options: {
	dbPath: string;
	device: CoordinatorDeviceLocalEvidence;
	keysDir?: string;
	method: string;
	url: string;
	bodyBytes: Buffer;
}) {
	const { device, method, url, bodyBytes } = options;
	try {
		const current = readAccountLinkDevice(options.dbPath);
		if (
			current.deviceId !== device.deviceId ||
			current.publicKey !== device.publicKey ||
			current.fingerprint !== device.fingerprint
		)
			throw signerError();
		// Never pass dbPath: the existing key loader would invoke connect() maintenance.
		const headers = buildAuthHeaders({
			method,
			url,
			bodyBytes,
			deviceId: device.deviceId,
			keysDir: options.keysDir,
		});
		const parsed = new URL(url);
		if (
			!verifySignature({
				method,
				pathWithQuery: `${parsed.pathname}${parsed.search}`,
				bodyBytes,
				deviceId: device.deviceId,
				publicKey: device.publicKey,
				timestamp: headers["X-Opencode-Timestamp"],
				nonce: headers["X-Opencode-Nonce"],
				signature: headers["X-Opencode-Signature"],
			})
		)
			throw signerError();
		return headers;
	} catch {
		throw signerError();
	}
}
