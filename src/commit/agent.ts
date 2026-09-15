import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  Type,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { loadDeepSeekApiKey } from "../credentials.ts";
import { GitTools } from "./git-tools.ts";
import { StreamRedactor, redactSecrets } from "./redaction.ts";

/** Fixed model identity the commit agent is allowed to run against. */
export const MODEL_IDENTITY = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  api: "openai-completions",
} as const;

/** Tool execution strategy: strictly one tool at a time. */
export const TOOL_EXECUTION_MODE = "sequential" as const;

/** Reasoning level: disabled by default for deterministic, cheap commits. */
export const DEFAULT_THINKING_LEVEL = "off" as const;

/**
 * The exact tool names, in the exact order, exposed to the model. Order and
 * count are part of the agent's contract and are asserted at construction time.
 */
export const TOOL_NAMES = [
  "read",
  "git_status",
  "git_diff_cached",
  "git_log",
  "git_show",
  "git_commit",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const SYSTEM_PROMPT = `You are a commit-message agent operating inside a git repository.

Your only job: inspect the STAGED changes and create exactly one commit whose
message follows the Conventional Commits style and matches the repository's
existing history.

Hard rules:
- Base the message ONLY on the staged diff (git_diff_cached). Ignore unstaged and
  untracked changes; they are shown by git_status for context only and must not
  be described as if committed.
- Before writing the message, inspect recent history with git_log and git_show to
  match the repository's tone, scope vocabulary, and formatting.
- Read files with the read tool only when you need extra context to describe a
  change accurately.
- Scan the staged diff for anything that looks like a secret (API keys, tokens,
  passwords, private keys). If you find a likely secret, DO NOT commit: explain
  what you found and stop.
- Write a concise Conventional Commit: a "type(scope): summary" subject line
  (imperative mood, <= ~72 chars), then an optional body explaining what and why.
- Call git_commit exactly once with the final message.
- After a successful commit, verify with git_status, git_log, and git_show that
  the commit landed as intended, then give a short final summary.

You must NOT: stage or unstage files, push, reset, amend, run arbitrary shell
commands, or use any tool other than the six provided. There is no way to add
changes to the commit beyond what is already staged.`;

/** Minimal sink for agent run logs (defaults to stderr). */
export type LogSink = (text: string) => void;

export interface RunCommitAgentOptions {
  /** Absolute path to the git repository working tree root. */
  repoRoot: string;
  /** Human-readable summary of the staged diff, injected into the prompt. */
  stagedSummary?: string;
  /** Injectable stream function (defaults to the DeepSeek model stream). */
  streamFn?: StreamFn;
  /** Injectable API-key loader (defaults to the credentials-file loader). */
  loadApiKey?: () => Promise<string>;
  /** Injectable GitTools (defaults to a fresh instance bound to repoRoot). */
  gitTools?: GitTools;
  /** Log sink; defaults to process.stderr. */
  log?: LogSink;
  /** Environment used by the default API-key loader. */
  env?: NodeJS.ProcessEnv;
}

export interface CommitAgentResult {
  /** Final assistant text returned to the user. */
  finalText: string;
  /** Whether git_commit was called during the run. */
  committed: boolean;
}

/** Raised for any failure inside the commit agent that should surface generically. */
export class CommitAgentError extends Error {
  override name = "CommitAgentError";
}

/**
 * Resolve the DeepSeek model and assert its identity matches
 * {@link MODEL_IDENTITY}. A mismatch is a hard failure: the agent refuses to run
 * against anything other than the pinned provider/model/base-URL/API.
 */
export function resolveModel(): Model<Api> {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel(MODEL_IDENTITY.provider, MODEL_IDENTITY.model);
  if (!model) {
    throw new CommitAgentError("configured commit model is unavailable");
  }
  assertModelIdentity(model);
  return model;
}

/** Throw unless the model exactly matches the pinned identity. */
export function assertModelIdentity(model: Model<Api>): void {
  const mismatches: string[] = [];
  if (model.provider !== MODEL_IDENTITY.provider) {
    mismatches.push("provider");
  }
  if (model.id !== MODEL_IDENTITY.model) {
    mismatches.push("model");
  }
  if (model.api !== MODEL_IDENTITY.api) {
    mismatches.push("api");
  }
  if (model.baseUrl !== undefined && model.baseUrl !== MODEL_IDENTITY.baseUrl) {
    mismatches.push("baseUrl");
  }
  if (mismatches.length > 0) {
    throw new CommitAgentError(`commit model identity mismatch: ${mismatches.join(", ")}`);
  }
}

/**
 * Build the six git tools, in the fixed contractual order, backed by the given
 * {@link GitTools}. Each tool's `execute` returns the tool output as text
 * content; failures throw (the agent loop turns them into error tool results).
 */
export function createCommitTools(git: GitTools): AgentTool[] {
  const text = (value: string) => ({
    content: [{ type: "text" as const, text: value }],
    details: null,
  });

  const tools: AgentTool[] = [
    {
      name: "read",
      label: "Read file",
      description:
        "Read a UTF-8 text file inside the repository (max 1 MiB). Path must be repo-relative.",
      parameters: Type.Object({
        path: Type.String({ description: "Repository-relative path to read." }),
      }),
      execute: async (_id, params) => {
        const { path } = params as { path: string };
        const result = await git.read(path);
        const suffix = result.truncated ? "\n\n[truncated at 1 MiB]" : "";
        return text(result.content + suffix);
      },
    },
    {
      name: "git_status",
      label: "git status",
      description: "Show the working tree status, including staged, unstaged, and untracked files.",
      parameters: Type.Object({}),
      execute: async () => text(await git.gitStatus()),
    },
    {
      name: "git_diff_cached",
      label: "git diff --cached",
      description: "Show the staged diff. This is the only content that will be committed.",
      parameters: Type.Object({}),
      execute: async () => text(await git.gitDiffCached()),
    },
    {
      name: "git_log",
      label: "git log",
      description: "Show recent commits to learn the repository's message style. Limit 1..50.",
      parameters: Type.Object({
        limit: Type.Integer({ minimum: 1, maximum: 50, description: "Number of commits (1..50)." }),
      }),
      execute: async (_id, params) => {
        const { limit } = params as { limit: number };
        return text(await git.gitLog(limit));
      },
    },
    {
      name: "git_show",
      label: "git show",
      description: "Show a single commit. Ref must be HEAD or HEAD~1 through HEAD~100.",
      parameters: Type.Object({
        ref: Type.String({ description: "HEAD or HEAD~N (1..100)." }),
      }),
      execute: async (_id, params) => {
        const { ref } = params as { ref: string };
        return text(await git.gitShow(ref));
      },
    },
    {
      name: "git_commit",
      label: "git commit",
      description:
        "Create exactly one commit from the staged changes with the given message. " +
        "May be called at most once.",
      parameters: Type.Object({
        message: Type.String({ description: "The full conventional commit message." }),
      }),
      execute: async (_id, params) => {
        const { message } = params as { message: string };
        return text(await git.gitCommit(message));
      },
    },
  ];

  assertToolContract(tools);
  return tools;
}

/** Assert the tool list matches {@link TOOL_NAMES} exactly (order and count). */
export function assertToolContract(tools: AgentTool[]): void {
  const names = tools.map((tool) => tool.name);
  if (names.length !== TOOL_NAMES.length || names.some((name, i) => name !== TOOL_NAMES[i])) {
    throw new CommitAgentError(
      `commit tool contract violated: expected [${TOOL_NAMES.join(", ")}], got [${names.join(", ")}]`,
    );
  }
}

/** Extract the concatenated text content from an assistant message. */
export function assistantText(message: AssistantMessage | undefined): string {
  if (!message) {
    return "";
  }
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Run the commit agent end to end: resolve and validate the model, build the
 * six tools, wire secret-redacting logging, run a single agent session, and
 * return the final assistant text plus whether a commit occurred.
 *
 * The model or credential errors are wrapped in {@link CommitAgentError} with a
 * generic message so nothing sensitive leaks to the caller.
 */
export async function runCommitAgent(options: RunCommitAgentOptions): Promise<CommitAgentResult> {
  const log = options.log ?? ((text: string) => void process.stderr.write(text));
  const git = options.gitTools ?? new GitTools({ cwd: options.repoRoot });
  const loadApiKey = options.loadApiKey ?? (() => loadDeepSeekApiKey(options.env));

  let apiKey: string;
  try {
    apiKey = await loadApiKey();
  } catch {
    throw new CommitAgentError("unable to load DeepSeek credentials");
  }

  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel(MODEL_IDENTITY.provider, MODEL_IDENTITY.model);
  if (!model) {
    throw new CommitAgentError("configured commit model is unavailable");
  }
  assertModelIdentity(model);

  const streamFn = options.streamFn ?? (models.streamSimple.bind(models) as StreamFn);
  const tools = createCommitTools(git);

  const redactor = new StreamRedactor([apiKey]);
  const logLine = (line: string) => log(`${redactSecrets(line, [apiKey])}\n`);

  let committed = false;

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      tools,
    },
    streamFn,
    toolExecution: TOOL_EXECUTION_MODE,
    getApiKey: async (provider) => (provider === MODEL_IDENTITY.provider ? apiKey : undefined),
  });

  agent.subscribe((event: AgentEvent) => {
    handleLogEvent(event, { logLine, log, redactor, apiKey });
    if (event.type === "tool_execution_start" && event.toolName === "git_commit") {
      committed = true;
    }
  });

  const prompt = buildPrompt(options.stagedSummary);

  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();
  } catch {
    log(redactor.flush());
    throw new CommitAgentError("commit agent run failed");
  }

  const tail = redactor.flush();
  if (tail.length > 0) {
    log(tail);
  }

  const messages = agent.state.messages;
  const lastAssistant = [...messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant");
  const finalText = assistantText(lastAssistant);

  if (agent.state.errorMessage) {
    throw new CommitAgentError("commit agent run failed");
  }

  return { finalText, committed };
}

