import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { type CommandContext, isCommandModule } from "./command-module.ts";

/**
 * How the loader reacts when a command file is malformed (missing
 * `createCommand`, throws while building, produces a duplicate/empty name,
 * etc.).
 *
 * - `strict`: throw immediately. Used when running from TypeScript source,
 *   where a broken module is a developer error that should fail loudly.
 * - `warn`: write a diagnostic to stderr and skip the file. Used for the built
 *   `.js` artifacts, where a single bad plugin file should not take down the
 *   whole CLI for an end user.
 */
export type LoadPolicy = "strict" | "warn";

/** Names that are never treated as command modules during discovery. */
const RESERVED_SUFFIXES = [".d.ts", ".spec.ts", ".test.ts", ".d.js", ".spec.js", ".test.js"];

export interface DiscoverOptions {
  /** Absolute path to the directory that holds command modules. */
  commandsDir: string;
  /** File extension to load, chosen from the running artifact kind. */
  extension: ".ts" | ".js";
}

export interface LoadOptions {
  /** The root program the discovered commands are attached to. */
  program: Command;
  /** Shared context handed to each command's `createCommand`. */
  context: CommandContext;
  /** Behavior on malformed modules. */
  policy: LoadPolicy;
  /** Sink for `warn`-policy diagnostics. Defaults to `process.stderr`. */
  writeErr?: (text: string) => void;
}

/**
 * Decide whether a directory entry name is a candidate command module.
 *
 * Ignored: dotfiles, underscore-prefixed files (private helpers), reserved
 * type/test suffixes, and anything that does not end in the active extension.
 */
export function isCommandFileName(name: string, extension: ".ts" | ".js"): boolean {
  if (name.startsWith(".") || name.startsWith("_")) {
    return false;
  }
  if (RESERVED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return false;
  }
  return name.endsWith(extension);
}

/**
 * Choose which extension to discover based on where this module is running
 * from: `.ts` under `src/` (dev/tsx/strip-types), `.js` under `dist/` (build).
 */
export function activeExtension(): ".ts" | ".js" {
  return fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js";
}

/** Absolute path to the `commands` directory next to this loader. */
export function defaultCommandsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "commands");
}

/**
 * Scan {@link DiscoverOptions.commandsDir} for command modules and return their
 * absolute paths, sorted by file name for deterministic registration order.
 * Only regular files that pass {@link isCommandFileName} are returned.
 */
export async function discoverCommandFiles(options: DiscoverOptions): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(options.commandsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => isCommandFileName(name, options.extension))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((name) => join(options.commandsDir, name));
}

function fail(policy: LoadPolicy, writeErr: (text: string) => void, message: string): void {
  if (policy === "strict") {
    throw new Error(message);
  }
  writeErr(`dhb: skipping command module: ${message}\n`);
}

/**
 * Dynamically import each discovered file, validate it exposes a usable
 * `createCommand`, build the command, verify it has a unique non-empty name,
 * and attach it to the root program. Behavior on malformed modules is governed
 * by {@link LoadOptions.policy}.
 */
export async function loadCommands(files: string[], options: LoadOptions): Promise<void> {
  const writeErr = options.writeErr ?? ((text: string) => void process.stderr.write(text));
  const registered = new Set(options.program.commands.map((command) => command.name()));

  for (const file of files) {
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (error) {
      fail(options.policy, writeErr, `failed to import ${file}: ${describe(error)}`);
      continue;
    }

    if (!isCommandModule(mod)) {
      fail(options.policy, writeErr, `${file} does not export createCommand()`);
      continue;
    }

    let command: Command;
    try {
      command = mod.createCommand(options.context);
    } catch (error) {
      fail(options.policy, writeErr, `${file} createCommand() threw: ${describe(error)}`);
      continue;
    }

    if (!(command instanceof Command)) {
      fail(options.policy, writeErr, `${file} createCommand() did not return a Command`);
      continue;
    }

    const name = command.name();
    if (!name) {
      fail(options.policy, writeErr, `${file} produced a command with an empty name`);
      continue;
    }
    if (registered.has(name)) {
      fail(options.policy, writeErr, `${file} produced a duplicate command name "${name}"`);
      continue;
    }

    registered.add(name);
    options.program.addCommand(command);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
