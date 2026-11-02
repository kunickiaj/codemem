import { Buffer } from "node:buffer";
import { expect, it, vi } from "vitest";
import {
	decodeTraversalSignalBody,
	decodeTraversalSignalPacket,
	encodeTraversalSignalBody,
	encodeTraversalSignalPacket,
	TRAVERSAL_SIGNAL_DESCRIPTION_BODY_BYTES,
	TRAVERSAL_SIGNAL_MAX_DESCRIPTION_BYTES,
	TRAVERSAL_SIGNAL_PATH_SUFFIX,
	TRAVERSAL_SIGNAL_SMALL_BODY_BYTES,
	type TraversalSignalBody,
	TraversalSignalFormatError,
	type TraversalSignalPhase,
} from "./peer-traversal-signal-codec.js";

const common = {
	authorityId: "a".repeat(64),
	groupId: "group",
	sourceDeviceId: "source",
	sourceKeyId: "b".repeat(64),
	targetDeviceId: "target",
	targetKeyId: "c".repeat(64),
	sessionId: "d".repeat(32),
	messageADigest: "e".repeat(64),
	createdAt: 100,
	admitBefore: 130,
	attemptNotAfter: 155,
};
const prepareDigest = "f".repeat(64);
const offerDigest = "1".repeat(64);
const answerDigest = "2".repeat(64);
const nonce = "3".repeat(32);
const phases: TraversalSignalPhase[] = [
	"prepare",
	"offer",
	"offer-check",
	"answer",
	"answer-check",
];
const bodies: { [P in TraversalSignalPhase]: Extract<TraversalSignalBody, { phase: P }> } = {
	prepare: { ...common, phase: "prepare" },
	offer: { ...common, phase: "offer", prepareDigest, descriptionBytes: Uint8Array.of(120) },
	"offer-check": { ...common, phase: "offer-check", prepareDigest, offerDigest },
	answer: {
		...common,
		phase: "answer",
		prepareDigest,
		offerDigest,
		descriptionBytes: Uint8Array.of(120),
	},
	"answer-check": { ...common, phase: "answer-check", prepareDigest, offerDigest, answerDigest },
};
// Independent wire oracle: literal field positions and suffixes, never codec output.
const commonWire = [
	"a".repeat(64),
	"group",
	"source",
	"b".repeat(64),
	"target",
	"c".repeat(64),
	"d".repeat(32),
	"e".repeat(64),
	100,
	130,
	155,
];
const vectors: Record<TraversalSignalPhase, unknown[]> = {
	prepare: ["codemem-traversal-webrtc-prepare-v1", ...commonWire],
	offer: ["codemem-traversal-webrtc-offer-v1", ...commonWire, "f".repeat(64), "eA"],
	"offer-check": [
		"codemem-traversal-webrtc-offer-check-v1",
		...commonWire,
		"f".repeat(64),
		"1".repeat(64),
	],
	answer: [
		"codemem-traversal-webrtc-answer-v1",
		...commonWire,
		"f".repeat(64),
		"1".repeat(64),
		"eA",
	],
	"answer-check": [
		"codemem-traversal-webrtc-answer-check-v1",
		...commonWire,
		"f".repeat(64),
		"1".repeat(64),
		"2".repeat(64),
	],
};
const raw = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");
const wire = (phase: TraversalSignalPhase): Buffer => raw(vectors[phase]);
const source = (value: unknown): TraversalSignalBody => value as TraversalSignalBody;
function packet(phase: TraversalSignalPhase = "prepare") {
	return {
		body: wire(phase).toString("base64url"),
		timestamp: "100",
		nonce,
		signature: `v2:${Buffer.alloc(64).toString("base64")}`,
	};
}
function capture(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
}
function expectFormat(error: unknown): void {
	expect(error).toBeInstanceOf(TraversalSignalFormatError);
	expect(error).toMatchObject({
		name: "TraversalSignalFormatError",
		message: "Invalid traversal signal format",
	});
	if (error instanceof Error) expect(error.cause).toBeUndefined();
}

