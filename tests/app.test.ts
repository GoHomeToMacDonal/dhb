import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram, runCli } from "../src/app.ts";
import { createSink } from "./helpers.ts";

const realCommandsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "commands");

describe("createProgram", () => {
  it("is named dhb and loads the hello command from source", async () => {
    const out = createSink();
    const err = createSink();
    const program = await createProgram({
      writeOut: out.write,
      writeErr: err.write,
      commandsDir: realCommandsDir,
      policy: "strict",
    });

    expect(program.name()).toBe("dhb");
    expect(program.commands.map((c) => c.name())).toContain("hello");
  });
});

describe("runCli", () => {
  it("prints the version and exits 0", async () => {
    const out = createSink();
    const code = await runCli({
      argv: ["node", "dhb", "--version"],
      writeOut: out.write,
      writeErr: () => {},
      commandsDir: realCommandsDir,
      policy: "strict",
    });

    expect(code).toBe(0);
    expect(out.text().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints help and exits 0", async () => {
    const out = createSink();
    const code = await runCli({
      argv: ["node", "dhb", "--help"],
      writeOut: out.write,
      writeErr: () => {},
      commandsDir: realCommandsDir,
      policy: "strict",
    });

    expect(code).toBe(0);
    expect(out.text()).toContain("Usage: dhb");
    expect(out.text()).toContain("hello");
  });

  it("runs the hello command end to end", async () => {
    const out = createSink();
    const code = await runCli({
      argv: ["node", "dhb", "hello", "Kiro"],
      writeOut: out.write,
      writeErr: () => {},
      commandsDir: realCommandsDir,
      policy: "strict",
    });

    expect(code).toBe(0);
    expect(out.text()).toBe("Hello, Kiro!\n");
  });

  it("returns a non-zero code for an unknown command", async () => {
    const err = createSink();
    const code = await runCli({
      argv: ["node", "dhb", "does-not-exist"],
      writeOut: () => {},
      writeErr: err.write,
      commandsDir: realCommandsDir,
      policy: "strict",
    });

    expect(code).not.toBe(0);
  });
});
