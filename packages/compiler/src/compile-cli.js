#!/usr/bin/env node
import { runCli } from "./compiler.js";

const [, , src, out] = process.argv;
if (src) {
  runCli(src, out).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