it("pins transport path and independent byte limits", () => {
	const result = [
		TRAVERSAL_SIGNAL_PATH_SUFFIX,
		TRAVERSAL_SIGNAL_SMALL_BODY_BYTES,
		TRAVERSAL_SIGNAL_DESCRIPTION_BODY_BYTES,
		TRAVERSAL_SIGNAL_MAX_DESCRIPTION_BYTES,
	];
	expect(result).toEqual(["/v1/traversal/signal", 1024, 24576, 16384]);
});
it.each(phases)("encodes and decodes exact %s array bytes and mailbox envelope", (phase) => {
	// Arrange: a zero signature is syntactically valid, never proof of authentication.
	const expected = wire(phase);
	const envelope = packet(phase);
	const encoded = encodeTraversalSignalBody(bodies[phase]);
	const decoded = decodeTraversalSignalBody(expected);
	const portable = encodeTraversalSignalPacket({
		bodyBytes: expected,
		timestamp: "100",
		nonce,
		signatureBytes: Buffer.alloc(64),
	});
	const unpacked = decodeTraversalSignalPacket(envelope);
	// Assert: raw HTTP uses the array, the object is only a portable envelope.
	expect(Buffer.from(encoded)).toEqual(expected);
	expect(decoded).toEqual(bodies[phase]);
	expect(portable).toEqual(envelope);
	expect(Buffer.from(unpacked.bodyBytes)).toEqual(expected);
	expect(unpacked).toMatchObject({
		value: bodies[phase],
		timestamp: "100",
		nonce,
		signatureBytes: new Uint8Array(64),
	});
});
it.each(phases)(
	"rejects missing and extra %s array fields and inherited source fields",
	(phase) => {
		const fields = vectors[phase];
		const errors = [fields.slice(0, -1), [...fields, "extra"]].map((value) =>
			capture(() => decodeTraversalSignalBody(raw(value))),
		);
		const missing = Object.keys(bodies[phase]).flatMap((key) => {
			const body: Record<string, unknown> = { ...bodies[phase] };
			const inherited = Object.assign(Object.create({ [key]: body[key] }), body);
			delete body[key];
			delete inherited[key];
			return [body, inherited];
		});
		errors.push(...missing.map((body) => capture(() => encodeTraversalSignalBody(source(body)))));
		for (const error of errors) expectFormat(error);
	},
);
it("rejects non-object source bodies and portable packets", () => {
	const inputs = [null, undefined, false, 1, "private-payload", []];
	const errors = inputs.flatMap((value) => [
		capture(() => encodeTraversalSignalBody(source(value))),
		capture(() => decodeTraversalSignalPacket(value)),
	]);
	for (const error of errors) expectFormat(error);
});
it.each(phases)("preserves %s endpoint/key/time mapping without signer inference", (phase) => {
	// Arrange: later phases retain an earlier deadline, with no monotonic clock rule.
	const createdAt = phase === "prepare" ? 0 : 200;
	const attemptNotAfter = phase === "prepare" ? 55 : 155;
	const body = {
		...bodies[phase],
		sourceDeviceId: "A",
		targetDeviceId: "Z",
		createdAt,
		admitBefore: createdAt + 30,
		attemptNotAfter,
	};
	const result = decodeTraversalSignalBody(encodeTraversalSignalBody(body));
	expect(result).toEqual(body);
});

it.each(["offer", "offer-check", "answer", "answer-check"] as const)(
	"requires a positive carried deadline for %s without checking freshness",
	(phase) => {
		// Later phases retain the attempt deadline rather than deriving it from createdAt.
		const body = { ...bodies[phase], attemptNotAfter: 1 };
		const fields = [...vectors[phase]];
		fields[11] = 1;
		const expected = raw(fields);
		const encoded = encodeTraversalSignalBody(body);
		const decoded = decodeTraversalSignalBody(expected);
		fields[11] = 0;
		const errors = [
			capture(() => encodeTraversalSignalBody({ ...body, attemptNotAfter: 0 })),
			capture(() => decodeTraversalSignalBody(raw(fields))),
		];
		expect(Buffer.from(encoded)).toEqual(expected);
		expect(decoded).toEqual(body);
		for (const error of errors) expectFormat(error);
	},
);

