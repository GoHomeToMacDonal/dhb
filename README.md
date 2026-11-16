# dhb

A modular command-line tool built with TypeScript, Node.js ESM, and
[Commander](https://github.com/tj/commander.js). The root entry only creates and
runs the CLI; subcommands live as standalone modules under `src/commands` and are
registered automatically through file discovery.

Requires **Node.js >= 24** and **pnpm 10.33.3**.

## Commands

- `hello [name]` — print a greeting; used to verify command loading and argument
  passing.
- `commit` — read the git staging area, run a DeepSeek agent to generate and make
  a single commit, then print the final commit message. _(in progress)_
- `tokens [file]` — count how many tokens a text or a JSON chat conversation
  costs under GPT-4o/5, DeepSeek V3/R1 and Qwen3 tokenizers.

## Development

```bash
pnpm install       # install dependencies
pnpm dev -- <args> # run the CLI from TypeScript source, e.g. pnpm dev -- hello
pnpm test          # Vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # ESLint
pnpm format        # Prettier check
pnpm build         # emit dist/
pnpm check         # format + lint + typecheck + test + build
```

The source uses `.ts` import specifiers together with TypeScript's
`rewriteRelativeImportExtensions`, so `node src/cli.ts` runs directly against
source while `pnpm build` rewrites the extensions to `.js` in `dist/`.

## The `commit` command

`dhb commit` reads the git staging area and runs a DeepSeek agent to generate
and make a single commit:

1. Confirms the current directory is inside a git working tree and that the
   staged diff is non-empty (argv-only git calls, no shell).
2. Lazily loads the agent runtime so help commands stay fast.
3. The agent inspects the staged diff, recent history, and any files it needs
   through a narrow set of read-mostly git tools, then makes exactly one commit
   in Conventional Commits style.
4. The final message is written to stdout; run logs go to stderr with secrets
   redacted.

Only staged content is committed. Unstaged and untracked changes are shown for
context but never committed.

### Credentials

The agent reads its DeepSeek API key from a credentials file:

```text
$DSH_HOME/.credentials.yaml      # when DSH_HOME is set
~/.dsh/.credentials.yaml         # otherwise
```

The file must be a regular file (not a symlink) with owner-only permissions
(`chmod 600`) and this shape:

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-your-key-here
```

The key is read only from this file — there is no environment-variable fallback.

## The `tokens` command

`dhb tokens` counts tokens locally with pure-JavaScript tokenizers. It needs no
Python and no API key.

```bash
dhb tokens notes.md                      # default models
cat notes.md | dhb tokens -m gpt-5,qwen3 # stdin; comma-separated, repeatable -m
dhb tokens --chat request.json --json    # chat mode, JSON output
dhb tokens --list-models
```

| Models                                                      | Tokenizer                                                |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `gpt-4o`, `gpt-4o-mini`, `gpt-5`, `gpt-5-mini`, … `gpt-5.5` | `o200k_base` via `gpt-tokenizer`, bundled, works offline |
| `deepseek-v3`, `deepseek-r1`, `qwen3`                       | `tokenizer.json` from the Hugging Face Hub               |

Without `-m`, it counts `gpt-4o`, `gpt-5`, `deepseek-v3`, `deepseek-r1` and
`qwen3`.

**Text mode** (default) tokenizes the input as-is and adds no special tokens.

**Chat mode** (`--chat`) requires JSON input: either an array of messages or an
OpenAI-style object with a `messages` array. Each message needs a string `role`
and a string `content`. The model's chat template is applied with the assistant
generation prompt, so the count includes role markers and special tokens the way
a request is billed. GPT models use ChatML framing; Hub models render their own
`chat_template` from `tokenizer_config.json`.

```json
{
  "messages": [
    { "role": "system", "content": "Be brief." },
    { "role": "user", "content": "Hi" }
  ]
}
```

Hub tokenizers are downloaded on first use into the standard Hugging Face cache
(`$HF_HUB_CACHE`, else `$HF_HOME/hub`, else `~/.cache/huggingface/hub`) and
reused offline afterwards. Revisions are pinned to commit hashes, so counts are
reproducible. Set `HF_ENDPOINT` to use a mirror (for example
`HF_ENDPOINT=https://hf-mirror.com`). Downloads use a plain `GET` on the
`resolve` URL, so any mirror or proxy that serves files works, and every file is
checked against a pinned SHA-256 before it is cached. Download notices go to
stderr, so `--json` output on stdout stays clean.

## Scripts

```bash
pnpm pack:smoke   # pack a tarball, install it in a temp consumer, verify the
                  # real dhb binary's --help / --version / hello
pnpm bench:start  # sample dhb --help startup time (median + p95) over 20 runs
```

## Packaging

`package.json` exposes `dist/cli.js` as the `dhb` binary and publishes only
`dist` and `README.md`. `prepack` runs the build, so the published package never
contains `src` or `tests`. After a build you can link it globally with
`pnpm link --global` and use `dhb` directly.

## Adding a command

Create a non-reserved `.ts` file in `src/commands` that exports
`createCommand(context)` returning a Commander `Command`:

```ts
import { Command } from "commander";
import type { CommandContext } from "../command-module.ts";

export function createCommand(context: CommandContext): Command {
  return new Command("status").description("Show status").action(() => {
    context.writeOut("ok\n");
  });
}
```

No changes to the root entry or a registry are needed. Keep command modules
lightweight; load heavy runtimes inside the action via dynamic `import()` so
`dhb --help` stays fast.
