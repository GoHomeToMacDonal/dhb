import type { Command } from "commander";

/**
 * Minimal surface a command module is allowed to use for output. Commands
 * receive this instead of reaching for the global program or `process`
 * streams directly, which keeps them testable and decoupled from the root.
 */
export interface CommandContext {
  /** Write a chunk to the program's configured stdout stream. */
  writeOut(text: string): void;
  /** Write a chunk to the program's configured stderr stream. */
  writeErr(text: string): void;
}

/**
 * The contract every file in `src/commands` must satisfy: a named export
 * `createCommand` that builds and returns a Commander {@link Command}.
 */
export interface CommandModule {
  createCommand(context: CommandContext): Command;
}

/**
 * Structural type guard for {@link CommandModule}. The command loader uses this
 * to reject files that do not expose a `createCommand` function before it tries
 * to build a command from them.
 */
export function isCommandModule(value: unknown): value is CommandModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "createCommand" in value &&
    typeof (value as { createCommand: unknown }).createCommand === "function"
  );
}