const validFields: [keyof typeof common, unknown][] = [
	["groupId", "a"],
	["groupId", "é".repeat(64)],
	["groupId", "😀".repeat(32)],
	["groupId", "a b"],
	["sourceDeviceId", "!"],
	["targetDeviceId", "~".repeat(64)],
	["createdAt", 0],
	["createdAt", Math.floor(Number.MAX_SAFE_INTEGER / 1000) - 55],
];
it.each(validFields)("accepts field boundary %s=%s", (key, value) => {
	const body = { ...bodies.prepare, [key]: value };
	if (key === "createdAt")
		Object.assign(body, { admitBefore: Number(value) + 30, attemptNotAfter: Number(value) + 55 });
	const result = decodeTraversalSignalBody(encodeTraversalSignalBody(body));
	expect(result).toEqual(body);
});
const invalidFields: [string, number, unknown[]][] = [
	[
		"authorityId",
		1,
		[
			null,
			1,
			"a".repeat(63),
			"a".repeat(65),
			"A".repeat(64),
			"g".repeat(64),
			`${"a".repeat(64)}\n`,
		],
	],
	[
		"groupId",
		2,
		[
			null,
			"",
			"a".repeat(129),
			`${"é".repeat(64)}a`,
			" a",
			"a ",
			"a\n",
			"a\0b",
			"a\x1fb",
			"a\x7fb",
			"\ud800",
			"\udfff",
		],
	],
	["sourceDeviceId", 3, [null, "", "a".repeat(65), "a b", "é", "a\x7f", "a\n", "target"]],
	["sourceKeyId", 4, [false, "b".repeat(63), "b".repeat(65), "B".repeat(64)]],
	["targetDeviceId", 5, [0, "", "b".repeat(65), " source", "source", "\x20", "\x7f"]],
	["targetKeyId", 6, [null, "c".repeat(63), "c".repeat(65), "C".repeat(64)]],
	["sessionId", 7, [null, "d".repeat(31), "d".repeat(33), "D".repeat(32), "z".repeat(32)]],
	["messageADigest", 8, [null, "e".repeat(63), "e".repeat(65), "E".repeat(64)]],
	[
		"createdAt",
		9,
		["100", -1, 0.5, Number.MAX_SAFE_INTEGER, Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1],
	],
	["admitBefore", 10, [null, 129, 131, -1, 130.5, Number.MAX_SAFE_INTEGER]],
	["attemptNotAfter", 11, [null, 0, 154, 156, -1, 155.5, Number.MAX_SAFE_INTEGER]],
];
it.each(invalidFields)("rejects invalid %s through both body APIs", (key, index, values) => {
	const errors = values.flatMap((value) => {
		const fields = [...vectors.prepare];
		fields[index] = value;
		return [
			capture(() => encodeTraversalSignalBody(source({ ...bodies.prepare, [key]: value }))),
			capture(() => decodeTraversalSignalBody(raw(fields))),
		];
	});
	for (const error of errors) expectFormat(error);
});
it.each([NaN, Infinity, -Infinity, undefined])(
	"rejects non-JSON numeric source %s",
	(createdAt) => {
		const error = capture(() =>
			encodeTraversalSignalBody(source({ ...bodies.prepare, createdAt })),
		);
		expectFormat(error);
	},
);
it.each(["offer", "offer-check", "answer", "answer-check"] as const)(
	"validates every %s digest suffix",
	(phase) => {
		const errors = ["prepareDigest", "offerDigest", "answerDigest"]
			.filter((key) => key in bodies[phase])
			.flatMap((key) =>
				[null, "a".repeat(63), "a".repeat(65), "A".repeat(64)].flatMap((value) => {
					const index = { prepareDigest: 12, offerDigest: 13, answerDigest: 14 }[key];
					const fields = [...vectors[phase]];
					fields[index ?? 0] = value;
					return [
						capture(() => encodeTraversalSignalBody(source({ ...bodies[phase], [key]: value }))),
						capture(() => decodeTraversalSignalBody(raw(fields))),
					];
				}),
			);
		for (const error of errors) expectFormat(error);
	},
);
it.each(["PREPARE", "constructor", "toString", "", null, 1, "prepare-v2"])(
	"rejects phase and purpose alias %s",
	(phase) => {
		const fields = [...vectors.prepare];
		fields[0] = `codemem-traversal-webrtc-${phase}-v1`;
		const errors = [
			capture(() => encodeTraversalSignalBody(source({ ...bodies.prepare, phase }))),
			capture(() => decodeTraversalSignalBody(raw(fields))),
		];
		for (const error of errors) expectFormat(error);
	},
);
it.each([
	"prepare",
	"xodemem-traversal-webrtc-prepare-v1",
	"codemem-traversal-webrtc-prepare-v2",
	null,
	1,
])("requires exact purpose %s", (purpose) => {
	const fields = [...vectors.prepare];
	fields[0] = purpose;
	const error = capture(() => decodeTraversalSignalBody(raw(fields)));
	expectFormat(error);
});

