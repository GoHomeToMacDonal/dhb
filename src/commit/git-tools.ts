import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Default hard timeout for any git/file operation. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Buffer cap for a subprocess's stdout+stderr (64 MiB). */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** Maximum bytes returned by {@link GitTools.read}. */
const MAX_READ_BYTES = 1024 * 1024;
/** Bounds for `git log`. */
const MIN_LOG_LIMIT = 1;
const MAX_LOG_LIMIT = 50;
/** Maximum ancestor depth for `git show` (HEAD~N). */
const MAX_SHOW_DEPTH = 100;
/** Maximum length of a commit message. */
const MAX_COMMIT_MESSAGE_LENGTH = 4096;

/** Raised for any disallowed or failed git-tools operation. */
export class GitToolError extends Error {
  override name = "GitToolError";
}

export interface GitToolsOptions {
  /** Absolute path to the repository working tree root. */
  cwd: string;
  /** Override the per-command timeout (ms). */
  timeoutMs?: number;
}

export interface ReadResult {
  /** File contents, decoded as UTF-8, capped at 1 MiB. */
  content: string;
  /** Number of bytes returned. */
  bytes: number;
  /** True when the file was larger than the cap and `content` is truncated. */
  truncated: boolean;
}

/**
 * Shared execution layer for every git tool exposed to the commit agent.
 *
 * Every subprocess is launched with {@link execFile} and a fixed argv (never a
 * shell), a fixed working directory, hardened environment, a timeout, and a
 * bounded output buffer. The model can only reach git through the narrow,
 * read-mostly surface defined here; there is no general command execution.
 */
export class GitTools {
  private readonly cwd: string;
  private readonly timeoutMs: number;
  /** At most one commit attempt is allowed per instance, success or not. */
  private commitAttempted = false;

  constructor(options: GitToolsOptions) {
    if (!isAbsolute(options.cwd)) {
      throw new GitToolError("GitTools cwd must be an absolute path");
    }
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Run `git` with a fixed argv in the fixed working directory. */
  private async runGit(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      });
      return stdout;
    } catch (error) {
      throw new GitToolError(`git ${args[0] ?? ""} failed: ${describeExecError(error)}`);
    }
  }

  /**
   * Read a UTF-8 file from inside the repository.
   *
   * Rejects absolute paths, `..` traversal, NUL bytes, and any path that
   * touches `.git`. After lexical checks it uses `lstat` to reject symlinks and
   * `realpath` to confirm the resolved target still lives inside the working
   * tree, defeating symlink escapes. Output is capped at 1 MiB.
   */
  async read(relativePath: string): Promise<ReadResult> {
    const safeAbsolute = await this.resolveInsideRepo(relativePath);

    const buffer = await readFile(safeAbsolute);
    const truncated = buffer.length > MAX_READ_BYTES;
    const slice = truncated ? buffer.subarray(0, MAX_READ_BYTES) : buffer;
    return {
      content: slice.toString("utf8"),
      bytes: slice.length,
      truncated,
    };
  }

  /**
   * Validate a caller-supplied relative path and return the absolute path it
   * safely resolves to inside the repository, or throw {@link GitToolError}.
   */
  private async resolveInsideRepo(relativePath: string): Promise<string> {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new GitToolError("read path must be a non-empty string");
    }
    if (relativePath.includes("\0")) {
      throw new GitToolError("read path must not contain NUL bytes");
    }
    if (isAbsolute(relativePath)) {
      throw new GitToolError("read path must be relative to the repository root");
    }

    const resolved = resolve(this.cwd, relativePath);
    const rel = relative(this.cwd, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new GitToolError("read path must stay within the repository");
    }
    if (isGitPath(rel)) {
      throw new GitToolError("read path must not access the .git directory");
    }

    // Reject symlinks and confirm the real path is still inside the repo.
    let stats;
    try {
      stats = await lstat(resolved);
    } catch {
      throw new GitToolError(`read path does not exist: ${relativePath}`);
    }
    if (stats.isSymbolicLink()) {
      throw new GitToolError("read path must not be a symlink");
    }
    if (!stats.isFile()) {
      throw new GitToolError("read path must be a regular file");
    }

    const realFile = await realpath(resolved);
    const realRoot = await realpath(this.cwd);
    const realRel = relative(realRoot, realFile);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new GitToolError("read path resolves outside the repository");
    }
    if (isGitPath(realRel)) {
      throw new GitToolError("read path resolves into the .git directory");
    }

    return realFile;
  }

  /** `git status --porcelain=v1 --untracked-files=all` (never mutates). */
  async gitStatus(): Promise<string> {
    return this.runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  }

  /** `git diff --cached` — the staged diff that is the only commit input. */
  async gitDiffCached(): Promise<string> {
    return this.runGit(["diff", "--cached"]);
  }

  /**
   * `git log` limited to `limit` entries (clamped to 1..50). Emits a compact,
   * parse-friendly format for inspecting recent commit style.
   */
  async gitLog(limit: number): Promise<string> {
    if (!Number.isInteger(limit)) {
      throw new GitToolError("git_log limit must be an integer");
    }
    if (limit < MIN_LOG_LIMIT || limit > MAX_LOG_LIMIT) {
      throw new GitToolError(`git_log limit must be between ${MIN_LOG_LIMIT} and ${MAX_LOG_LIMIT}`);
    }
    return this.runGit([
      "log",
      `--max-count=${limit}`,
      "--pretty=format:%H%n%an%n%ad%n%s%n%b%n===",
    ]);
  }

  /**
   * `git show <ref>` where `ref` is restricted to `HEAD` or `HEAD~1`..`HEAD~100`.
   * No arbitrary revisions, pathspecs, or options are accepted.
   */
  async gitShow(ref: string): Promise<string> {
    const safeRef = normalizeShowRef(ref);
    return this.runGit(["show", "--no-color", safeRef]);
  }

  /**
   * `git commit -m <message>`. `--no-verify` is never used, the message must be
   * non-empty, free of NUL bytes, and at most 4096 characters. Only one commit
   * attempt is permitted per instance — a second call always throws, and even a
   * failed attempt is not retried.
   */
  async gitCommit(message: string): Promise<string> {
    if (this.commitAttempted) {
      throw new GitToolError("only one commit attempt is allowed per run");
    }
    this.commitAttempted = true;

    if (typeof message !== "string" || message.trim().length === 0) {
      throw new GitToolError("commit message must be a non-empty string");
    }
    if (message.includes("\0")) {
      throw new GitToolError("commit message must not contain NUL bytes");
    }
    if (message.length > MAX_COMMIT_MESSAGE_LENGTH) {
      throw new GitToolError(
        `commit message must be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters`,
      );
    }

    return this.runGit(["commit", "-m", message]);
  }
}

