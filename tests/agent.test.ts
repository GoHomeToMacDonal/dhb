import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  assertModelIdentity,
  assertToolContract,
  assistantText,
  createCommitTools,
  CommitAgentError,
  MODEL_IDENTITY,
  resolveModel,
  runCommitAgent,
  TOOL_EXECUTION_MODE,
  TOOL_NAMES,
} from "../src/commit/agent.ts";
import { GitTools } from "../src/commit/git-tools.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "dhb-agent-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(join(dir, "README.md"), "# fixture\n", "utf8");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "chore: initial commit");
  return dir;
}

/** Build a StreamFn from a faux provider scripted with the given response steps. */
function fauxStream(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]): {
  streamFn: StreamFn;
  pending: () => number;
} {
  const faux = fauxProvider({ provider: "deepseek", api: "openai-completions" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return {
    streamFn: models.streamSimple.bind(models) as StreamFn,
    pending: () => faux.getPendingResponseCount(),
  };
}

describe("model identity", () => {
  it("resolves the pinned DeepSeek model", () => {
    const model = resolveModel();
    expect(model.id).toBe(MODEL_IDENTITY.model);
    expect(model.provider).toBe(MODEL_IDENTITY.provider);
    expect(model.api).toBe(MODEL_IDENTITY.api);
  });

  it("rejects a model with the wrong identity", () => {
    const good = resolveModel();
    expect(() => assertModelIdentity({ ...good, provider: "openai" })).toThrow(/identity mismatch/);
    expect(() => assertModelIdentity({ ...good, id: "gpt-4" })).toThrow(/identity mismatch/);
    expect(() => assertModelIdentity({ ...good, baseUrl: "https://evil.example" })).toThrow(
      /identity mismatch/,
    );
  });

  it("uses sequential tool execution", () => {
    expect(TOOL_EXECUTION_MODE).toBe("sequential");
  });
});

describe("tool contract", () => {
  it("builds the six tools in the fixed order", async () => {
    const dir = await makeRepo();
    try {
      const tools = createCommitTools(new GitTools({ cwd: dir }));
      expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      expect(() => assertToolContract(tools)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a tampered tool list", () => {
    expect(() => assertToolContract([])).toThrow(/tool contract violated/);
  });
});

describe("assistantText", () => {
  it("concatenates text blocks and trims", () => {
    const message = fauxAssistantMessage([fauxText("  feat: x "), fauxText("done  ")]);
    expect(assistantText(message)).toBe("feat: x done");
  });

  it("returns empty string for undefined", () => {
    expect(assistantText(undefined)).toBe("");
  });
});

describe("runCommitAgent (faux stream)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the loop, invokes git_commit, and returns final text", async () => {
    await writeFile(join(dir, "feature.txt"), "hello\n", "utf8");
    await git(dir, "add", "feature.txt");

    const { streamFn } = fauxStream([
      // Turn 1: inspect staged diff, then call git_commit.
      fauxAssistantMessage([
        fauxText("Inspecting staged changes."),
        fauxToolCall("git_diff_cached", {}),
      ]),
      fauxAssistantMessage([
        fauxText("Committing."),
        fauxToolCall("git_commit", { message: "feat: add feature file" }),
      ]),
      // Final turn: verification + summary, no tool calls -> agent stops.
      fauxAssistantMessage("Committed feat: add feature file successfully."),
    ]);

    const logs: string[] = [];
    const result = await runCommitAgent({
      repoRoot: dir,
      streamFn,
      loadApiKey: async () => "sk-test-key-1234",
      log: (t) => logs.push(t),
    });

    expect(result.committed).toBe(true);
    expect(result.finalText).toContain("successfully");

    // Verify the commit actually landed in the repo.
    const log = await new GitTools({ cwd: dir }).gitLog(1);
    expect(log).toContain("feat: add feature file");

    // Logs mention tool activity.
    expect(logs.join("")).toContain("git_commit");
  });

  it("redacts the API key from logs", async () => {
    await writeFile(join(dir, "x.txt"), "x\n", "utf8");
    await git(dir, "add", "x.txt");
    const apiKey = "sk-super-secret-abcdef123456";

    const { streamFn } = fauxStream([
      fauxAssistantMessage([
        fauxText(`leaking ${apiKey} in the response`),
        fauxToolCall("git_commit", { message: "feat: x" }),
      ]),
      fauxAssistantMessage("done"),
    ]);

    const logs: string[] = [];
    await runCommitAgent({
      repoRoot: dir,
      streamFn,
      loadApiKey: async () => apiKey,
      log: (t) => logs.push(t),
    });

    expect(logs.join("")).not.toContain(apiKey);
  });

  it("wraps credential loading failures generically", async () => {
    const { streamFn } = fauxStream([fauxAssistantMessage("noop")]);
    await expect(
      runCommitAgent({
        repoRoot: dir,
        streamFn,
        loadApiKey: async () => {
          throw new Error("secret path /home/user/.dsh leaked");
        },
        log: () => {},
      }),
    ).rejects.toThrow(CommitAgentError);
  });
});
