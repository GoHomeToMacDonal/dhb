import { open } from "node:fs/promises";
import { Command } from "commander";
import type { CommandContext } from "../command-module.ts";
import { type TokenInput, parseChatInput } from "../tokens/input.ts";
import { MODELS, resolveModels, tokenizerLabel } from "../tokens/registry.ts";

/** Inputs larger than this are rejected rather than tokenized in memory. */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;

interface TokensOptions {
  model?: string[];
  chat?: boolean;
  json?: boolean;
  listModels?: boolean;
}

/**
 * `dhb tokens [file]` — count how many tokens a text (or, with `--chat`, a
 * JSON conversation) costs under different models' tokenizers.
 *
 * Only the lightweight model registry is imported eagerly; the tokenizer
 * libraries load inside the action so `dhb --help` stays fast.
 */
export function createCommand(context: CommandContext): Command {
  return new Command("tokens")
    .description("Count tokens for text or a chat conversation under different models")
    .argument("[file]", 'input file; reads stdin when omitted or "-"')
    .option(
      "-m, --model <ids>",
      "comma-separated model ids, repeatable (default: gpt-4o, gpt-5, deepseek-v3, deepseek-r1, qwen3)",
      collectModels,
    )
    .option(
      "--chat",
      'treat input as JSON chat messages ([{"role","content"}] or {"messages":[...]}) and apply each model\'s chat template',
    )
    .option("--json", "print results as JSON")
    .option("--list-models", "list supported models and exit")
    .action(async (file: string | undefined, options: TokensOptions) => {
      try {
        await runTokens(context, file, options);
      } catch (error) {
        context.writeErr(`dhb tokens: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
}

function collectModels(value: string, previous: string[] | undefined): string[] {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return [...(previous ?? []), ...ids];
}

async function runTokens(
  context: CommandContext,
  file: string | undefined,
  options: TokensOptions,
): Promise<void> {
  if (options.listModels) {
    writeModelList(context, options.json === true);
    return;
  }

  // Validate model ids before reading input so typos fail fast.
  const models = resolveModels(options.model);
  const raw = await readInput(file);
  const input: TokenInput = options.chat
    ? { kind: "chat", messages: parseChatInput(raw) }
    : { kind: "text", text: raw };

  const { countTokens } = await import("../tokens/count.ts");
  const results = await countTokens(models, input, { log: context.writeErr });

  if (options.json) {
    const summary =
      input.kind === "text"
        ? { mode: "text", characters: [...input.text].length }
        : { mode: "chat", messages: input.messages.length };
    context.writeOut(`${JSON.stringify({ ...summary, results }, null, 2)}\n`);
  } else {
    context.writeOut(
      input.kind === "text"
        ? `Input: ${[...input.text].length} characters (text)\n\n`
        : `Input: ${input.messages.length} message${input.messages.length === 1 ? "" : "s"} (chat template applied)\n\n`,
    );
    context.writeOut(
      formatTable(
        ["MODEL", "TOKENIZER", "TOKENS"],
        results.map((r) => [r.model, r.tokenizer, "tokens" in r ? String(r.tokens) : "error"]),
        [false, false, true],
      ),
    );
  }

  for (const result of results) {
    if ("error" in result) {
      context.writeErr(`dhb tokens: ${result.model}: ${result.error}\n`);
      process.exitCode = 1;
    }
  }
}

function writeModelList(context: CommandContext, json: boolean): void {
  if (json) {
    const list = MODELS.map((m) => ({
      id: m.id,
      family: m.family,
      tokenizer: tokenizerLabel(m.tokenizer),
      default: m.isDefault,
    }));
    context.writeOut(`${JSON.stringify(list, null, 2)}\n`);
    return;
  }
  context.writeOut(
    formatTable(
      ["MODEL", "FAMILY", "TOKENIZER", "DEFAULT"],
      MODELS.map((m) => [m.id, m.family, tokenizerLabel(m.tokenizer), m.isDefault ? "yes" : ""]),
      [false, false, false, false],
    ),
  );
}

/** Read the whole input as UTF-8 from a file, or stdin for `undefined`/`-`. */
async function readInput(file: string | undefined): Promise<string> {
  if (file === undefined || file === "-") {
    if (process.stdin.isTTY) {
      throw new Error("no input: pass a file or pipe text on stdin");
    }
    return readLimited(process.stdin, "stdin");
  }

  const handle = await open(file, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`${file} is not a regular file`);
    }
    if (stats.size > MAX_INPUT_BYTES) {
      throw new Error(`${file} is larger than ${MAX_INPUT_BYTES} bytes`);
    }
    return await readLimited(handle.createReadStream({ autoClose: false }), file);
  } finally {
    await handle.close();
  }
}

async function readLimited(stream: AsyncIterable<Buffer | string>, name: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) {
      throw new Error(`${name} is larger than ${MAX_INPUT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formatTable(headers: string[], rows: string[][], rightAlign: boolean[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => {
        const width = widths[column] ?? 0;
        return rightAlign[column] ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();
  return `${[headers, ...rows].map(line).join("\n")}\n`;
}
