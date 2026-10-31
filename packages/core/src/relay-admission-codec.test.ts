import { describe, expect, it } from "vitest";
import {
	decodeRelayAdmissionBody,
	decodeRelayCheckPacket,
	decodeRelayRegistrationBody,
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
	getRelayAdmissionRemainingMs,
	getRelayAdmissionTimeBudget,
	type RelayAdmissionBody,
	RelayAdmissionFormatError,
	type RelayRegistrationBody,
} from "./relay-admission-codec.js";

const AUTHORITY = "a".repeat(64);
const SOURCE_KEY = "b".repeat(64);
const TARGET_KEY = "c".repeat(64);
const AUDIENCE = "d".repeat(64);
const SESSION = "e".repeat(32);
const DIGEST = "f".repeat(64);
const NONCE = "0123456789abcdef".repeat(2);

function admission(overrides: Partial<RelayAdmissionBody> = {}): RelayAdmissionBody {
	return {
		role: "relay",
		authorityId: AUTHORITY,
		groupId: "test-group",
		sourceDeviceId: "source",
		sourceKeyId: SOURCE_KEY,
		targetDeviceId: "target",
		targetKeyId: TARGET_KEY,
		relayAudienceId: AUDIENCE,
		routeSessionId: SESSION,
		messageADigest: DIGEST,
		createdAt: 100,
		admitBefore: 130,
		routeNotAfter: 155,
		...overrides,
	};
}

function registration(overrides: Partial<RelayRegistrationBody> = {}): RelayRegistrationBody {
	return {
		authorityId: AUTHORITY,
		groupId: "test-group",
		deviceId: "source",
		keyId: SOURCE_KEY,
		relayAudienceId: AUDIENCE,
		socketChallengeId: SESSION,
		createdAt: 100,
		admitBefore: 130,
		...overrides,
	};
}

function admissionArray(body = admission()): unknown[] {
	return [
		"codemem-relay-admission-check-v1",
		body.role,
		body.authorityId,
		body.groupId,
		body.sourceDeviceId,
		body.sourceKeyId,
		body.targetDeviceId,
		body.targetKeyId,
		body.relayAudienceId,
		body.routeSessionId,
		body.messageADigest,
		body.createdAt,
		body.admitBefore,
		body.routeNotAfter,
	];
}

function registrationArray(body = registration()): unknown[] {
	return [
		"codemem-relay-register-v1",
		body.authorityId,
		body.groupId,
		body.deviceId,
		body.keyId,
		body.relayAudienceId,
		body.socketChallengeId,
		body.createdAt,
		body.admitBefore,
	];
}

function jsonBytes(value: unknown): Buffer {
	return Buffer.from(JSON.stringify(value), "utf8");
}

// Synthetic bytes exercise signature syntax only. They make no cryptographic-validity claim.
function signatureBytes(): Buffer {
	return Buffer.from(Array.from({ length: 64 }, (_, index) => index));
}

function packet(bodyBytes: Uint8Array = jsonBytes(admissionArray())) {
	return {
		body: Buffer.from(bodyBytes).toString("base64url"),
		timestamp: "100",
		nonce: NONCE,
		signature: `v2:${signatureBytes().toString("base64")}`,
	};
}