interface LogContext {
  logLine: (line: string) => void;
  log: LogSink;
  redactor: StreamRedactor;
  apiKey: string;
}

/** Translate an agent event into a redacted stderr log line. */
function handleLogEvent(event: AgentEvent, ctx: LogContext): void {
  switch (event.type) {
    case "agent_start":
      ctx.logLine("agent: run started");
      break;
    case "turn_start":
      ctx.logLine("agent: turn started");
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        ctx.log(ctx.redactor.push(event.assistantMessageEvent.delta));
      }
      break;
    case "message_end":
      ctx.log(ctx.redactor.flush());
      break;
    case "tool_execution_start":
      ctx.logLine(`tool: ${event.toolName} started`);
      break;
    case "tool_execution_end":
      ctx.logLine(`tool: ${event.toolName} finished${event.isError ? " (error)" : ""}`);
      break;
    case "turn_end": {
      const usage = event.message.role === "assistant" ? summarizeUsage(event.message) : undefined;
      ctx.logLine(`agent: turn ended${usage ? ` (${usage})` : ""}`);
      break;
    }
    case "agent_end":
      ctx.logLine("agent: run finished");
      break;
    default:
      break;
  }
}

function summarizeUsage(message: AssistantMessage): string | undefined {
  const usage = message.usage;
  if (!usage) {
    return undefined;
  }
  const cost = usage.cost?.total;
  const costPart = typeof cost === "number" ? `, cost $${cost.toFixed(4)}` : "";
  return `tokens in ${usage.input}/out ${usage.output}${costPart}`;
}

function buildPrompt(stagedSummary?: string): string {
  const base =
    "Inspect the staged changes and create exactly one commit following the rules in your " +
    "system prompt.";
  if (stagedSummary && stagedSummary.trim().length > 0) {
    return `${base}\n\nStaged files summary:\n${stagedSummary.trim()}`;
  }
  return base;
}
