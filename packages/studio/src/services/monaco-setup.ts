/** Monaco editor setup — workers, language contributions, and JX schema registration. */

// @ts-expect-error — Monaco ESM contribution has no type declarations for named exports
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";

import jxSchema from "@jxsuite/schema/schema.json";
import projectSchema from "@jxsuite/schema/project-schema.json";

const WORKER_PATHS: Record<string, string> = {
  json: "/monaco-editor/esm/vs/language/json/json.worker.js",
  typescript: "/monaco-editor/esm/vs/language/typescript/ts.worker.js",
  javascript: "/monaco-editor/esm/vs/language/typescript/ts.worker.js",
  editorWorkerService: "/monaco-editor/esm/vs/editor/editor.worker.js",
};

self.MonacoEnvironment = {
  getWorker(_, label: string) {
    const path = WORKER_PATHS[label] || WORKER_PATHS.editorWorkerService;
    return new Worker(path, { type: "module" });
  },
};

jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  schemas: [
    {
      uri: "https://jxsuite.com/schema/v1",
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
    },
    {
      uri: "https://jxsuite.com/schema/project/v1",
      fileMatch: ["project.json"],
      schema: projectSchema,
    },
  ],
});
