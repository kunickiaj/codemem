import { generateKeyPairSync } from "node:crypto";
import { Duplex } from "node:stream";
import type { RelayNoiseLocalIdentity } from "./relay-noise-identity.js";

export function disposableNoiseIdentity(): RelayNoiseLocalIdentity {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const x = publicKey.export({ format: "jwk" }).x;
	if (x === undefined) throw new Error("Missing disposable public key");
	const field = (bytes: Buffer): Buffer => {
		const size = Buffer.alloc(4);
		size.writeUInt32BE(bytes.length);
		return Buffer.concat([size, bytes]);
	};
	const blob = Buffer.concat([
		field(Buffer.from("ssh-ed25519")),
		field(Buffer.from(x, "base64url")),
	]);
	return { key: privateKey, expectedPin: `ssh-ed25519 ${blob.toString("base64")}` };
}

/** Ordered in-memory transport. EOF and destruction propagate independently of data writes. */
export function orderedNoisePair(segmentBytes = 4096) {
	const frames: [Buffer[], Buffer[]] = [[], []];
	const control = { transform: (_direction: number, bytes: Buffer): Buffer => bytes };
	const make = (direction: 0 | 1, peer: () => Duplex): Duplex => {
		const stream = new Duplex({
			allowHalfOpen: true,
			read() {},
			write(chunk: Buffer, _encoding, callback) {
				frames[direction].push(Buffer.from(chunk));
				const bytes = control.transform(direction, Buffer.from(chunk));
				queueMicrotask(() => {
					if (peer().destroyed) return callback(new Error("Fixture peer closed"));
					for (let offset = 0; offset < bytes.length; offset += segmentBytes) {
						peer().push(bytes.subarray(offset, offset + segmentBytes));
					}
					callback();
				});
			},
			final(callback) {
				queueMicrotask(() => {
					if (!peer().destroyed) peer().push(null);
					callback();
				});
			},
			destroy(error, callback) {
				queueMicrotask(() => peer().destroy(error ?? undefined));
				callback(error);
			},
		});
		stream.on("error", () => {});
		return stream;
	};
	const left = make(0, () => right);
	const right = make(1, () => left);
	return { raw: [left, right] as const, frames, control };
}

export function readNoiseBytes(stream: Duplex, size: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let length = 0;
		const cleanup = (): void => {
			stream.off("data", data);
			stream.off("error", failed);
			stream.off("close", closed);
		};
		const failed = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const closed = (): void => failed(new Error("Fixture stream closed before expected bytes"));
		const data = (chunk: Buffer): void => {
			chunks.push(chunk);
			length += chunk.length;
			if (length < size) return;
			cleanup();
			resolve(Buffer.concat(chunks));
		};
		stream.on("data", data);
		stream.once("error", failed);
		stream.once("close", closed);
	});
}

export function writeNoiseBytes(stream: Duplex, bytes: Uint8Array | string): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(bytes, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export function streamEvent(stream: Duplex, name: "end" | "close" | "finish"): Promise<void> {
	return new Promise((resolve) => stream.once(name, resolve));
}
