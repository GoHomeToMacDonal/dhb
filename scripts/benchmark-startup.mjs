#!/usr/bin/env node
/**
 * Startup benchmark for the built CLI.
 *
 * Spawns `node dist/cli.js --help` in a fresh process N times and reports the
 * median and P95 wall-clock startup cost. Requires a prior `pnpm build`.
 *
 * Usage: node scripts/benchmark-startup.mjs [runs]
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const RUNS = Math.max(1, Number.parseInt(process.argv[2] ?? "20", 10) || 20);

async function main() {
  try {
    await access(cliPath);
  } catch {
    console.error(`benchmark: built CLI not found at ${cliPath}. Run "pnpm build" first.`);
    process.exitCode = 1;
    return;
  }

  const samples = [];
  for (let i = 0; i < RUNS; i += 1) {
    samples.push(await timeOnce(cliPath));
  }

  samples.sort((a, b) => a - b);
  const median = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const min = samples[0];
  const max = samples[samples.length - 1];

  console.log(`dhb --help startup over ${RUNS} runs:`);
  console.log(`  min    ${min.toFixed(1)} ms`);
  console.log(`  median ${median.toFixed(1)} ms`);
  console.log(`  p95    ${p95.toFixed(1)} ms`);
  console.log(`  max    ${max.toFixed(1)} ms`);
}

function timeOnce(cli) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [cli, "--help"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", () => {
      const end = process.hrtime.bigint();
      resolve(Number(end - start) / 1e6);
    });
  });
}

/** Linear-interpolation percentile over a pre-sorted ascending array. */
function percentile(sorted, p) {
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) {
    return sorted[lo];
  }
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

await main();
