// Freeze JavaScript Date in the harness, Viewer, and CLI; SQLite's clock is unchanged.

import { readFileSync } from "node:fs";
import { mock } from "node:test";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/automatic-recall-pre-policy.json", import.meta.url)),
);
mock.timers.enable({ apis: ["Date"], now: new Date(fixture.clock).getTime() });
