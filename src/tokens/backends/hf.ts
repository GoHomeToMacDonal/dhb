import { readFile } from "node:fs/promises";
import { downloadFileToCacheDir } from "@huggingface/hub";
import { Template } from "@huggingface/jinja";
import { Tokenizer } from "@huggingface/tokenizers";
import type { TokenInput } from "../input.ts";

export interface HfTokenizerSpec {
  repo: string;
  revision: string;
}

export interface HfCountOptions {
  /** Progress sink for download notices. Never receives counts. */
  log?: (text: string) => void;
}

/**
 * Count tokens with a Hugging Face Hub tokenizer.
 *
 * Text mode encodes the raw text without adding BOS/EOS. Chat mode renders the
 * model's `chat_template` with `add_generation_prompt: true` and encodes the
 * result without adding special tokens again, because the template already
 * emits them. This matches `apply_chat_template(..., tokenize=True)` in
 * Python `transformers`.
 */
export async function countHf(
  spec: HfTokenizerSpec,
  input: TokenInput,
  options: HfCountOptions = {},
): Promise<number> {
  // Sequential on purpose: each download temporarily swaps `console.debug`,
  // and overlapping swaps could restore the wrong function.
  const tokenizerJson = await readHubJson(spec, "tokenizer.json", options.log);
  const tokenizerConfig = await readHubJson(spec, "tokenizer_config.json", options.log);
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

  const text =
    input.kind === "text" ? input.text : renderChatTemplate(spec, tokenizerConfig, input.messages);
  return tokenizer.encode(text, { add_special_tokens: false }).ids.length;
}

function renderChatTemplate(
  spec: HfTokenizerSpec,
  config: Record<string, unknown>,
  messages: unknown[],
): string {
  const source = config.chat_template;
  if (typeof source !== "string" || source.length === 0) {
    throw new Error(`${spec.repo} has no chat template`);
  }

  // Templates reference special tokens by their config key (`bos_token`,
  // `eos_token`, ...). Configs store them either as a string or as an
  // AddedToken object with a `content` field.
  const specialTokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.endsWith("_token")) continue;
    const content = typeof value === "string" ? value : tokenContent(value);
    if (content !== undefined) specialTokens[key] = content;
  }

  return new Template(source).render({
    ...specialTokens,
    messages,
    add_generation_prompt: true,
  });
}

function tokenContent(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = (value as { content: unknown }).content;
    return typeof content === "string" ? content : undefined;
  }
  return undefined;
}

/**
 * Resolve a file from the standard Hugging Face hub cache, downloading it on
 * first use. Because `revision` is a commit hash, a cached snapshot is
 * returned without contacting the Hub. `HF_ENDPOINT` selects a mirror.
 */
async function readHubJson(
  spec: HfTokenizerSpec,
  path: string,
  log: ((text: string) => void) | undefined,
): Promise<Record<string, unknown>> {
  const hubUrl = process.env.HF_ENDPOINT?.trim();
  const notice = `dhb tokens: downloading ${spec.repo}/${path} into the Hugging Face cache\n`;
  const file = await withDownloadNotices(
    () => log?.(notice),
    () =>
      downloadFileToCacheDir({
        repo: spec.repo,
        path,
        revision: spec.revision,
        ...(hubUrl ? { hubUrl } : {}),
      }),
  );
  const data: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${spec.repo}/${path} is not a JSON object`);
  }
  return data as Record<string, unknown>;
}

/**
 * `@huggingface/hub` announces downloads through `console.debug`, which Node
 * writes to stdout and would corrupt `--json` output. While the download
 * runs, replace those messages with our own notice on the caller's sink.
 */
async function withDownloadNotices<T>(onDownload: () => void, run: () => Promise<T>): Promise<T> {
  const original = console.debug;
  console.debug = () => {
    onDownload();
  };
  try {
    return await run();
  } finally {
    console.debug = original;
  }
}
