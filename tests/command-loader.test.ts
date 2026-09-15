import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  activeExtension,
  discoverCommandFiles,
  isCommandFileName,
  loadCommands,
} from "../src/command-loader.ts";
import type { CommandContext } from "../src/command-module.ts";
import { createSink } from "./helpers.ts";

const context: CommandContext = { writeOut: () => {}, writeErr: () => {} };

describe("isCommandFileName", () => {
  it("accepts a plain .ts command file", () => {
    expect(isCommandFileName("status.ts", ".ts")).toBe(true);
  });

  it("rejects underscore- and dot-prefixed files", () => {
    expect(isCommandFileName("_shared.ts", ".ts")).toBe(false);
    expect(isCommandFileName(".hidden.ts", ".ts")).toBe(false);
  });

  it("rejects reserved type and test suffixes", () => {
    expect(isCommandFileName("status.d.ts", ".ts")).toBe(false);
    expect(isCommandFileName("status.test.ts", ".ts")).toBe(false);
    expect(isCommandFileName("status.spec.ts", ".ts")).toBe(false);
  });

  it("only matches the active extension", () => {
    expect(isCommandFileName("status.js", ".ts")).toBe(false);
    expect(isCommandFileName("status.ts", ".js")).toBe(false);
  });
});

describe("activeExtension", () => {
  it("reports .ts when running from TypeScript source", () => {
    expect(activeExtension()).toBe(".ts");
  });
});

describe("discoverCommandFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dhb-discover-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty list for a missing directory", async () => {
    const files = await discoverCommandFiles({
      commandsDir: join(dir, "does-not-exist"),
      extension: ".ts",
    });
    expect(files).toEqual([]);
  });

  it("returns only valid command files, sorted by name", async () => {
    await writeFile(join(dir, "beta.ts"), "");
    await writeFile(join(dir, "alpha.ts"), "");
    await writeFile(join(dir, "_helper.ts"), "");
    await writeFile(join(dir, "notes.d.ts"), "");
    await writeFile(join(dir, "thing.js"), "");

    const files = await discoverCommandFiles({ commandsDir: dir, extension: ".ts" });

    expect(files.map((f) => f.split("/").pop())).toEqual(["alpha.ts", "beta.ts"]);
  });
});

describe("loadCommands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dhb-load-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fixture(name: string, source: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, source, "utf8");
    return file;
  }

  const goodModule = (cmdName: string) =>
    `import { Command } from "commander";\n` +
    `export function createCommand() {\n` +
    `  return new Command(${JSON.stringify(cmdName)}).description("ok");\n` +
    `}\n`;

  it("registers valid commands on the program", async () => {
    const a = await fixture("a.ts", goodModule("alpha"));
    const b = await fixture("b.ts", goodModule("beta"));
    const program = new Command();

    await loadCommands([a, b], { program, context, policy: "strict" });

    expect(program.commands.map((c) => c.name()).sort()).toEqual(["alpha", "beta"]);
  });

  it("throws under strict policy for a module without createCommand", async () => {
    const bad = await fixture("bad.ts", `export const nope = true;\n`);
    const program = new Command();

    await expect(loadCommands([bad], { program, context, policy: "strict" })).rejects.toThrow(
      /does not export createCommand/,
    );
  });

  it("throws under strict policy when createCommand throws", async () => {
    const bad = await fixture(
      "boom.ts",
      `export function createCommand() { throw new Error("kaboom"); }\n`,
    );
    const program = new Command();

    await expect(loadCommands([bad], { program, context, policy: "strict" })).rejects.toThrow(
      /kaboom/,
    );
  });

  it("throws under strict policy on a duplicate command name", async () => {
    const a = await fixture("a.ts", goodModule("dup"));
    const b = await fixture("b.ts", goodModule("dup"));
    const program = new Command();

    await expect(loadCommands([a, b], { program, context, policy: "strict" })).rejects.toThrow(
      /duplicate command name "dup"/,
    );
  });

  it("warns and skips bad modules under warn policy, keeping good ones", async () => {
    const good = await fixture("good.ts", goodModule("keep"));
    const bad = await fixture("bad.ts", `export const nope = true;\n`);
    const err = createSink();
    const program = new Command();

    await loadCommands([bad, good], {
      program,
      context,
      policy: "warn",
      writeErr: err.write,
    });

    expect(program.commands.map((c) => c.name())).toEqual(["keep"]);
    expect(err.text()).toContain("skipping command module");
    expect(err.text()).toContain("does not export createCommand");
  });
});
