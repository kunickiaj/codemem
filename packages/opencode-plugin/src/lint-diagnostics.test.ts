import { describe, expect, it } from "vitest";
import { getScopeIdentity } from "./lint-diagnostics.js";

describe("Command factory callback identities", () => {
	it("distinguishes identical action callbacks by their enclosing command factory", () => {
		// Arrange: repeated callback names must not merge unrelated command warnings.
		const source = [
			"export function createFirstCommand(): Command {",
			"  addDbOption(new Command()).action(async () => {",
			"    return;",
			"  });",
			"}",
			"export function createSecondCommand(): Command {",
			"  addDbOption(new Command()).action(async () => {",
			"    return;",
			"  });",
			"}",
		].join("\n");
		// Act
		const identities = [getScopeIdentity(source, 2), getScopeIdentity(source, 7)];
		// Assert
		expect(identities).toEqual([
			":method:addDbOption:factory:createFirstCommand",
			":method:addDbOption:factory:createSecondCommand",
		]);
	});

	it.each([
		"  if (ready) { const value = { nested: {} }; }",
		'  const text = "} function createFakeCommand(): Command {";',
		"  const text = '} function createFakeCommand(): Command {';",
		"  const text = `} function createFakeCommand(): Command {`;",
		"  // } function createFakeCommand(): Command {",
		"  /* } function createFakeCommand(): Command { */",
	])("keeps the factory active after nested syntax or inert text: %s", (body) => {
		// Arrange
		const source = [
			"export function createRealCommand(): Command {",
			body,
			"  addDbOption(new Command()).action(() => {",
			"    return;",
			"  });",
			"}",
		].join("\n");
		// Act
		const identity = getScopeIdentity(source, 3);
		// Assert
		expect(identity).toBe(":method:addDbOption:factory:createRealCommand");
	});

	it("ends factory qualification at the closing brace after nested callbacks", () => {
		// Arrange: an earlier factory must not own a later top-level callback.
		const source = [
			"export function createRealCommand(): Command {",
			"  addDbOption(new Command()).action(() => {",
			"    if (ready) { run(); }",
			"  });",
			"}",
			"register(() => {",
			"  run();",
			"});",
		].join("\n");
		// Act
		const identity = getScopeIdentity(source, 6);
		// Assert
		expect(identity).toBe(":method:register");
	});

	it.each([
		"  /}/.test(input);",
		"  /{/.test(input);",
		String.raw`  /\//.test(input); /}/.test(input);`,
		"  /[}/]/.test(input);",
		"  /[{/]/.test(input);",
		"  if (ready) /}/.test(input);",
		"  /* /{ } */ /}/.test(input); // {",
		["  const text = `raw } $", "{(() => { return `nested $", "{/}/.test(input)}`; })()}`;"].join(
			"",
		),
		"  const ratio = total / divisor; if (ready) { run(); }",
		"  const ratio = total / (ready ? 2 : 1) / divisor;",
	])("keeps regex, template and division syntax from changing factory ownership: %s", (body) => {
		// Arrange: inert braces must neither close a factory early nor extend it past its body.
		const source = [
			"export function createRealCommand(): Command {",
			body,
			"  addDbOption(new Command()).action(() => {",
			"    run();",
			"  });",
			"}",
			"register(() => {",
			"  run();",
			"});",
		].join("\n");
		// Act
		const identities = [getScopeIdentity(source, 3), getScopeIdentity(source, 7)];
		// Assert
		expect(identities).toEqual([
			":method:addDbOption:factory:createRealCommand",
			":method:register",
		]);
	});
});

describe("Command factory identities across TypeScript and JSX syntax", () => {
	it.each([
		"const id = <T>(value: T): T => value;",
		"const value = <string>input;",
		"const view = <section>{input}</section>;",
		"const id = <T,>(value: T): T => value; const view = <section />;",
	])("preserves factory ownership after valid TypeScript or JSX: %s", (prelude) => {
		// Arrange: file syntax outside the factory must not change callback ownership.
		const source = [
			prelude,
			"function createRealCommand(): Command {",
			"  addDbOption(new Command()).action(() => {",
			"    run();",
			"  });",
			"}",
		].join("\n");
		// Act
		const identity = getScopeIdentity(source, 3);
		// Assert
		expect(identity).toBe(":method:addDbOption:factory:createRealCommand");
	});

	it("preserves the conservative fallback when neither TypeScript nor JSX parses", () => {
		// Arrange: malformed surrounding syntax must not invent a factory owner.
		const source = [
			"const broken = ;",
			"function createRealCommand(): Command {",
			"  addDbOption(new Command()).action(() => {",
			"    run();",
			"  });",
			"}",
		].join("\n");
		// Act
		const identity = getScopeIdentity(source, 3);
		// Assert
		expect(identity).toBe(":method:addDbOption");
	});
});

describe("Command factory identity fallbacks", () => {
	it.each([
		"function buildCommand(): Command {",
		"function createRealCommand(options: Options): Command {",
		"function createRealCommand() {",
		"function createRealCommand(): Other {",
		"const createRealCommand = (): Command => {",
	])("preserves fallback identities in unrecognized factory shapes: %s", (declaration) => {
		// Arrange
		const source = `${declaration}\n  addDbOption(new Command()).action(() => {\n  });\n}`;
		// Act
		const identity = getScopeIdentity(source, 2);
		// Assert
		expect(identity).toBe(":method:addDbOption");
	});

	it("preserves named bindings and route handlers inside recognized factories", () => {
		// Arrange: factory qualification applies only to the method fallback.
		const source = [
			"function createRealCommand(): Command {",
			"  const handler = () => {",
			"  };",
			'  app.get("/status", () => {',
			"  });",
			"}",
		].join("\n");
		// Act
		const identities = [getScopeIdentity(source, 2), getScopeIdentity(source, 4)];
		// Assert
		expect(identities).toEqual([":binding:handler", "route:app.get:/status:handler"]);
	});
});
