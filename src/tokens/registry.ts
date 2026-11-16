/**
 * Static catalogue of models `dhb tokens` can count for.
 *
 * Two tokenizer backends are supported, both pure JavaScript:
 *
 * - `openai`: `gpt-tokenizer`, which bundles OpenAI's BPE ranks, so no
 *   download is needed. Every GPT-4o / GPT-5 family model uses `o200k_base`.
 * - `hf`: `tokenizer.json` + `tokenizer_config.json` from the Hugging Face Hub,
 *   loaded with `@huggingface/tokenizers` and cached in the standard Hugging
 *   Face hub cache (`$HF_HUB_CACHE`, else `$HF_HOME/hub`, else
 *   `~/.cache/huggingface/hub`).
 *
 * Hub revisions are pinned to commit hashes so counts are reproducible and a
 * cached snapshot is reused without any network request.
 */

/** OpenAI model ids accepted by the `openai` backend. */
export const OPENAI_MODEL_IDS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
] as const;

export type OpenAiModelId = (typeof OPENAI_MODEL_IDS)[number];

export type TokenizerSpec =
  | { kind: "openai"; model: OpenAiModelId; encoding: "o200k_base" }
  | { kind: "hf"; repo: string; revision: string };

export interface ModelEntry {
  /** Id the user passes to `--model`. */
  id: string;
  /** Human-readable model family, shown by `--list-models`. */
  family: string;
  tokenizer: TokenizerSpec;
  /** Whether the model is counted when `--model` is omitted. */
  isDefault: boolean;
}

const DEFAULT_OPENAI = new Set<OpenAiModelId>(["gpt-4o", "gpt-5"]);

const OPENAI_MODELS: ModelEntry[] = OPENAI_MODEL_IDS.map((id) => ({
  id,
  family: id.startsWith("gpt-4o") ? "GPT-4o" : "GPT-5",
  tokenizer: { kind: "openai", model: id, encoding: "o200k_base" },
  isDefault: DEFAULT_OPENAI.has(id),
}));

const HF_MODELS: ModelEntry[] = [
  {
    id: "deepseek-v3",
    family: "DeepSeek V3",
    tokenizer: {
      kind: "hf",
      repo: "deepseek-ai/DeepSeek-V3",
      revision: "e815299b0bcbac849fa540c768ef21845365c9eb",
    },
    isDefault: true,
  },
  {
    id: "deepseek-r1",
    family: "DeepSeek R1",
    tokenizer: {
      kind: "hf",
      repo: "deepseek-ai/DeepSeek-R1",
      revision: "56d4cbbb4d29f4355bab4b9a39ccb717a14ad5ad",
    },
    isDefault: true,
  },
  {
    // Every Qwen3 dense and MoE checkpoint ships the same tokenizer and chat
    // template; Qwen3-8B is used as the canonical source.
    id: "qwen3",
    family: "Qwen3",
    tokenizer: {
      kind: "hf",
      repo: "Qwen/Qwen3-8B",
      revision: "b968826d9c46dd6066d109eabc6255188de91218",
    },
    isDefault: true,
  },
];

export const MODELS: readonly ModelEntry[] = [...OPENAI_MODELS, ...HF_MODELS];

/** Short tokenizer description for output tables. */
export function tokenizerLabel(spec: TokenizerSpec): string {
  return spec.kind === "openai" ? spec.encoding : spec.repo;
}

/**
 * Resolve user-supplied model ids (case-insensitive) to registry entries,
 * preserving order and dropping duplicates. With no ids, returns the default
 * set. Throws listing every unknown id.
 */
export function resolveModels(ids: readonly string[] | undefined): ModelEntry[] {
  if (!ids || ids.length === 0) {
    return MODELS.filter((model) => model.isDefault);
  }

  const byId = new Map(MODELS.map((model) => [model.id, model]));
  const resolved: ModelEntry[] = [];
  const unknown: string[] = [];
  for (const raw of ids) {
    const model = byId.get(raw.trim().toLowerCase());
    if (!model) {
      unknown.push(raw);
    } else if (!resolved.includes(model)) {
      resolved.push(model);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `unknown model${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (see --list-models)`,
    );
  }
  return resolved;
}
