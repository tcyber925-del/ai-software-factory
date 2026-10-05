#!/usr/bin/env node
/**
 * `factory` entry point.
 *
 * Thin by design: it parses argv, dispatches to a command, prints lines, and sets
 * an exit code. It holds no policy of its own — it cannot declare a run
 * successful and cannot skip verification.
 */
import { dispatch } from "./cli/index.js";

const lines = process.argv.slice(2);
const result = await dispatch(lines, { cwd: process.cwd() });
for (const line of result.lines) console.log(line);
process.exit(result.exitCode);