describe("relay admission exact body codecs", () => {
	it.each(["source", "relay", "responder"] as const)(
		"encodes and decodes the exact fourteen-field %s vector",
		(role) => {
			// Arrange
			const body = admission({ role });
			const expected = jsonBytes(admissionArray(body));
			// Act
			const encoded = encodeRelayAdmissionBody(body);
			const decoded = decodeRelayAdmissionBody(expected);
			// Assert
			expect(Buffer.from(encoded)).toEqual(expected);
			expect(decoded).toEqual(body);
			expect(JSON.parse(Buffer.from(encoded).toString())).toHaveLength(14);
		},
	);

	it("encodes and decodes the exact nine-field registration vector", () => {
		// Arrange
		const body = registration();
		const expected = jsonBytes(registrationArray(body));
		// Act
		const encoded = encodeRelayRegistrationBody(body);
		const decoded = decodeRelayRegistrationBody(expected);
		// Assert
		expect(Buffer.from(encoded)).toEqual(expected);
		expect(decoded).toEqual(body);
		expect(JSON.parse(Buffer.from(encoded).toString())).toHaveLength(9);
	});

	it.each(["é", "e\u0301", "組😀", "a b", "a".repeat(128), "😀".repeat(32)])(
		"preserves valid group scalars and UTF-8 limits: %j",
		(groupId) => {
			// Arrange
			const body = admission({ groupId });
			const registered = registration({ groupId });
			// Act
			const admissionResult = decodeRelayAdmissionBody(encodeRelayAdmissionBody(body));
			const registrationResult = decodeRelayRegistrationBody(
				encodeRelayRegistrationBody(registered),
			);
			// Assert
			expect(admissionResult.groupId).toBe(groupId);
			expect(registrationResult.groupId).toBe(groupId);
		},
	);

	it.each(["!", "~", '\\"', "X".repeat(64)])("accepts visible ASCII device ID %j", (deviceId) => {
		// Arrange
		const body = admission({ sourceDeviceId: deviceId });
		const registered = registration({ deviceId });
		// Act
		const decoded = decodeRelayAdmissionBody(encodeRelayAdmissionBody(body));
		const decodedRegistration = decodeRelayRegistrationBody(
			encodeRelayRegistrationBody(registered),
		);
		// Assert
		expect(decoded.sourceDeviceId).toBe(deviceId);
		expect(decodedRegistration.deviceId).toBe(deviceId);
	});

	it.each([0, 9_999_999_999])("accepts the createdAt endpoint %i", (createdAt) => {
		// Arrange
		const times = { createdAt, admitBefore: createdAt + 30 };
		const body = admission({ ...times, routeNotAfter: createdAt + 55 });
		const registered = registration(times);
		// Act
		const decoded = decodeRelayAdmissionBody(encodeRelayAdmissionBody(body));
		const decodedRegistration = decodeRelayRegistrationBody(
			encodeRelayRegistrationBody(registered),
		);
		// Assert
		expect(decoded).toEqual(body);
		expect(decodedRegistration).toEqual(registered);
	});
});

describe("relay body byte limits and identifier validation", () => {
	it("keeps maximally escaped legal bodies under the raw 1024-byte cap", () => {
		// Arrange
		const body = admission({
			groupId: '"'.repeat(128),
			sourceDeviceId: "\\".repeat(64),
			targetDeviceId: '"'.repeat(64),
			createdAt: 9_999_999_999,
			admitBefore: 10_000_000_029,
			routeNotAfter: 10_000_000_054,
		});
		const registered = registration({ groupId: body.groupId, deviceId: body.sourceDeviceId });
		// Act
		const bytes = encodeRelayAdmissionBody(body);
		const registrationBytes = encodeRelayRegistrationBody(registered);
		// Assert
		expect(bytes.byteLength).toBeLessThanOrEqual(1024);
		expect(registrationBytes.byteLength).toBeLessThanOrEqual(1024);
		expect(decodeRelayAdmissionBody(bytes)).toEqual(body);
		expect(decodeRelayRegistrationBody(registrationBytes)).toEqual(registered);
	});

	it("reads only the selected Node Buffer view, including nonzero byte offsets", () => {
		// Arrange
		const expected = jsonBytes(admissionArray());
		const backing = Buffer.concat([Buffer.from("garbage"), expected, Buffer.from("trailer")]);
		const view = backing.subarray(7, 7 + expected.length);
		// Act
		const decoded = decodeRelayAdmissionBody(view);
		// Assert
		expect(decoded).toEqual(admission());
	});

	const invalidGroups = [
		"",
		"a".repeat(129),
		"😀".repeat(33),
		"\u0000",
		"a\nb",
		"a\u001fb",
		"a\u007fb",
		" group",
		"group ",
		"\u00a0group",
		"group\u2003",
		"\ud800",
		"\udc00",
	];
	it.each(invalidGroups)("rejects invalid group %j on both encode and decode", (groupId) => {
		// Arrange
		const body = admission({ groupId });
		const registered = registration({ groupId });
		// Act
		const operations = [
			() => encodeRelayAdmissionBody(body),
			() => decodeRelayAdmissionBody(jsonBytes(admissionArray(body))),
			() => encodeRelayRegistrationBody(registered),
			() => decodeRelayRegistrationBody(jsonBytes(registrationArray(registered))),
		];
		// Assert
		for (const operation of operations) expect(operation).toThrow(RelayAdmissionFormatError);
	});

	it.each(["", "x".repeat(65), "a b", "a\tb", "a\nb", "\u007f", "é", "😀", "\ud800"])(
		"rejects invalid device ID %j everywhere",
		(deviceId) => {
			// Arrange
			const source = admission({ sourceDeviceId: deviceId });
			const target = admission({ targetDeviceId: deviceId });
			const registered = registration({ deviceId });
			// Act
			const operations = [
				() => encodeRelayAdmissionBody(source),
				() => decodeRelayAdmissionBody(jsonBytes(admissionArray(source))),
				() => encodeRelayAdmissionBody(target),
				() => decodeRelayAdmissionBody(jsonBytes(admissionArray(target))),
				() => encodeRelayRegistrationBody(registered),
				() => decodeRelayRegistrationBody(jsonBytes(registrationArray(registered))),
			];
			// Assert
			for (const operation of operations) expect(operation).toThrow(RelayAdmissionFormatError);
		},
	);
});

