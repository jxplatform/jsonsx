#!/usr/bin/env node
import { runCli } from "./compiler.ts";

const [, , src, out] = process.argv;
if (src) {
  runCli(src, out).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
