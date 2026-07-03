/** Monaco editor setup — workers, language contributions, and JX schema registration. */

// @ts-expect-error — Monaco ESM contribution has no type declarations for named exports
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";

import jxSchema from "@jxsuite/schema/schema.json";
import projectSchema from "@jxsuite/schema/project-schema.json";

const WORKER_PATHS: Record<string, string> = {
  editorWorkerService: "/monaco-editor/esm/vs/editor/editor.worker.js",
  javascript: "/monaco-editor/esm/vs/language/typescript/ts.worker.js",
  json: "/monaco-editor/esm/vs/language/json/json.worker.js",
  typescript: "/monaco-editor/esm/vs/language/typescript/ts.worker.js",
};

self.MonacoEnvironment = {
  getWorker(_, label: string) {
    const path = WORKER_PATHS[label] || WORKER_PATHS.editorWorkerService!;
    return new Worker(path, { type: "module" });
  },
};

/* Monaco caches glyph widths when an editor is created. JetBrains Mono is a
   vendored webfont (index.html @font-face) and may finish loading after the
   first editor mounts, so remeasure once all document fonts are ready to keep
   cursor and selection alignment correct. */
if (typeof document !== "undefined" && document.fonts?.ready) {
  // oxlint-disable-next-line unicorn/prefer-top-level-await -- fire-and-forget: awaiting fonts.ready at top level would block module evaluation (and studio startup) until webfonts load
  void document.fonts.ready.then(async () => {
    const monaco = await import("monaco-editor/esm/vs/editor/editor.api.js");
    monaco.editor.remeasureFonts();
  });
}

// oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access -- jsonDefaults is imported from Monaco's untyped ESM contribution (see @ts-expect-error above); no type declarations exist for this named export
jsonDefaults.setDiagnosticsOptions({
  allowComments: false,
  schemas: [
    {
      fileMatch: [
        "pages/*.json",
        "pages/**/*.json",
        "layouts/*.json",
        "layouts/**/*.json",
        "components/*.json",
        "components/**/*.json",
        "elements/*.json",
        "elements/**/*.json",
      ],
      schema: jxSchema,
      uri: "https://jxsuite.com/schema/v1",
    },
    {
      fileMatch: ["project.json"],
      schema: projectSchema,
      uri: "https://jxsuite.com/schema/project/v1",
    },
  ],
  validate: true,
});