describe("relay body fields and fixed intervals", () => {
	const badAdmissionFields: [string, unknown][] = [
		["role", "registration"],
		["role", "Relay"],
		["authorityId", "A".repeat(64)],
		["sourceKeyId", "b".repeat(63)],
		["targetKeyId", "c".repeat(65)],
		["relayAudienceId", "g".repeat(64)],
		["messageADigest", "F".repeat(64)],
		["routeSessionId", "E".repeat(32)],
		["routeSessionId", "e".repeat(31)],
		["sourceDeviceId", "target"],
		["createdAt", -1],
		["createdAt", 10_000_000_000],
		["createdAt", 100.5],
		["createdAt", Number.MAX_SAFE_INTEGER + 1],
		["createdAt", "100"],
		["admitBefore", 129],
		["admitBefore", 131],
		["admitBefore", 130.5],
		["routeNotAfter", 154],
		["routeNotAfter", 156],
		["routeNotAfter", 155.5],
		["extra", true],
	];
	it.each(badAdmissionFields)("rejects invalid admission %s=%j", (field, value) => {
		// Arrange
		const body = { ...admission(), [field]: value } as RelayAdmissionBody;
		// Act
		const encode = () => encodeRelayAdmissionBody(body);
		const decode = () => decodeRelayAdmissionBody(jsonBytes(admissionArray(body)));
		// Assert
		expect(encode).toThrow(RelayAdmissionFormatError);
		if (field !== "extra") expect(decode).toThrow(RelayAdmissionFormatError);
	});

	const badRegistrationFields: [string, unknown][] = [
		["authorityId", "A".repeat(64)],
		["keyId", "b".repeat(63)],
		["relayAudienceId", "g".repeat(64)],
		["socketChallengeId", "E".repeat(32)],
		["socketChallengeId", "e".repeat(33)],
		["createdAt", -1],
		["createdAt", 10_000_000_000],
		["createdAt", 100.5],
		["createdAt", Number.MAX_SAFE_INTEGER + 1],
		["createdAt", "100"],
		["admitBefore", 129],
		["admitBefore", 131],
		["admitBefore", 130.5],
		["extra", true],
	];
	it.each(badRegistrationFields)("rejects invalid registration %s=%j", (field, value) => {
		// Arrange
		const body = { ...registration(), [field]: value } as RelayRegistrationBody;
		// Act
		const encode = () => encodeRelayRegistrationBody(body);
		const decode = () => decodeRelayRegistrationBody(jsonBytes(registrationArray(body)));
		// Assert
		expect(encode).toThrow(RelayAdmissionFormatError);
		if (field !== "extra") expect(decode).toThrow(RelayAdmissionFormatError);
	});
});

