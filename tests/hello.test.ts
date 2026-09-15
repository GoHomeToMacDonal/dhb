import { describe, expect, it } from "vitest";
import { createCommand } from "../src/commands/hello.ts";
import { createSink } from "./helpers.ts";

describe("hello command", () => {
  it("greets the world by default", async () => {
    const out = createSink();
    const err = createSink();
    const command = createCommand({ writeOut: out.write, writeErr: err.write });

    await command.parseAsync([], { from: "user" });

    expect(out.text()).toBe("Hello, world!\n");
    expect(err.text()).toBe("");
  });

  it("greets a named argument", async () => {
    const out = createSink();
    const command = createCommand({ writeOut: out.write, writeErr: () => {} });

    await command.parseAsync(["Kiro"], { from: "user" });

    expect(out.text()).toBe("Hello, Kiro!\n");
  });

  it("shouts when --upper is passed", async () => {
    const out = createSink();
    const command = createCommand({ writeOut: out.write, writeErr: () => {} });

    await command.parseAsync(["Kiro", "--upper"], { from: "user" });

    expect(out.text()).toBe("HELLO, KIRO!\n");
  });

  it("is named hello and has a description", () => {
    const command = createCommand({ writeOut: () => {}, writeErr: () => {} });
    expect(command.name()).toBe("hello");
    expect(command.description()).toContain("greeting");
  });
});
