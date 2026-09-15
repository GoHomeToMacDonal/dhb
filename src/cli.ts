#!/usr/bin/env node
import { runCli } from "./app.ts";

const exitCode = await runCli();

// A command action may have already signalled failure via `process.exitCode`
// (e.g. an unmet precondition). Only escalate to the CLI-level code; never
// downgrade an existing non-zero exit code back to success.
if (exitCode !== 0) {
  process.exitCode = exitCode;
} else if (process.exitCode === undefined || process.exitCode === 0) {
  process.exitCode = 0;
}