it.each(["offer", "answer"] as const)(
	"accepts opaque %s UTF-8, BOM and description boundaries",
	(phase) => {
		// Arrange: no SDP parsing or candidate approval occurs here.
		const descriptions = [
			Buffer.from("x"),
			Buffer.from("not SDP\r\né"),
			Buffer.from([239, 187, 191, 120]),
			Buffer.alloc(16384, 120),
		];
		const results = descriptions.map((descriptionBytes) =>
			decodeTraversalSignalBody(encodeTraversalSignalBody({ ...bodies[phase], descriptionBytes })),
		);
		results.forEach((result, index) => {
			expect("descriptionBytes" in result && Buffer.from(result.descriptionBytes)).toEqual(
				descriptions[index],
			);
		});
	},
);
it.each(["offer", "answer"] as const)(
	"rejects invalid %s description bytes on encode and decode",
	(phase) => {
		const descriptions = [
			Buffer.alloc(0),
			Buffer.alloc(16385, 120),
			Buffer.from([0]),
			Buffer.from([120, 0, 121]),
			Buffer.from([0xc0, 0xaf]),
			Buffer.from([0xed, 0xa0, 0x80]),
			Buffer.from([0xe2, 0x82]),
		];
		const errors = descriptions.flatMap((descriptionBytes) => {
			const fields = [...vectors[phase]];
			fields[fields.length - 1] = descriptionBytes.toString("base64url");
			return [
				capture(() => encodeTraversalSignalBody({ ...bodies[phase], descriptionBytes })),
				capture(() => decodeTraversalSignalBody(raw(fields))),
			];
		});
		for (const error of errors) expectFormat(error);
	},
);
it.each(["", "eA==", "eA=", "eB", "+w", "/w", "e A", "a", null, 1])(
	"rejects noncanonical description base64url %s",
	(text) => {
		const fields = [...vectors.offer];
		fields[13] = text;
		const error = capture(() => decodeTraversalSignalBody(raw(fields)));
		expectFormat(error);
	},
);
it.each([1024, 1025])("enforces aggregate small-body cap at %i bytes", (size) => {
	// Arrange: every field is individually valid. Escaped ASCII expands JSON bytes.
	const groupId = "g".repeat(1081 - size) + '"'.repeat(size - 953);
	const body = {
		...bodies["answer-check"],
		groupId,
		sourceDeviceId: '"'.repeat(64),
		targetDeviceId: "\\".repeat(64),
	};
	const fields = [...vectors["answer-check"]];
	fields[2] = groupId;
	fields[3] = body.sourceDeviceId;
	fields[5] = body.targetDeviceId;
	const bytes = raw(fields);
	const encoded = capture(() => encodeTraversalSignalBody(body));
	const decoded = capture(() => decodeTraversalSignalBody(bytes));
	expect(bytes.length).toBe(size);
	if (size === 1025) {
		expectFormat(encoded);
		expectFormat(decoded);
	} else {
		expect(encoded).toBeUndefined();
		expect(decoded).toBeUndefined();
	}
});
it.each([24576, 24577])("checks raw global limit before parsing %i bytes", (size) => {
	// Arrange: exact-cap padding is noncanonical, not a claimed valid body vector.
	const bytes = Buffer.alloc(size, 32);
	wire("prepare").copy(bytes);
	const parse = vi.spyOn(JSON, "parse");
	let error: unknown;
	let calls = 0;
	try {
		error = capture(() => decodeTraversalSignalBody(bytes));
		calls = parse.mock.calls.length;
	} finally {
		parse.mockRestore();
	}
	expectFormat(error);
	expect(calls).toBe(size === 24577 ? 0 : 1);
});
it.each([
	(text: string) => ` ${text}`,
	(text: string) => `${text}\n`,
	(text: string) => `\ufeff${text}`,
	(text: string) => text.replace('"group"', '"gr\\u006fup"'),
	(text: string) => text.replace(",100,", ",100.0,"),
	(text: string) => text.replace(",100,", ",1e2,"),
	() =>
		JSON.stringify([vectors.prepare[0], ...commonWire.slice(0, 8), -0, 30, 55]).replace(
			",0,30",
			",-0,30",
		),
	() => "null",
	() => "{}",
	() => "[]",
	() => JSON.stringify(packet()),
	() => JSON.stringify([vectors.prepare[0], ...commonWire.slice().reverse()]),
])("rejects noncanonical or wrong-shaped JSON %#", (transform) => {
	const bytes = Buffer.from(transform(wire("prepare").toString()));
	const error = capture(() => decodeTraversalSignalBody(bytes));
	expectFormat(error);
});
it("rejects invalid UTF-8 even where replacement decoding would produce a valid group", () => {
	const bytes = Buffer.from(wire("prepare"));
	bytes[bytes.indexOf("group")] = 0xff;
	const error = capture(() => decodeTraversalSignalBody(bytes));
	expectFormat(error);
});

