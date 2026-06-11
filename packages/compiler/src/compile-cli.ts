#!/usr/bin/env node
import { runCli } from "./compiler.ts";

const [src, out] = process.argv.slice(2);
if (src) {
  try {
    await runCli(src, out);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
