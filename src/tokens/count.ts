import { countHf } from "./backends/hf.ts";
import { countOpenAi } from "./backends/openai.ts";
import type { TokenInput } from "./input.ts";
import { type ModelEntry, tokenizerLabel } from "./registry.ts";

export type CountResult =
  | { model: string; tokenizer: string; tokens: number }
  | { model: string; tokenizer: string; error: string };

export interface CountOptions {
  /** Progress sink for download notices (stderr). */
  log?: (text: string) => void;
}

/**
 * Count `input` for each model in order. A failure for one model (for example
 * a failed download) is recorded in its result and does not stop the others.
 * Models run sequentially to bound memory: Hub tokenizers are several MB each.
 */
export async function countTokens(
  models: readonly ModelEntry[],
  input: TokenInput,
  options: CountOptions = {},
): Promise<CountResult[]> {
  const results: CountResult[] = [];
  for (const model of models) {
    const tokenizer = tokenizerLabel(model.tokenizer);
    try {
      const spec = model.tokenizer;
      const tokens =
        spec.kind === "openai"
          ? await countOpenAi(spec.model, input)
          : await countHf(spec, input, options.log ? { log: options.log } : {});
      results.push({ model: model.id, tokenizer, tokens });
    } catch (error) {
      results.push({
        model: model.id,
        tokenizer,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
