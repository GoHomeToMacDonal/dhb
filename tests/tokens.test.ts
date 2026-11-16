import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommand } from "../src/commands/tokens.ts";
import { ChatInputError, parseChatInput } from "../src/tokens/input.ts";
import { MODELS, resolveModels } from "../src/tokens/registry.ts";
import { createSink } from "./helpers.ts";

/**
 * A tiny BPE tokenizer: whitespace pre-tokenization, the merge `h i -> hi`,
 * and `<s>` as a special token. "hi hi" encodes to two tokens.
 */
const TINY_TOKENIZER = {
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: [
    {
      id: 0,
      content: "<s>",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
  ],
  normalizer: null,
  pre_tokenizer: { type: "Whitespace" },
  post_processor: null,
  decoder: null,
  model: {
    type: "BPE",
    dropout: null,
    unk_token: "<unk>",
    continuing_subword_prefix: null,
    end_of_word_suffix: null,
    fuse_unk: false,
    byte_fallback: false,
    vocab: { "<s>": 0, "<unk>": 1, h: 2, i: 3, hi: 4 },
    merges: ["h i"],
  },
};

let workDir: string;
let previousHubCache: string | undefined;
let previousExit: typeof process.exitCode;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "dhb-tokens-"));
  previousHubCache = process.env.HF_HUB_CACHE;
  // Point the Hugging Face cache at an empty temp dir so tests never touch the
  // real user cache.
  process.env.HF_HUB_CACHE = join(workDir, "hf");
  previousExit = process.exitCode;
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = previousExit;
  if (previousHubCache === undefined) {
    delete process.env.HF_HUB_CACHE;
  } else {
    process.env.HF_HUB_CACHE = previousHubCache;
  }
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Pre-populate the HF cache snapshot for a registry model with the tiny
 * tokenizer. Because registry revisions are commit hashes, the hub client
 * resolves these files locally without any network request.
 */
async function seedHubCache(modelId: string, config: Record<string, unknown>): Promise<void> {
  const model = MODELS.find((m) => m.id === modelId);
  if (!model || model.tokenizer.kind !== "hf") throw new Error(`not an hf model: ${modelId}`);
  const { repo, revision } = model.tokenizer;
  const snapshot = join(
    process.env.HF_HUB_CACHE ?? "",
    `models--${repo.replace("/", "--")}`,
    "snapshots",
    revision,
  );
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, "tokenizer.json"), JSON.stringify(TINY_TOKENIZER));
  await writeFile(join(snapshot, "tokenizer_config.json"), JSON.stringify(config));
}

async function writeInput(name: string, content: string): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, content, "utf8");
  return path;
}

async function run(args: string[]): Promise<{ out: string; err: string }> {
  const out = createSink();
  const err = createSink();
  const command = createCommand({ writeOut: out.write, writeErr: err.write });
  await command.parseAsync(args, { from: "user" });
  return { out: out.text(), err: err.text() };
}