describe("relay body canonical JSON and UTF-8", () => {
	it.each([null, true, 1, {}, []])("rejects scalar or object wire body %j", (value) => {
		// Arrange
		const bytes = jsonBytes(value);
		// Act
		const decodeAdmission = () => decodeRelayAdmissionBody(bytes);
		const decodeRegistration = () => decodeRelayRegistrationBody(bytes);
		// Assert
		expect(decodeAdmission).toThrow(RelayAdmissionFormatError);
		expect(decodeRegistration).toThrow(RelayAdmissionFormatError);
	});

	it.each(["admission", "registration"] as const)(
		"rejects wrong count, purpose, order, and every wrong field type for %s",
		(kind) => {
			// Arrange
			const vector = kind === "admission" ? admissionArray() : registrationArray();
			const decode = kind === "admission" ? decodeRelayAdmissionBody : decodeRelayRegistrationBody;
			const reordered = [...vector];
			[reordered[1], reordered[2]] = [reordered[2], reordered[1]];
			const malformed: unknown[][] = [
				vector.slice(0, -1),
				[...vector, "extra"],
				["wrong-purpose", ...vector.slice(1)],
				reordered,
			];
			for (let index = 0; index < vector.length; index++) {
				for (const value of [
					null,
					false,
					{},
					[],
					typeof vector[index] === "number" ? "100" : 100,
				]) {
					const wrongType = [...vector];
					wrongType[index] = value;
					malformed.push(wrongType);
				}
			}
			// Act
			const operations = malformed.map((value) => () => decode(jsonBytes(value)));
			// Assert
			for (const operation of operations) expect(operation).toThrow(RelayAdmissionFormatError);
		},
	);

	it.each(["admission", "registration"] as const)(
		"rejects noncanonical JSON and malformed UTF-8 for %s",
		(kind) => {
			// Arrange
			const vector = kind === "admission" ? admissionArray() : registrationArray();
			const decode = kind === "admission" ? decodeRelayAdmissionBody : decodeRelayRegistrationBody;
			const canonical = JSON.stringify(vector);
			const variants = [
				Buffer.from(` ${canonical}`),
				Buffer.from(`${canonical}\n`),
				Buffer.from(canonical.replaceAll(",", ", ")),
				Buffer.from(canonical.replace("test-group", "test\\u002dgroup")),
				Buffer.from(canonical.replace(",100,", ",1e2,")),
				Buffer.from(canonical.replace(",100,", ",100.0,")),
				Buffer.from(canonical.replace("test-group", "test\\/group")),
				Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]),
				Buffer.from(canonical.replace("test-group", "test-�group")).map((byte, index, bytes) =>
					index > 0 && bytes[index - 1] === 0xef ? 0xff : byte,
				),
				Buffer.from(canonical.slice(0, -1)),
				Buffer.alloc(1025, 32),
				Buffer.from(canonical.replace("test-group", "x".repeat(1025))),
			];
			// Act
			const operations = variants.map((bytes) => () => decode(bytes));
			// Assert
			for (const operation of operations) expect(operation).toThrow(RelayAdmissionFormatError);
		},
	);

	it("rejects negative-zero JSON instead of silently canonicalizing its numeric value", () => {
		// Arrange
		const body = admission({ createdAt: 0, admitBefore: 30, routeNotAfter: 55 });
		const bytes = Buffer.from(
			JSON.stringify(admissionArray(body)).replace(",0,30,55]", ",-0,30,55]"),
		);
		// Act
		const decode = () => decodeRelayAdmissionBody(bytes);
		// Assert
		expect(decode).toThrow(RelayAdmissionFormatError);
	});
});

