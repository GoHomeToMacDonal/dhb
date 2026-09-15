#!/usr/bin/env node
import { runCli } from "./app.ts";

const exitCode = await runCli();
process.exitCode = exitCode;
