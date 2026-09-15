import { Command } from "commander";
import type { CommandContext } from "./command-module.ts";
import {
  activeExtension,
  defaultCommandsDir,
  discoverCommandFiles,
  loadCommands,
  type LoadPolicy,
} from "./command-loader.ts";
import { VERSION } from "./version.ts";

export interface CreateProgramOptions {
  /** stdout sink. Defaults to `process.stdout.write`. */
  writeOut?: (text: string) => void;
  /** stderr sink. Defaults to `process.stderr.write`. */
  writeErr?: (text: string) => void;
  /** Directory to discover command modules from. Defaults to `./commands`. */
  commandsDir?: string;
  /**
   * Malformed-module policy. Defaults to `strict` under `.ts` (source) and
   * `warn` under `.js` (built artifact).
   */
  policy?: LoadPolicy;
}

/**
 * Build the `dhb` root Commander program: configure version, help, output
 * streams and exit behavior, then discover and register command modules.
 */
export async function createProgram(options: CreateProgramOptions = {}): Promise<Command> {
  const extension = activeExtension();
  const writeOut = options.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => void process.stderr.write(text));
  const policy: LoadPolicy = options.policy ?? (extension === ".ts" ? "strict" : "warn");

  const program = new Command();
  program
    .name("dhb")
    .description("Modular command-line tool with a DeepSeek-powered git commit agent.")
    .version(VERSION, "-v, --version", "Print the dhb version and exit")
    .configureOutput({
      writeOut,
      writeErr,
      outputError: (str, write) => write(str),
    })
    .showHelpAfterError("(add --help for usage)")
    .exitOverride();

  const context: CommandContext = { writeOut, writeErr };
  const commandsDir = options.commandsDir ?? defaultCommandsDir();
  const files = await discoverCommandFiles({ commandsDir, extension });
  await loadCommands(files, { program, context, policy, writeErr });

  return program;
}

export interface RunCliOptions extends CreateProgramOptions {
  /** argv to parse. Defaults to `process.argv`. */
  argv?: string[];
}

/**
 * Create the program and parse argv. Returns the process exit code: `0` on
 * success and on the benign early-exit cases Commander signals via
 * `exitOverride` (help/version output), non-zero otherwise.
 */
export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const { argv, ...programOptions } = options;
  const program = await createProgram(programOptions);

  try {
    await program.parseAsync(argv ?? process.argv);
    return 0;
  } catch (error) {
    return exitCodeFor(error);
  }
}

/**
 * Map a Commander `exitOverride` error to a process exit code. Help and version
 * requests, and clean zero-code exits, are treated as success (`0`).
 */
function exitCodeFor(error: unknown): number {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: string; exitCode?: number }).code;
    const benign = new Set(["commander.help", "commander.helpDisplayed", "commander.version"]);
    if (code && benign.has(code)) {
      return 0;
    }
    const exitCode = (error as { exitCode?: number }).exitCode;
    if (typeof exitCode === "number") {
      return exitCode === 0 ? 0 : exitCode;
    }
  }
  return 1;
}
