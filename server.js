/**
 * Server.js — Jx development server
 *
 * Run with: bun run dev
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDevServer } from "@jxsuite/server";
import { buildMonacoWorkers } from "./packages/studio/scripts/build-workers.ts";
import { STUDIO_ENTRYPOINTS, studioBundleOptions } from "./packages/studio/scripts/build-config.ts";

// The dev server rebuilds studio.js on change but not Monaco's workers, which monaco-setup.ts
// Loads from packages/studio/dist/workers. Build them once at startup so a fresh checkout gets
// JSON schema validation in the code view without a prior `bun run build`.
await buildMonacoWorkers();

/**
 * One build entry PER studio entrypoint, each carrying the shared bundler contract.
 *
 * Both details matter. Separate entries because a single multi-entry build roots its output at the
 * entrypoints' common ancestor (`src/`), nesting the iframe bundle under `dist/canvas/` and
 * breaking `canvas.html`'s flat `./dist/iframe-entry.js` import. The shared contract because this
 * watcher OVERWRITES whatever `bun run build` produced — so without it, `bun run dev` served an
 * 18.8 MB bundle with Monaco in it twice, and no amount of building fixed what you actually
 * loaded.
 */
function studioBuildEntries() {
  const entries = [];
  for (const entry of STUDIO_ENTRYPOINTS) {
    const relative = entry.replace(/^\.\//, "");
    entries.push({
      ...studioBundleOptions,
      entrypoints: [`./packages/studio/${relative}`],
      label: relative.includes("iframe-entry") ? "studio:iframe" : "studio",
      match: /studio/,
      outdir: "./packages/studio/dist",
    });
  }
  return entries;
}

await createDevServer({
  builds: [
    {
      entrypoints: ["./packages/runtime/src/runtime.js"],
      label: "runtime",
      match: /runtime\.js/,
      outdir: "./packages/runtime/dist",
    },
    ...studioBuildEntries(),
  ],
  port: Number(process.env.JX_DEV_PORT ?? 3000),
  root: resolve(import.meta.dir, "."),
});

/**
 * The example routes are READ OFF DISK, never listed here.
 *
 * A hardcoded list is a promise this server cannot keep. The previous one advertised
 * `/examples/todo/` and six friends long after the project moved its pages to
 * `pages/basics/todo.json` — the live route is `/examples/dist/basics/todo/`, so every advertised
 * one 404'd. Scanning the build output says only what is actually served.
 *
 * `builds` above covers the runtime and the Studio entrypoints only, so nothing here ever produces
 * `examples/dist` — `bun run --cwd examples build` does, and the directory is gitignored. On a
 * fresh checkout the scan is therefore empty, which is the truth worth printing.
 */
function exampleRoutes() {
  const dist = resolve(import.meta.dir, "examples/dist");
  if (!existsSync(dist)) {
    return [];
  }
  return [...new Bun.Glob("**/index.html").scanSync(dist)]
    .map((file) => `/examples/dist/${file.slice(0, -"index.html".length)}`)
    .toSorted();
}

console.log("  /packages/studio/index.html     ← Jx Studio");
const routes = exampleRoutes();
if (routes.length === 0) {
  console.log("  /examples/dist/                 ← empty; run `bun run --cwd examples build`");
} else {
  for (const route of routes) {
    console.log(`  ${route}`);
  }
}
