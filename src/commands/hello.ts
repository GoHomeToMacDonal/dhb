import { Command } from "commander";
import type { CommandContext } from "../command-module.ts";

/**
 * `dhb hello [name]` — a minimal example command used to verify that command
 * discovery, registration, argument parsing, and context-based output all work
 * end to end.
 */
export function createCommand(context: CommandContext): Command {
  return new Command("hello")
    .description("Print a friendly greeting")
    .argument("[name]", "who to greet", "world")
    .option("-u, --upper", "shout the greeting in upper case")
    .action((name: string, options: { upper?: boolean }) => {
      const greeting = `Hello, ${name}!`;
      context.writeOut(`${options.upper ? greeting.toUpperCase() : greeting}\n`);
    });
}
