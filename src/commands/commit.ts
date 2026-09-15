import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import type { CommandContext } from "../command-module.ts";

const execFileAsync = promisify(execFile);

/**
 * `dhb commit` — read the git staging area and let the DeepSeek agent generate
 * and make a single commit.
 *
 * This module is a thin adapter: it verifies preconditions with argv-only git
 * calls, then loads the heavy agent runtime lazily via dynamic `import()` so
 * that `dhb --help` and `dhb commit --help` never pull in the model SDK.
 */
export function createCommand(context: CommandContext): Command {
  return new Command("commit")
    .description("Generate and create a git commit for staged changes using a DeepSeek agent")
    .action(async () => {
      try {
        await runCommit(context);
      } catch (error) {
        // Surface only a generic message; model/credential internals may carry
        // secrets and must never reach the user through this path.
        context.writeErr(`dhb commit: ${genericMessage(error)}\n`);
        process.exitCode = 1;
      }
    });
}

async function runCommit(context: CommandContext): Promise<void> {
  const repoRoot = await resolveRepoRoot();
  if (!repoRoot) {
    context.writeErr("dhb commit: not inside a git working tree\n");
    process.exitCode = 1;
    return;
  }

  const staged = await stagedDiffStat(repoRoot);
  if (!staged) {
    context.writeErr("dhb commit: no staged changes to commit\n");
    process.exitCode = 1;
    return;
  }

  // Lazy-load the agent runtime only once we know we have work to do.
  const { runCommitAgent } = await import("../commit/agent.ts");
  const result = await runCommitAgent({ repoRoot, stagedSummary: staged });

  const text = result.finalText.trim();
  context.writeOut(text.length > 0 ? `${text}\n` : "");
}

/** Return the working-tree root, or undefined when not in a git repository. */
async function resolveRepoRoot(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      windowsHide: true,
    });
    const root = stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return a compact summary of staged changes (`git diff --cached --stat`), or
 * undefined when nothing is staged. Only staged content is ever considered.
 */
async function stagedDiffStat(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--stat"], {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const summary = stdout.trim();
    return summary.length > 0 ? summary : undefined;
  } catch {
    return undefined;
  }
}

function genericMessage(error: unknown): string {
  // Known, safe messages from the agent layer are already sanitized.
  if (error instanceof Error && error.name === "CommitAgentError") {
    return error.message;
  }
  return "failed to generate commit";
}
