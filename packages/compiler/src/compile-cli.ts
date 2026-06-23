#!/usr/bin/env node
import { runCli } from "./compiler.ts";

// Body wrapped in an async function rather than a top-level await: Bun's test runtime drops the
// Continuation after a dynamically-imported module's top-level await (it never resumes on Windows),
// Which would skip the error handling. `ready` lets the in-process CLI harness await the sequence.
async function main() {
  const [src, out] = process.argv.slice(2);
  if (src) {
    try {
      await runCli(src, out);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }
}

// oxlint-disable-next-line unicorn/prefer-top-level-await
export const ready = main();