describe("model registry", () => {
  it("defaults to one model per tokenizer family", () => {
    expect(resolveModels(undefined).map((m) => m.id)).toEqual([
      "gpt-4o",
      "gpt-5",
      "deepseek-v3",
      "deepseek-r1",
      "qwen3",
    ]);
  });

  it("resolves ids case-insensitively, in order, without duplicates", () => {
    expect(resolveModels(["Qwen3", "gpt-4o", "qwen3"]).map((m) => m.id)).toEqual([
      "qwen3",
      "gpt-4o",
    ]);
  });

  it("rejects unknown ids, naming each one", () => {
    expect(() => resolveModels(["gpt-4o", "nope", "gpt-9"])).toThrow(/nope, gpt-9/);
  });

  it("pins every Hub tokenizer to a commit hash", () => {
    for (const model of MODELS) {
      if (model.tokenizer.kind === "hf") {
        expect(model.tokenizer.revision).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });
});

describe("parseChatInput", () => {
  it("accepts a bare array and an OpenAI-style request object", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(parseChatInput(JSON.stringify(messages))).toEqual(messages);
    expect(parseChatInput(JSON.stringify({ model: "x", messages }))).toEqual(messages);
  });

  it("keeps extra message fields for chat templates", () => {
    const parsed = parseChatInput('[{"role":"assistant","content":"a","reasoning_content":"r"}]');
    expect(parsed[0]).toMatchObject({ reasoning_content: "r" });
  });

  it.each([
    ["not json", /must be JSON/],
    ['{"foo":1}', /"messages" array/],
    ["[]", /no messages/],
    ["[1]", /messages\[0\] must be an object/],
    ['[{"content":"x"}]', /messages\[0\]\.role/],
    ['[{"role":"user","content":["x"]}]', /messages\[0\]\.content must be a string/],
  ])("rejects %s", (raw, message) => {
    expect(() => parseChatInput(raw)).toThrow(ChatInputError);
    expect(() => parseChatInput(raw)).toThrow(message);
  });
});

describe("tokens command", () => {
  it("is named tokens with a description", () => {
    const command = createCommand({ writeOut: () => {}, writeErr: () => {} });
    expect(command.name()).toBe("tokens");
    expect(command.description()).toMatch(/token/i);
  });

  it("counts plain text with OpenAI tokenizers", async () => {
    const file = await writeInput("in.txt", "Hello world");
    const { out, err } = await run([file, "-m", "gpt-4o,gpt-5.5", "--json"]);

    expect(err).toBe("");
    expect(JSON.parse(out)).toEqual({
      mode: "text",
      characters: 11,
      results: [
        { model: "gpt-4o", tokenizer: "o200k_base", tokens: 2 },
        { model: "gpt-5.5", tokenizer: "o200k_base", tokens: 2 },
      ],
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("treats special-token literals in text as ordinary text", async () => {
    const file = await writeInput("in.txt", "<|endoftext|>");
    const { out } = await run([file, "-m", "gpt-4o", "--json"]);
    expect(JSON.parse(out).results[0].tokens).toBeGreaterThan(1);
  });

  it("applies the ChatML framing for OpenAI chat input", async () => {
    const file = await writeInput("chat.json", '[{"role":"user","content":"Hello world"}]');
    const { out } = await run([file, "--chat", "-m", "gpt-4o", "--json"]);
    // <|im_start|> user <|im_sep|> Hello world <|im_end|> + assistant priming.
    expect(JSON.parse(out)).toMatchObject({ mode: "chat", messages: 1, results: [{ tokens: 9 }] });
  });

  it("prints a table by default", async () => {
    const file = await writeInput("in.txt", "Hello world");
    const { out } = await run([file, "-m", "gpt-4o"]);
    expect(out).toContain("Input: 11 characters (text)");
    expect(out).toMatch(/^MODEL\s+TOKENIZER\s+TOKENS$/m);
    expect(out).toMatch(/^gpt-4o\s+o200k_base\s+2$/m);
  });

  it("counts text with a cached Hugging Face tokenizer", async () => {
    await seedHubCache("deepseek-v3", { bos_token: "<s>", chat_template: "" });
    const file = await writeInput("in.txt", "hi hi");
    const { out, err } = await run([file, "-m", "deepseek-v3", "--json"]);

    expect(err).toBe("");
    expect(JSON.parse(out).results).toEqual([
      { model: "deepseek-v3", tokenizer: "deepseek-ai/DeepSeek-V3", tokens: 2 },
    ]);
  });

  it("renders the Hub chat template, including special tokens", async () => {
    await seedHubCache("qwen3", {
      bos_token: { content: "<s>" },
      chat_template:
        "{{ bos_token }}{% for m in messages %}{{ m.content }} {% endfor %}" +
        "{% if add_generation_prompt %}hi{% endif %}",
    });
    const file = await writeInput("chat.json", '{"messages":[{"role":"user","content":"hi"}]}');
    const { out } = await run([file, "--chat", "-m", "qwen3", "--json"]);
    // "<s>hi hi" -> <s>, hi, hi
    expect(JSON.parse(out).results[0].tokens).toBe(3);
  });

  it("reports a missing chat template per model and keeps counting others", async () => {
    await seedHubCache("deepseek-r1", { bos_token: "<s>" });
    const file = await writeInput("chat.json", '[{"role":"user","content":"hi"}]');
    const { out, err } = await run([file, "--chat", "-m", "deepseek-r1,gpt-4o", "--json"]);

    expect(JSON.parse(out).results).toEqual([
      {
        model: "deepseek-r1",
        tokenizer: "deepseek-ai/DeepSeek-R1",
        error: "deepseek-ai/DeepSeek-R1 has no chat template",
      },
      { model: "gpt-4o", tokenizer: "o200k_base", tokens: 8 },
    ]);
    expect(err).toContain("deepseek-r1: deepseek-ai/DeepSeek-R1 has no chat template");
    expect(process.exitCode).toBe(1);
  });

  it("requires JSON input in chat mode", async () => {
    const file = await writeInput("chat.txt", "hello");
    const { out, err } = await run([file, "--chat", "-m", "gpt-4o"]);
    expect(out).toBe("");
    expect(err).toMatch(/^dhb tokens: chat input must be JSON/);
    expect(process.exitCode).toBe(1);
  });

  it("fails on unknown models before reading input", async () => {
    const { err } = await run([join(workDir, "missing.txt"), "-m", "nope"]);
    expect(err).toBe("dhb tokens: unknown model: nope (see --list-models)\n");
    expect(process.exitCode).toBe(1);
  });

  it("fails on a missing input file", async () => {
    const { err } = await run([join(workDir, "missing.txt"), "-m", "gpt-4o"]);
    expect(err).toMatch(/ENOENT/);
    expect(process.exitCode).toBe(1);
  });

  it("lists models without reading input", async () => {
    const { out } = await run(["--list-models", "--json"]);
    const list = JSON.parse(out) as { id: string; default: boolean }[];
    expect(list.map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
    expect(list.find((m) => m.id === "qwen3")).toMatchObject({
      tokenizer: "Qwen/Qwen3-8B",
      default: true,
    });
  });
});