/** True when a repo-relative path's first segment is `.git`. */
function isGitPath(relativePath: string): boolean {
  const normalized = relativePath.split(sep).filter(Boolean);
  return normalized[0] === ".git";
}

/**
 * Validate and normalize a `git show` ref. Only `HEAD` and `HEAD~N` for
 * `1 <= N <= 100` are permitted.
 */
export function normalizeShowRef(ref: string): string {
  if (typeof ref !== "string") {
    throw new GitToolError("git_show ref must be a string");
  }
  const trimmed = ref.trim();
  if (trimmed === "HEAD") {
    return "HEAD";
  }
  const match = /^HEAD~(\d+)$/.exec(trimmed);
  if (!match) {
    throw new GitToolError("git_show ref must be HEAD or HEAD~N");
  }
  const depth = Number(match[1]);
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_SHOW_DEPTH) {
    throw new GitToolError(`git_show ref depth must be between 1 and ${MAX_SHOW_DEPTH}`);
  }
  return `HEAD~${depth}`;
}

function describeExecError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const err = error as { killed?: boolean; signal?: string; stderr?: string; message?: string };
    if (err.killed && err.signal) {
      return `timed out (${err.signal})`;
    }
    if (typeof err.stderr === "string" && err.stderr.trim().length > 0) {
      return err.stderr.trim();
    }
    if (typeof err.message === "string") {
      return err.message;
    }
  }
  return String(error);
}

export const GIT_TOOLS_LIMITS = {
  DEFAULT_TIMEOUT_MS,
  MAX_BUFFER_BYTES,
  MAX_READ_BYTES,
  MIN_LOG_LIMIT,
  MAX_LOG_LIMIT,
  MAX_SHOW_DEPTH,
  MAX_COMMIT_MESSAGE_LENGTH,
} as const;
