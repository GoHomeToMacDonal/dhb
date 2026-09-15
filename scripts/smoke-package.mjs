#!/usr/bin/env node
/**
 * Packaging smoke test.
 *
 * Packs the project into a tarball (`pnpm pack`, which runs `prepack` -> build),
 * installs that tarball into a throwaway consumer project, and exercises the
 * real published `dhb` binary: `--help`, `--version`, and `hello`. This proves
 * the shipped `dist` + `bin` wiring works the way an end user would experience
 * it, not just the source tree.
 *
 * Usage: node scripts/smoke-package.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(`smoke: ${message}`);
  }
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), "dhb-smoke-"));
  const consumerDir = join(workDir, "consumer");

  try {
    // 1. Pack the tarball into the work dir (prepack builds dist automatically).
    console.log("smoke: packing tarball (runs prepack -> build)...");
    const pack = run("pnpm", ["pack", "--pack-destination", workDir], { cwd: repoRoot });
    expect(pack.status === 0, `pnpm pack failed:\n${pack.stderr}`);

    const entries = await readdir(workDir);
    const tarball = entries.find((name) => name.endsWith(".tgz"));
    expect(Boolean(tarball), "no .tgz tarball produced by pnpm pack");
    const tarballPath = join(workDir, tarball);
    console.log(`smoke: created ${tarball}`);

    // 2. Create a minimal consumer project and install the tarball.
    console.log("smoke: installing tarball into a fresh consumer project...");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      join(consumerDir, "package.json"),
      `${JSON.stringify(
        { name: "dhb-smoke-consumer", version: "1.0.0", private: true, type: "module" },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const install = run("npm", ["install", "--no-audit", "--no-fund", tarballPath], {
      cwd: consumerDir,
    });
    expect(install.status === 0, `npm install failed:\n${install.stderr}`);

    const binPath = join(consumerDir, "node_modules", ".bin", "dhb");

    // 3. Exercise the installed binary.
    console.log("smoke: dhb --version");
    const version = run(binPath, ["--version"], { cwd: consumerDir });
    expect(version.status === 0, `dhb --version exited ${version.status}:\n${version.stderr}`);
    expect(
      /\d+\.\d+\.\d+/.test(version.stdout),
      `dhb --version did not print a semver: ${JSON.stringify(version.stdout)}`,
    );
    console.log(`  -> ${version.stdout.trim()}`);

    console.log("smoke: dhb --help");
    const help = run(binPath, ["--help"], { cwd: consumerDir });
    expect(help.status === 0, `dhb --help exited ${help.status}:\n${help.stderr}`);
    expect(help.stdout.includes("Usage: dhb"), "dhb --help missing usage banner");
    expect(help.stdout.includes("hello"), "dhb --help missing hello command");
    expect(help.stdout.includes("commit"), "dhb --help missing commit command");

    console.log("smoke: dhb hello Kiro");
    const hello = run(binPath, ["hello", "Kiro"], { cwd: consumerDir });
    expect(hello.status === 0, `dhb hello exited ${hello.status}:\n${hello.stderr}`);
    expect(
      hello.stdout.trim() === "Hello, Kiro!",
      `unexpected hello output: ${JSON.stringify(hello.stdout)}`,
    );
    console.log(`  -> ${hello.stdout.trim()}`);

    console.log("\nsmoke: PASS");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