describe("relay check packet format only", () => {
	it.each(["admission", "registration"] as const)(
		"tags %s and preserves the exact original UTF-8 bytes",
		(kind) => {
			// Arrange
			const value =
				kind === "admission"
					? admission({ groupId: "e\u0301" })
					: registration({ groupId: "e\u0301" });
			const bytes =
				kind === "admission"
					? jsonBytes(admissionArray(value as RelayAdmissionBody))
					: jsonBytes(registrationArray(value as RelayRegistrationBody));
			// Act
			const encoded = encodeRelayCheckPacket({
				bodyBytes: bytes,
				timestamp: "100",
				nonce: NONCE,
				signatureBytes: signatureBytes(),
			});
			const decoded = decodeRelayCheckPacket(encoded);
			// Assert
			expect(encoded).toEqual(packet(bytes));
			expect(Object.keys(encoded).sort()).toEqual(["body", "nonce", "signature", "timestamp"]);
			expect(encoded.signature).toHaveLength(91);
			expect(decoded.kind).toBe(kind);
			expect(decoded.value).toEqual(value);
			expect(decoded.timestamp).toBe("100");
			expect(decoded.nonce).toBe(NONCE);
			expect(Buffer.from(decoded.bodyBytes)).toEqual(bytes);
			expect(Buffer.from(decoded.signatureBytes)).toEqual(signatureBytes());
		},
	);

	it("copies decoded bytes and encodes only the input Buffer view", () => {
		// Arrange
		const bytes = jsonBytes(admissionArray());
		const backing = Buffer.concat([Buffer.from("ignored"), bytes, Buffer.from("ignored")]);
		const view = backing.subarray(7, 7 + bytes.length);
		const signatureBacking = Buffer.concat([
			Buffer.from([255]),
			signatureBytes(),
			Buffer.from([255]),
		]);
		const encoded = encodeRelayCheckPacket({
			bodyBytes: view,
			timestamp: "100",
			nonce: NONCE,
			signatureBytes: signatureBacking.subarray(1, 65),
		});
		const first = decodeRelayCheckPacket(encoded);
		const second = decodeRelayCheckPacket(encoded);
		// Act
		view.fill(0);
		signatureBacking.fill(0);
		first.bodyBytes.fill(0);
		first.signatureBytes.fill(0);
		// Assert
		expect(encoded).toEqual(packet(bytes));
		expect(Buffer.from(second.bodyBytes)).toEqual(bytes);
		expect(Buffer.from(second.signatureBytes)).toEqual(signatureBytes());
	});
});

describe("relay check packet invalid fields", () => {
	const invalidPacketFields: [string, unknown][] = [
		["extra", true],
		["body", ""],
		["body", "!!!!"],
		["body", "AA=="],
		["body", Buffer.alloc(1025).toString("base64url")],
		["timestamp", "0100"],
		["timestamp", "+100"],
		["timestamp", "100.0"],
		["timestamp", "1e2"],
		["timestamp", "100 "],
		["timestamp", "101"],
		["timestamp", 100],
		["nonce", "A".repeat(32)],
		["nonce", "a".repeat(31)],
		["nonce", "a".repeat(33)],
		["nonce", "g".repeat(32)],
		["nonce", null],
		["signature", `v1:${signatureBytes().toString("base64")}`],
		["signature", signatureBytes().toString("base64")],
		["signature", `v2:${Buffer.alloc(63).toString("base64")}`],
		["signature", `v2:${Buffer.alloc(65).toString("base64")}`],
		["signature", `v2:${signatureBytes().toString("base64").slice(0, -2)}`],
		["signature", `v2:${signatureBytes().toString("base64")}=`],
		["signature", `v2:${signatureBytes().toString("base64").slice(0, -3)}x==`],
		["signature", `v2:${signatureBytes().toString("base64").replace("+", "-")}`],
		["signature", "v2:!!!!"],
	];
	it.each(invalidPacketFields)("rejects packet field %s=%j", (field, value) => {
		// Arrange
		const input = { ...packet(), [field]: value };
		// Act
		const decode = () => decodeRelayCheckPacket(input);
		// Assert
		expect(decode).toThrow(RelayAdmissionFormatError);
	});

	it.each(["body", "timestamp", "nonce", "signature"])(
		"rejects missing or non-string %s",
		(field) => {
			// Arrange
			const missing: Record<string, unknown> = { ...packet() };
			delete missing[field];
			const wrongType = { ...packet(), [field]: [] };
			// Act
			const decodeMissing = () => decodeRelayCheckPacket(missing);
			const decodeWrongType = () => decodeRelayCheckPacket(wrongType);
			// Assert
			expect(decodeMissing).toThrow(RelayAdmissionFormatError);
			expect(decodeWrongType).toThrow(RelayAdmissionFormatError);
		},
	);

	it.each([null, [], "packet", 100, true])("rejects a non-object packet %j", (input) => {
		// Arrange
		const value = input;
		// Act
		const decode = () => decodeRelayCheckPacket(value);
		// Assert
		expect(decode).toThrow(RelayAdmissionFormatError);
	});
});