it.each(["body", "timestamp", "nonce", "signature"])("requires own packet %s", (key) => {
	const inherited = Object.assign(
		Object.create({ [key]: packet()[key as keyof ReturnType<typeof packet>] }),
		packet(),
	);
	delete inherited[key];
	const error = capture(() => decodeTraversalSignalPacket(inherited));
	expectFormat(error);
});
it.each(["extra", Symbol("extra")])("rejects unknown packet/source key %s", (key) => {
	const errors = [
		capture(() => decodeTraversalSignalPacket({ ...packet(), [key]: "private-input" })),
		capture(() => encodeTraversalSignalBody(source({ ...bodies.prepare, [key]: "private-input" }))),
	];
	for (const error of errors) expectFormat(error);
});
it.each(["0100", "+100", "100.0", "1e2", "101", " 100", 100, null])(
	"rejects timestamp %s in both packet APIs",
	(timestamp) => {
		const errors = [
			capture(() => decodeTraversalSignalPacket({ ...packet(), timestamp })),
			capture(() =>
				encodeTraversalSignalPacket({
					bodyBytes: wire("prepare"),
					timestamp: timestamp as string,
					nonce,
					signatureBytes: new Uint8Array(64),
				}),
			),
		];
		for (const error of errors) expectFormat(error);
	},
);
it.each(["3".repeat(31), "3".repeat(33), "A".repeat(32), "g".repeat(32), null, 3])(
	"rejects nonce %s in both packet APIs",
	(badNonce) => {
		const errors = [
			capture(() => decodeTraversalSignalPacket({ ...packet(), nonce: badNonce })),
			capture(() =>
				encodeTraversalSignalPacket({
					bodyBytes: wire("prepare"),
					timestamp: "100",
					nonce: badNonce as string,
					signatureBytes: new Uint8Array(64),
				}),
			),
		];
		for (const error of errors) expectFormat(error);
	},
);
it.each([
	`v1:${Buffer.alloc(64).toString("base64")}`,
	`v2:${Buffer.alloc(64, 255).toString("base64url")}`,
	`v2:${"A".repeat(85)}B==`,
	`v2:${Buffer.alloc(63).toString("base64")}`,
	`v2:${Buffer.alloc(65).toString("base64")}`,
	`v2:${"A".repeat(86)}`,
	null,
	1,
])("rejects signature syntax %# without verification", (signature) => {
	const error = capture(() => decodeTraversalSignalPacket({ ...packet(), signature }));
	expectFormat(error);
});
it.each(["", "Zg==", "Zg=", "Zh", "a", "+w", "/w", " Zg", null, 1])(
	"rejects malformed packet body %s",
	(body) => {
		const error = capture(() => decodeTraversalSignalPacket({ ...packet(), body }));
		expectFormat(error);
	},
);
it("rejects encoded body overflow before base64 decoding", () => {
	const oversized = { ...packet(), body: "A".repeat(32769) };
	const decode = vi.spyOn(globalThis, "atob");
	let error: unknown;
	let calls = 0;
	try {
		error = capture(() => decodeTraversalSignalPacket(oversized));
		calls = decode.mock.calls.length;
	} finally {
		decode.mockRestore();
	}
	expectFormat(error);
	expect(calls).toBe(0);
});
it("preserves ordinary signature alphabet with canonical padding", () => {
	const signatureBytes = Buffer.alloc(64, 251);
	signatureBytes[1] = 255;
	const envelope = encodeTraversalSignalPacket({
		bodyBytes: wire("prepare"),
		timestamp: "100",
		nonce,
		signatureBytes,
	});
	const decoded = decodeTraversalSignalPacket(envelope);
	expect(envelope.signature).toBe(`v2:${signatureBytes.toString("base64")}`);
	expect(envelope.signature).toContain("+");
	expect(envelope.signature).toContain("/");
	expect(Buffer.from(decoded.signatureBytes)).toEqual(signatureBytes);
});
it.each([0, 63, 65])("rejects %i-byte signature source", (length) => {
	const error = capture(() =>
		encodeTraversalSignalPacket({
			bodyBytes: wire("prepare"),
			timestamp: "100",
			nonce,
			signatureBytes: new Uint8Array(length),
		}),
	);
	expectFormat(error);
});

