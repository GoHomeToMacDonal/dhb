import type { TokenInput } from "../input.ts";
import type { OpenAiModelId } from "../registry.ts";

/** The subset of a `gpt-tokenizer/model/*` module this backend uses. */
interface GptModelModule {
  encode(text: string, options?: { disallowedSpecial?: Set<string> }): number[];
  encodeChat(chat: readonly { role?: string; name?: string; content: string }[]): number[];
}

// Static specifiers (rather than a template string) keep every import
// statically resolvable and make it impossible to load an arbitrary path.
const LOADERS: Record<OpenAiModelId, () => Promise<GptModelModule>> = {
  "gpt-4o": () => import("gpt-tokenizer/model/gpt-4o"),
  "gpt-4o-mini": () => import("gpt-tokenizer/model/gpt-4o-mini"),
  "gpt-5": () => import("gpt-tokenizer/model/gpt-5"),
  "gpt-5-mini": () => import("gpt-tokenizer/model/gpt-5-mini"),
  "gpt-5-nano": () => import("gpt-tokenizer/model/gpt-5-nano"),
  "gpt-5.1": () => import("gpt-tokenizer/model/gpt-5.1"),
  "gpt-5.2": () => import("gpt-tokenizer/model/gpt-5.2"),
  "gpt-5.4": () => import("gpt-tokenizer/model/gpt-5.4"),
  "gpt-5.4-mini": () => import("gpt-tokenizer/model/gpt-5.4-mini"),
  "gpt-5.4-nano": () => import("gpt-tokenizer/model/gpt-5.4-nano"),
  "gpt-5.5": () => import("gpt-tokenizer/model/gpt-5.5"),
};

/**
 * Count tokens with OpenAI's tokenizer.
 *
 * Text mode treats special-token literals such as `<|endoftext|>` as ordinary
 * text (`gpt-tokenizer` throws on them by default). Chat mode uses the ChatML
 * framing that `gpt-tokenizer` implements for the model, including the
 * trailing assistant priming tokens.
 */
export async function countOpenAi(model: OpenAiModelId, input: TokenInput): Promise<number> {
  const tokenizer = await LOADERS[model]();
  if (input.kind === "text") {
    return tokenizer.encode(input.text, { disallowedSpecial: new Set() }).length;
  }
  const chat = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(typeof message.name === "string" ? { name: message.name } : {}),
  }));
  return tokenizer.encodeChat(chat).length;
}
