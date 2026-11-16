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
 * cached snapshot is reused without any network request. Each file's SHA-256
 * is pinned too and verified after download, so a mirror cannot serve
 * different content.
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

/** A pinned Hub file: cache blob id (the Hub ETag) and content SHA-256. */
export interface PinnedFile {
  etag: string;
  sha256: string;
}

export type TokenizerSpec =
  | { kind: "openai"; model: OpenAiModelId; encoding: "o200k_base" }
  | {
      kind: "hf";
      repo: string;
      revision: string;
      files: { tokenizer: PinnedFile; config: PinnedFile };
    };

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
      files: {
        tokenizer: {
          etag: "51083c600ec00c7f57ae1af7fef7108c52ce7376",
          sha256: "621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41",
        },
        config: {
          etag: "3ef38058ece03201b9af6baf99b28f16a020ad64",
          sha256: "637bcd1a08cf7c772ce6a383196b22930921c79c3c73223c5afc0c7f41545546",
        },
      },
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
      files: {
        tokenizer: {
          etag: "d81c3a6e2093a07ae6fa596d9b154f6669aafafd",
          sha256: "ecb6f9fc369894346f0511f4074ca75cee5cd5f3b06d02f1ba35fcd39f8e121d",
        },
        config: {
          etag: "d87fcc88d8d23b1d83c2ef0cc966fbf07da1f239",
          sha256: "99e80c96269ca4430f1e67f67b5766cb096cbac96fed7a7c611c6ee088b3a039",
        },
      },
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
      files: {
        tokenizer: {
          etag: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
          sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
        },
        config: {
          etag: "417d038a63fa3de29cfde265caedae14d1a58d92",
          sha256: "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101",
        },
      },
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
