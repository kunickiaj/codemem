// RFC 8032 section 7.1, test 1: public test vector, never an enrolled device key.
export const RAW_PUBLIC_KEY_HEX =
	"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
export const CANONICAL_BASE64 =
	"AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea";
export const CANONICAL_PUBLIC_KEY = `ssh-ed25519 ${CANONICAL_BASE64}`;
// Independently computed with Node createHash and checked with ssh-keygen over
// the standard SSH blob; OpenSSH SHA256 form: bbXpuKG6zhzdmnxq256TlqzFBzRl2f6OOg722cYNbU8.
export const EXPECTED_KEY_ID = "6db5e9b8a1bace1cdd9a7c6adb9e9396acc5073465d9fe8e3a0ef6d9c60d6d4f";
export const REQUEST_TIME_MS = Date.UTC(2026, 2, 28, 0, 0, 0);
export const REQUEST_TIMESTAMP = String(REQUEST_TIME_MS / 1000);
export const REQUEST_NONCE = "0123456789abcdef0123456789abcdef";
export const REQUEST_METHOD = "POST";
export const REQUEST_PATH = "/v1/presence?fixture=key-id";
export const REQUEST_BODY = '{"status":"online"}';

export function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function wireBytes(options: { innerType?: string; trailing?: number[] } = {}): Uint8Array {
	const type = new TextEncoder().encode(options.innerType ?? "ssh-ed25519");
	const raw = hexBytes(RAW_PUBLIC_KEY_HEX);
	const wire = new Uint8Array(4 + type.length + 4 + raw.length + (options.trailing?.length ?? 0));
	const view = new DataView(wire.buffer);
	view.setUint32(0, type.length);
	wire.set(type, 4);
	view.setUint32(4 + type.length, raw.length);
	wire.set(raw, 8 + type.length);
	wire.set(options.trailing ?? [], 8 + type.length + raw.length);
	return wire;
}

export function publicKeyFromWire(wire: Uint8Array): string {
	return `ssh-ed25519 ${btoa(String.fromCharCode(...wire))}`;
}

const trailingOne = publicKeyFromWire(wireBytes({ trailing: [0] }));
const trailingTwo = publicKeyFromWire(wireBytes({ trailing: [0, 0] }));

// Both existing verifiers skip the inner type and ignore trailing bytes. Freeze
// those accepted identities rather than silently imposing stricter OpenSSH rules.
export const ACCEPTED_ALIASES = [
	{ name: "canonical", publicKey: CANONICAL_PUBLIC_KEY },
	{ name: "comment", publicKey: `${CANONICAL_PUBLIC_KEY} fixture@example.com` },
	{ name: "tabs", publicKey: `ssh-ed25519\t${CANONICAL_BASE64}\tcomment` },
	{ name: "spaces", publicKey: `ssh-ed25519    ${CANONICAL_BASE64}  comment` },
	{
		name: "leading/trailing whitespace and newline",
		publicKey: ` \n${CANONICAL_PUBLIC_KEY}\r\n\t`,
	},
	{
		name: "alternate inner type",
		publicKey: publicKeyFromWire(wireBytes({ innerType: "ssh-rsa" })),
	},
	{ name: "empty inner type", publicKey: publicKeyFromWire(wireBytes({ innerType: "" })) },
	{ name: "one trailing byte", publicKey: trailingOne },
	{ name: "two trailing bytes", publicKey: trailingTwo },
	{ name: "unpadded one trailing byte", publicKey: trailingOne.replace(/=+$/, "") },
	{ name: "unpadded two trailing bytes", publicKey: trailingTwo.replace(/=+$/, "") },
	{ name: "nonzero four padding bits", publicKey: trailingOne.replace(/A==$/, "B==") },
	{ name: "nonzero two padding bits", publicKey: trailingTwo.replace(/A=$/, "B=") },
];

function lengthOverride(offset: number, value: number): string {
	const bytes = wireBytes();
	new DataView(bytes.buffer).setUint32(offset, value);
	return publicKeyFromWire(bytes);
}

export const MALFORMED_KEYS = [
	{ name: "missing data", publicKey: "ssh-ed25519" },
	{ name: "invalid base64", publicKey: "ssh-ed25519 $$$$" },
	{ name: "base64 length modulo four is one", publicKey: "ssh-ed25519 A" },
	{ name: "truncated type length", publicKey: publicKeyFromWire(wireBytes().slice(0, 3)) },
	{ name: "type length overrun", publicKey: lengthOverride(0, 0xffffffff) },
	{ name: "truncated key length", publicKey: publicKeyFromWire(wireBytes().slice(0, 18)) },
	{ name: "wrong key length", publicKey: lengthOverride(15, 31) },
	{ name: "oversized key length", publicKey: lengthOverride(15, 0xffffffff) },
	{ name: "truncated key", publicKey: publicKeyFromWire(wireBytes().slice(0, 50)) },
];

export const NODE_ONLY_ALIASES = [
	{
		name: "URL-safe base64",
		publicKey: CANONICAL_PUBLIC_KEY.replace(/\+/g, "-").replace(/\//g, "_"),
	},
	{ name: "junk stripped by Buffer", publicKey: `ssh-ed25519 !${CANONICAL_BASE64}` },
];

export const OTHER_KEYS = [
	"",
	"pk1",
	"fixture",
	"ssh-rsa AAAA",
	"raw-public-key",
	CANONICAL_BASE64,
];