describe("relay packet canonical encoding", () => {
	it("rejects padded, noncanonical pad-bit, and ordinary-base64 body spellings", () => {
		// Arrange
		// Select a valid body whose byte length needs padding, with URL-only alphabet bytes.
		const bytes = jsonBytes(admissionArray(admission({ groupId: "😀x" })));
		const canonical = bytes.toString("base64url");
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const last = alphabet.indexOf(canonical.at(-1) ?? "");
		const invalid = [
			`${canonical}=`,
			canonical.slice(0, -1) + alphabet[last + 1],
			bytes.toString("base64"),
		];
		// Act
		const operations = invalid.map(
			(body) => () => decodeRelayCheckPacket({ ...packet(bytes), body }),
		);
		// Assert
		expect(bytes.length % 3).not.toBe(0);
		for (const operation of operations) expect(operation).toThrow(RelayAdmissionFormatError);
	});

	it.each([31, 63, 65])("rejects encoder signature bytes of length %i", (length) => {
		// Arrange
		const input = {
			bodyBytes: jsonBytes(admissionArray()),
			timestamp: "100",
			nonce: NONCE,
			signatureBytes: Buffer.alloc(length),
		};
		// Act
		const encode = () => encodeRelayCheckPacket(input);
		// Assert
		expect(encode).toThrow(RelayAdmissionFormatError);
	});

	it.each(["timestamp", "nonce", "bodyBytes"])(
		"validates encoder %s instead of producing an invalid packet",
		(field) => {
			// Arrange
			const input = {
				bodyBytes: jsonBytes(admissionArray()),
				timestamp: "100",
				nonce: NONCE,
				signatureBytes: signatureBytes(),
			};
			if (field === "timestamp") input.timestamp = "0100";
			if (field === "nonce") input.nonce = "bad";
			if (field === "bodyBytes") input.bodyBytes = Buffer.from("[]");
			// Act
			const encode = () => encodeRelayCheckPacket(input);
			// Assert
			expect(encode).toThrow(RelayAdmissionFormatError);
		},
	);
});

