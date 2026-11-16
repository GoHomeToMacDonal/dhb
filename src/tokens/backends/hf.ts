import { Template } from "@huggingface/jinja";
import { Tokenizer } from "@huggingface/tokenizers";
import type { TokenInput } from "../input.ts";
import type { PinnedFile } from "../registry.ts";
import { readHubJsonFile } from "./hub-cache.ts";

export interface HfTokenizerSpec {
  repo: string;
  revision: string;
  files: { tokenizer: PinnedFile; config: PinnedFile };
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
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readHubJson(spec, "tokenizer.json", spec.files.tokenizer, options.log),
    readHubJson(spec, "tokenizer_config.json", spec.files.config, options.log),
  ]);
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
 * Read a pinned tokenizer file from the standard Hugging Face hub cache,
 * downloading it on first use. `HF_ENDPOINT` selects a mirror.
 */
function readHubJson(
  spec: HfTokenizerSpec,
  path: string,
  file: PinnedFile,
  log: ((text: string) => void) | undefined,
): Promise<Record<string, unknown>> {
  return readHubJsonFile(
    { repo: spec.repo, revision: spec.revision, file: { path, ...file } },
    (url) => log?.(`dhb tokens: downloading ${url}\n`),
  );
}
