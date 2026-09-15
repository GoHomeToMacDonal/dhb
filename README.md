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
