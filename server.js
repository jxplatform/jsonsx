/**
 * Server.js — Jx development server
 *
 * Run with: bun run dev
 */

import { resolve } from "node:path";
import { createDevServer } from "@jxsuite/server";
import { buildMonacoWorkers } from "./packages/studio/scripts/build-workers.ts";

// The dev server rebuilds studio.js on change but not Monaco's workers, which monaco-setup.ts
// Loads from packages/studio/dist/workers. Build them once at startup so a fresh checkout gets
// JSON schema validation in the code view without a prior `bun run build`.
await buildMonacoWorkers();

await createDevServer({
  builds: [
    {
      entrypoints: ["./packages/runtime/src/runtime.js"],
      label: "runtime",
      match: /runtime\.js/,
      outdir: "./packages/runtime/dist",
    },
    {
      entrypoints: [
        "./packages/studio/src/studio.js",
        "./packages/studio/src/canvas/iframe-entry.js",
      ],
      label: "studio",
      match: /studio/,
      outdir: "./packages/studio/dist",
    },
  ],
  port: 3000,
  root: resolve(import.meta.dir, "."),
});

console.log("  /packages/studio/index.html     ← Jx Studio");
console.log("  /examples/todo/");
console.log("  /examples/counter/");
console.log("  /examples/computed/");
console.log("  /examples/list/");
console.log("  /examples/fetch/");
console.log("  /examples/form/");
console.log("  /examples/switch/");