const invalidBytes = [
	() => null,
	() => [],
	() => new ArrayBuffer(4),
	() => new DataView(new ArrayBuffer(4)),
	() => new Uint16Array(4),
	() => Object.create(Uint8Array.prototype),
	() => new Proxy(Uint8Array.of(120), {}),
	() => {
		const bytes = Uint8Array.of(120);
		structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
		return bytes;
	},
];
it.each(invalidBytes)("rejects non-byte or detached inputs at all byte boundaries %#", (make) => {
	const bad = make() as Uint8Array;
	const errors = [
		capture(() => decodeTraversalSignalBody(bad)),
		capture(() => encodeTraversalSignalBody({ ...bodies.offer, descriptionBytes: bad })),
		capture(() =>
			encodeTraversalSignalPacket({
				bodyBytes: bad,
				timestamp: "100",
				nonce,
				signatureBytes: new Uint8Array(64),
			}),
		),
		capture(() =>
			encodeTraversalSignalPacket({
				bodyBytes: wire("prepare"),
				timestamp: "100",
				nonce,
				signatureBytes: bad,
			}),
		),
	];
	for (const error of errors) expectFormat(error);
});
it.each(["Uint8Array", "Buffer"])("owns nonzero-offset %s input and output bytes", (kind) => {
	const bytes = wire("offer");
	const backing = Buffer.alloc(bytes.length + 4, 99);
	bytes.copy(backing, 2);
	const view =
		kind === "Buffer"
			? backing.subarray(2, -2)
			: new Uint8Array(backing.buffer, backing.byteOffset + 2, bytes.length);
	const description = Buffer.from([99, 120, 99]).subarray(1, 2);
	const signature = Buffer.alloc(66, 255).subarray(1, 65);
	const encoded = encodeTraversalSignalBody({ ...bodies.offer, descriptionBytes: description });
	const envelope = encodeTraversalSignalPacket({
		bodyBytes: view,
		timestamp: "100",
		nonce,
		signatureBytes: signature,
	});
	const decoded = decodeTraversalSignalPacket(envelope);
	const separate = decodeTraversalSignalPacket(envelope);
	const body = decodeTraversalSignalBody(view);
	view.fill(0);
	description.fill(0);
	signature.fill(0);
	decoded.bodyBytes.fill(0);
	decoded.signatureBytes.fill(0);
	if ("descriptionBytes" in decoded.value) decoded.value.descriptionBytes.fill(0);
	expect(Buffer.from(encoded)).toEqual(bytes);
	expect(envelope.body).toBe(bytes.toString("base64url"));
	expect(envelope.signature).toBe(`v2:${Buffer.alloc(64, 255).toString("base64")}`);
	expect(Buffer.from(separate.bodyBytes)).toEqual(bytes);
	expect(separate.signatureBytes).toEqual(new Uint8Array(64).fill(255));
	expect(body).toEqual(bodies.offer);
	expect(separate.value).toEqual(bodies.offer);
});
it("ignores shadowed typed-array metadata, constructor, iterator and species", () => {
	class HostileBytes extends Uint8Array {
		static get [Symbol.species](): Uint8ArrayConstructor {
			throw new Error("private-species");
		}
	}
	const make = (bytes: Uint8Array) => {
		const value = new HostileBytes(bytes);
		for (const key of ["length", "byteLength", "constructor", Symbol.iterator])
			Object.defineProperty(value, key, {
				get() {
					throw new Error("private-metadata");
				},
			});
		return value;
	};
	const bodyBytes = make(wire("offer"));
	const signatureBytes = make(new Uint8Array(64));
	const descriptionBytes = make(Uint8Array.of(120));
	const body = decodeTraversalSignalBody(bodyBytes);
	const encoded = encodeTraversalSignalBody({ ...bodies.offer, descriptionBytes });
	const envelope = encodeTraversalSignalPacket({
		bodyBytes,
		timestamp: "100",
		nonce,
		signatureBytes,
	});
	expect(body).toEqual(bodies.offer);
	expect(Buffer.from(encoded)).toEqual(wire("offer"));
	expect(envelope).toEqual(packet("offer"));
	expect(Object.getPrototypeOf(encoded)).toBe(Uint8Array.prototype);
});
it("uses actual byte sizes despite shadowed short lengths", () => {
	const bodyBytes = new Uint8Array(24577);
	const descriptionBytes = new Uint8Array(16385);
	const signatureBytes = new Uint8Array(65);
	for (const bytes of [bodyBytes, descriptionBytes, signatureBytes]) {
		Object.defineProperty(bytes, "byteLength", { value: 1 });
		Object.defineProperty(bytes, "length", { value: 1 });
	}
	const errors = [
		capture(() => decodeTraversalSignalBody(bodyBytes)),
		capture(() => encodeTraversalSignalBody({ ...bodies.offer, descriptionBytes })),
		capture(() =>
			encodeTraversalSignalPacket({
				bodyBytes: wire("prepare"),
				timestamp: "100",
				nonce,
				signatureBytes,
			}),
		),
	];
	for (const error of errors) expectFormat(error);
});
it("normalizes thrown input getters without exposing their message", () => {
	const body = {
		...bodies.prepare,
		get authorityId(): string {
			throw new Error("private-payload");
		},
	};
	const envelope = {
		...packet(),
		get signature(): string {
			throw new Error("private-payload");
		},
	};
	const errors = [
		capture(() => encodeTraversalSignalBody(body)),
		capture(() => decodeTraversalSignalPacket(envelope)),
	];
	for (const error of errors) expectFormat(error);
});
