import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitTools, GitToolError, normalizeShowRef } from "../src/commit/git-tools.ts";

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

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dhb-git-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(join(dir, "README.md"), "# fixture\n", "utf8");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "chore: initial commit");
  return dir;
}

describe("normalizeShowRef", () => {
  it("accepts HEAD and HEAD~N within range", () => {
    expect(normalizeShowRef("HEAD")).toBe("HEAD");
    expect(normalizeShowRef(" HEAD~1 ")).toBe("HEAD~1");
    expect(normalizeShowRef("HEAD~100")).toBe("HEAD~100");
  });

  it("rejects arbitrary or out-of-range refs", () => {
    expect(() => normalizeShowRef("HEAD~0")).toThrow(GitToolError);
    expect(() => normalizeShowRef("HEAD~101")).toThrow(/between 1 and 100/);
    expect(() => normalizeShowRef("main")).toThrow(/HEAD or HEAD~N/);
    expect(() => normalizeShowRef("HEAD^")).toThrow(/HEAD or HEAD~N/);
    expect(() => normalizeShowRef("$(rm -rf /)")).toThrow(/HEAD or HEAD~N/);
  });
});

describe("GitTools constructor", () => {
  it("requires an absolute cwd", () => {
    expect(() => new GitTools({ cwd: "relative/path" })).toThrow(/absolute path/);
  });
});

describe("GitTools git operations", () => {
  let dir: string;
  let tools: GitTools;

  beforeEach(async () => {
    dir = await makeRepo();
    tools = new GitTools({ cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports staged changes via gitStatus and gitDiffCached", async () => {
    await writeFile(join(dir, "file.txt"), "hello\n", "utf8");
    await git(dir, "add", "file.txt");

    const status = await tools.gitStatus();
    expect(status).toContain("A  file.txt");

    const diff = await tools.gitDiffCached();
    expect(diff).toContain("+hello");
  });

  it("shows untracked files in status but not in the cached diff", async () => {
    await writeFile(join(dir, "untracked.txt"), "x\n", "utf8");
    const status = await tools.gitStatus();
    expect(status).toContain("?? untracked.txt");
    const diff = await tools.gitDiffCached();
    expect(diff).not.toContain("untracked.txt");
  });

  it("returns recent history from gitLog and rejects bad limits", async () => {
    const log = await tools.gitLog(1);
    expect(log).toContain("chore: initial commit");
    await expect(tools.gitLog(0)).rejects.toThrow(/between 1 and 50/);
    await expect(tools.gitLog(51)).rejects.toThrow(/between 1 and 50/);
    await expect(tools.gitLog(1.5)).rejects.toThrow(/integer/);
  });

  it("shows a commit via gitShow with a validated ref", async () => {
    const out = await tools.gitShow("HEAD");
    expect(out).toContain("chore: initial commit");
    await expect(tools.gitShow("main")).rejects.toThrow(/HEAD or HEAD~N/);
  });
});

describe("GitTools.read", () => {
  let dir: string;
  let tools: GitTools;

  beforeEach(async () => {
    dir = await makeRepo();
    tools = new GitTools({ cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a regular file inside the repo", async () => {
    await writeFile(join(dir, "note.txt"), "content\n", "utf8");
    const result = await tools.read("note.txt");
    expect(result.content).toBe("content\n");
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBe(8);
  });

  it("truncates files larger than 1 MiB and reports it", async () => {
    const big = "a".repeat(2 * 1024 * 1024);
    await writeFile(join(dir, "big.txt"), big, "utf8");
    const result = await tools.read("big.txt");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(1024 * 1024);
  });

  it("rejects absolute paths", async () => {
    await expect(tools.read("/etc/passwd")).rejects.toThrow(/must be relative/);
  });

  it("rejects parent-directory traversal", async () => {
    await expect(tools.read("../outside.txt")).rejects.toThrow(/within the repository/);
  });

  it("rejects NUL bytes", async () => {
    await expect(tools.read("a\0b")).rejects.toThrow(/NUL/);
  });

  it("rejects access to the .git directory", async () => {
    await expect(tools.read(".git/config")).rejects.toThrow(/\.git/);
  });

  it("rejects a symlink even if it points inside the repo", async () => {
    await writeFile(join(dir, "target.txt"), "ok\n", "utf8");
    await symlink(join(dir, "target.txt"), join(dir, "link.txt"));
    await expect(tools.read("link.txt")).rejects.toThrow(/symlink/);
  });

  it("rejects a symlinked directory that escapes the repo", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dhb-outside-"));
    await writeFile(join(outside, "secret.txt"), "top secret\n", "utf8");
    await mkdir(join(dir, "sub"), { recursive: true });
    await symlink(outside, join(dir, "sub", "escape"));
    await expect(tools.read("sub/escape/secret.txt")).rejects.toThrow(/symlink|outside/);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a nonexistent file", async () => {
    await expect(tools.read("missing.txt")).rejects.toThrow(/does not exist/);
  });
});

describe("GitTools.gitCommit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("commits staged changes once", async () => {
    await writeFile(join(dir, "feature.txt"), "feature\n", "utf8");
    await git(dir, "add", "feature.txt");
    const tools = new GitTools({ cwd: dir });

    await tools.gitCommit("feat: add feature file");
    const log = await tools.gitLog(1);
    expect(log).toContain("feat: add feature file");
  });

  it("refuses a second commit attempt on the same instance", async () => {
    await writeFile(join(dir, "one.txt"), "1\n", "utf8");
    await git(dir, "add", "one.txt");
    const tools = new GitTools({ cwd: dir });

    await tools.gitCommit("feat: first");
    await writeFile(join(dir, "two.txt"), "2\n", "utf8");
    await git(dir, "add", "two.txt");
    await expect(tools.gitCommit("feat: second")).rejects.toThrow(/only one commit attempt/);
  });

  it("does not retry after a failed commit attempt", async () => {
    // Nothing staged -> git commit fails; the attempt is still consumed.
    const tools = new GitTools({ cwd: dir });
    await expect(tools.gitCommit("feat: nothing staged")).rejects.toThrow(GitToolError);
    await expect(tools.gitCommit("feat: retry")).rejects.toThrow(/only one commit attempt/);
  });

  it("rejects empty, oversized, and NUL-containing messages", async () => {
    await expect(new GitTools({ cwd: dir }).gitCommit("   ")).rejects.toThrow(/non-empty/);
    await expect(new GitTools({ cwd: dir }).gitCommit("a".repeat(4097))).rejects.toThrow(
      /at most 4096/,
    );
    await expect(new GitTools({ cwd: dir }).gitCommit("bad\0msg")).rejects.toThrow(/NUL/);
  });
});
