import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommand } from "../src/commands/commit.ts";
import { createSink } from "./helpers.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/** Run the commit command with cwd temporarily switched to `dir`. */
async function runCommitIn(
  dir: string,
): Promise<{ out: string; err: string; exitCode: typeof process.exitCode }> {
  const out = createSink();
  const err = createSink();
  const previousCwd = process.cwd();
  const previousExit = process.exitCode;
  // Force credential loading to fail deterministically and offline: point
  // DSH_HOME at a path with no credentials file so the agent never attempts a
  // real network request during tests.
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "no-such-dsh-home");
  process.exitCode = undefined;
  process.chdir(dir);
  try {
    const command = createCommand({ writeOut: out.write, writeErr: err.write });
    await command.parseAsync([], { from: "user" });
    return { out: out.text(), err: err.text(), exitCode: process.exitCode };
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExit;
    if (previousDshHome === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = previousDshHome;
    }
  }
}

describe("commit command", () => {
  it("is named commit with a description", () => {
    const command = createCommand({ writeOut: () => {}, writeErr: () => {} });
    expect(command.name()).toBe("commit");
    expect(command.description()).toMatch(/commit/i);
  });
});

describe("commit command preconditions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dhb-commit-cmd-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fails when not inside a git working tree", async () => {
    const { err, exitCode } = await runCommitIn(dir);
    expect(err).toContain("not inside a git working tree");
    expect(exitCode).toBe(1);
  });

  it("fails when there are no staged changes", async () => {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.com");
    await writeFile(join(dir, "a.txt"), "a\n", "utf8");
    await git(dir, "add", "a.txt");
    await git(dir, "commit", "-q", "-m", "chore: init");
    // Working tree clean, nothing staged.
    const { err, exitCode } = await runCommitIn(dir);
    expect(err).toContain("no staged changes");
    expect(exitCode).toBe(1);
  });

  it("does not treat untracked files as staged", async () => {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.com");
    await writeFile(join(dir, "seed.txt"), "s\n", "utf8");
    await git(dir, "add", "seed.txt");
    await git(dir, "commit", "-q", "-m", "chore: init");
    // Create an untracked file but stage nothing.
    await writeFile(join(dir, "untracked.txt"), "u\n", "utf8");
    const { err, exitCode } = await runCommitIn(dir);
    expect(err).toContain("no staged changes");
    expect(exitCode).toBe(1);
  });

  it("passes preconditions with staged changes and reaches the agent", async () => {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.com");
    await writeFile(join(dir, "seed.txt"), "s\n", "utf8");
    await git(dir, "add", "seed.txt");
    await git(dir, "commit", "-q", "-m", "chore: init");
    // Stage a change; the agent will run and fail loading credentials in CI,
    // producing the generic sanitized message (never a stack trace or path).
    await writeFile(join(dir, "feature.txt"), "feature\n", "utf8");
    await git(dir, "add", "feature.txt");

    const { err, exitCode } = await runCommitIn(dir);
    // Precondition messages must NOT appear; we got past them into the agent.
    expect(err).not.toContain("not inside a git working tree");
    expect(err).not.toContain("no staged changes");
    // The agent fails to load credentials (DSH_HOME points at an empty path),
    // producing the generic, sanitized message and a non-zero exit code.
    expect(err).toMatch(/^dhb commit: /);
    expect(err).toContain("unable to load DeepSeek credentials");
    expect(err).not.toMatch(/\.dsh/);
    expect(exitCode).toBe(1);
  });
});
