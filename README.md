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