describe("relay admission injected millisecond decision time", () => {
	it.each([
		[95_000, 60_000],
		[100_000, 55_000],
		[129_999, 25_001],
		[129_998.25, 25_001],
	])("at %f reports exactly %i remaining milliseconds", (decisionNowMs, expected) => {
		// Arrange
		const body = admission();
		// Act
		const remaining = getRelayAdmissionRemainingMs(body, decisionNowMs);
		// Assert
		expect(remaining).toBe(expected);
		expect(Number.isSafeInteger(remaining)).toBe(true);
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(60_000);
	});

	it.each([
		94_999,
		130_000,
		130_000.25,
		155_000,
		156_000,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("denies invalid decision time %f instead of clamping", (decisionNowMs) => {
		// Arrange
		const body = admission();
		// Act
		const decide = () => getRelayAdmissionRemainingMs(body, decisionNowMs);
		// Assert
		expect(decide).toThrow(RelayAdmissionFormatError);
	});

	it("rounds the decision toward the future before checking the exact admission boundary", () => {
		// Arrange
		const body = admission();
		// Act
		const decide = () => getRelayAdmissionRemainingMs(body, 129_999.01);
		// Assert
		expect(decide).toThrow(RelayAdmissionFormatError);
	});

	it("does not add a floored second to the seventy-second clock-error example", () => {
		// Arrange
		const body = admission();
		const targetDecisionMs = 129_999;
		const trueResponderMs = 134_999;
		const earlierSourceMs = 90_000;
		// Act
		const remaining = getRelayAdmissionRemainingMs(body, targetDecisionMs);
		const lifetime = trueResponderMs + remaining - earlierSourceMs;
		// Assert
		expect(remaining).toBe(25_001);
		expect(lifetime).toBe(70_000);
	});

	it("validates fixed intervals even when called with an unencoded object", () => {
		// Arrange
		const bodies = [
			admission({ admitBefore: 131 }),
			admission({ routeNotAfter: 156 }),
			admission({ createdAt: 100.5 }),
			admission({ sourceDeviceId: "target" }),
		];
		// Act
		const operations = bodies.map((body) => () => getRelayAdmissionRemainingMs(body, 100_000));
		// Assert
		for (const operation of operations) expect(operation).toThrow(RelayAdmissionFormatError);
	});
});

describe("relay packet decoder snapshots public accessor inputs", () => {
	it.each(["body", "timestamp", "nonce", "signature"] as const)(
		"reads valid %s once and returns only checked values",
		(field) => {
			// Arrange
			const input = packet();
			const firstValue = input[field];
			let reads = 0;
			Object.defineProperty(input, field, {
				enumerable: true,
				get() {
					reads += 1;
					return reads === 1 ? firstValue : "unchecked-second-value";
				},
			});
			// Act
			const decoded = decodeRelayCheckPacket(input);
			// Assert
			expect(reads).toBe(1);
			expect(decoded.kind).toBe("admission");
			expect(decoded.value).toEqual(admission());
			expect(decoded.timestamp).toBe("100");
			expect(decoded.nonce).toBe(NONCE);
			expect(Buffer.from(decoded.bodyBytes)).toEqual(jsonBytes(admissionArray()));
			expect(Buffer.from(decoded.signatureBytes)).toEqual(signatureBytes());
		},
	);

	it.each(["body", "timestamp", "nonce", "signature"] as const)(
		"rejects the first invalid %s without reading a replacement",
		(field) => {
			// Arrange
			const input = packet();
			const laterValue = input[field];
			let reads = 0;
			Object.defineProperty(input, field, {
				enumerable: true,
				get() {
					reads += 1;
					return reads === 1 ? "invalid-first-value" : laterValue;
				},
			});
			// Act
			const decode = () => decodeRelayCheckPacket(input);
			// Assert
			expect(decode).toThrow(RelayAdmissionFormatError);
			expect(reads).toBe(1);
		},
	);
});

describe("relay packet encoder snapshots public accessor options", () => {
	it.each(["bodyBytes", "timestamp", "nonce", "signatureBytes"] as const)(
		"reads valid %s once before validating and encoding",
		(field) => {
			// Arrange
			const input = {
				bodyBytes: jsonBytes(admissionArray()),
				timestamp: "100",
				nonce: NONCE,
				signatureBytes: signatureBytes(),
			};
			const firstValue = input[field];
			const laterValues = {
				bodyBytes: Buffer.from("[]"),
				timestamp: "unchecked-time",
				nonce: "unchecked-nonce",
				signatureBytes: Buffer.alloc(1),
			};
			let reads = 0;
			Object.defineProperty(input, field, {
				enumerable: true,
				get() {
					reads += 1;
					return reads === 1 ? firstValue : laterValues[field];
				},
			});
			// Act
			const encoded = encodeRelayCheckPacket(input);
			// Assert
			expect(reads).toBe(1);
			expect(encoded).toEqual(packet());
		},
	);

	it.each(["bodyBytes", "timestamp", "nonce", "signatureBytes"] as const)(
		"rejects the first invalid %s without reading valid replacement options",
		(field) => {
			// Arrange
			const input = {
				bodyBytes: jsonBytes(admissionArray()),
				timestamp: "100",
				nonce: NONCE,
				signatureBytes: signatureBytes(),
			};
			const laterValue = input[field];
			const firstValues = {
				bodyBytes: Buffer.from("[]"),
				timestamp: "bad-time",
				nonce: "bad-nonce",
				signatureBytes: Buffer.alloc(1),
			};
			let reads = 0;
			Object.defineProperty(input, field, {
				enumerable: true,
				get() {
					reads += 1;
					return reads === 1 ? firstValues[field] : laterValue;
				},
			});
			// Act
			const encode = () => encodeRelayCheckPacket(input);
			// Assert
			expect(encode).toThrow(RelayAdmissionFormatError);
			expect(reads).toBe(1);
		},
	);
});

describe("relay admission time budget echoes the rounded decision", () => {
	it("returns the same rounded decision used to derive the exact remaining duration", () => {
		// Arrange
		const body = admission();
		// Act
		const budget = getRelayAdmissionTimeBudget(body, 129_998.25);
		const remaining = getRelayAdmissionRemainingMs(body, 129_998.25);
		// Assert
		expect(budget).toEqual({ decidedAtMs: 129_999, remainingMs: 25_001 });
		expect(budget.remainingMs).toBe(body.routeNotAfter * 1000 - budget.decidedAtMs);
		expect(remaining).toBe(budget.remainingMs);
	});

	it.each([
		["budget", getRelayAdmissionTimeBudget],
		["remaining", getRelayAdmissionRemainingMs],
	] as const)("%s rejects a decision rounded onto the admission deadline", (_name, decide) => {
		// Arrange
		const body = admission();
		// Act
		const decision = () => decide(body, 129_999.25);
		// Assert
		expect(decision).toThrow(RelayAdmissionFormatError);
	});

	it("accepts the exact epoch for both time APIs", () => {
		// Arrange
		const body = admission({ createdAt: 0, admitBefore: 30, routeNotAfter: 55 });
		// Act
		const budget = getRelayAdmissionTimeBudget(body, 0);
		const remaining = getRelayAdmissionRemainingMs(body, 0);
		// Assert
		expect(budget).toEqual({ decidedAtMs: 0, remainingMs: 55_000 });
		expect(remaining).toBe(55_000);
	});

	it.each([
		["budget", getRelayAdmissionTimeBudget],
		["remaining", getRelayAdmissionRemainingMs],
	] as const)("%s rejects a decision before the epoch", (_name, decide) => {
		// Arrange
		const body = admission({ createdAt: 0, admitBefore: 30, routeNotAfter: 55 });
		// Act
		const decision = () => decide(body, -1);
		// Assert
		expect(decision).toThrow(RelayAdmissionFormatError);
	});
});

describe("relay admission time helpers validate one body snapshot", () => {
	it.each([
		["budget", getRelayAdmissionTimeBudget],
		["remaining", getRelayAdmissionRemainingMs],
	] as const)(
		"%s rejects the expired first admission window without reading its replacement",
		(_name, decide) => {
			// Arrange
			const body = admission();
			let reads = 0;
			Object.defineProperty(body, "admitBefore", {
				enumerable: true,
				get() {
					reads += 1;
					return reads === 1 ? 130 : 200;
				},
			});
			// Act
			const decision = () => decide(body, 140_000);
			// Assert
			expect(decision).toThrow(RelayAdmissionFormatError);
			expect(reads).toBe(1);
		},
	);

	it.each([
		["budget", getRelayAdmissionTimeBudget],
		["remaining", getRelayAdmissionRemainingMs],
	] as const)(
		"%s calculates from the first valid created, admission, and route times",
		(name, decide) => {
			// Arrange
			const body = admission();
			const reads = { createdAt: 0, admitBefore: 0, routeNotAfter: 0 };
			for (const field of ["createdAt", "admitBefore", "routeNotAfter"] as const) {
				const firstValue = body[field];
				Object.defineProperty(body, field, {
					enumerable: true,
					get() {
						reads[field] += 1;
						return reads[field] === 1 ? firstValue : firstValue + 100;
					},
				});
			}
			// Act
			const result = decide(body, 100_000);
			// Assert
			expect(reads).toEqual({ createdAt: 1, admitBefore: 1, routeNotAfter: 1 });
			if (name === "budget") {
				expect(result).toEqual({ decidedAtMs: 100_000, remainingMs: 55_000 });
			} else {
				expect(result).toBe(55_000);
			}
		},
	);
});
