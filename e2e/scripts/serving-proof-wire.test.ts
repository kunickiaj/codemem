import assert from "node:assert/strict";
import { test } from "node:test";
import { observeCanaries } from "./serving-proof-wire.js";

test("distinguishes body IDs in both directions from metadata and longer tokens", () => {
	const a = "memory-source-v1:QQ:10000000-0000-4000-a000-000000000001";
	const b = "memory-source-v1:Qg:20000000-0000-4000-a000-000000000002";
	const prefix = "offline-proof-synthetic-body:";
	const request = JSON.stringify({
		id: b,
		payload_json: JSON.stringify({ body_text: prefix + a }),
		extra: prefix + b + "-tail",
	});
	assert.deepEqual(observeCanaries(request, "sender-to-receiver"), [
		{ direction: "sender-to-receiver", id: a },
	]);
	assert.deepEqual(
		observeCanaries(JSON.stringify([prefix + b, prefix + a]), "receiver-to-sender"),
		[
			{ direction: "receiver-to-sender", id: b },
			{ direction: "receiver-to-sender", id: a },
		],
	);
});
