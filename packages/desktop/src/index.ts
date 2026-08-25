import Electrobun from "electrobun/main";
import { isAbsolute } from "node:path";
import { setDirectoryDialog, setFileDialog } from "./project-session";
import { setNotifyWebview, startBackgroundChecks } from "./updater";
import { init as initUtils, openDirectoryDialog, openFileDialog } from "./utils";
import { handleAiApi } from "@jxsuite/server/ai-api";
import { handleImportApi } from "@jxsuite/server/import-api";
import { installApplicationMenu } from "./menu";
import { watchSettings } from "./settings-store";
import {
  broadcastSettingsChanged,
  broadcastUpdateReady,
  openProjectWindow,
  parseProjectDirFromUrl,
  setAiServerUrl,
  setImportServiceUrl,
} from "./window-manager";

// ─── App-level services (shared across all windows) ──────────────────────────
// The boot sequence lives in an async function rather than top-level `await`: as an entry module
// Nothing imports its completion, and a top-level await is dropped by Bun's test runtime when the
// Module is pulled in via dynamic `import()` (the continuation after the await never resumes on
// Windows), which makes the boot effects untestable. `ready` lets tests await the same sequence.

async function main() {
  await initUtils();
  setFileDialog(openFileDialog);
  setDirectoryDialog(openDirectoryDialog);

  // Shared services HTTP server (SSE/NDJSON streaming requires HTTP), loopback-bound. AI sessions
  // Are id-keyed and process-global, so the server resolves requests by id and needs no fixed
  // Project root (session creation flows through per-window RPC, which supplies the window's own
  // Root). The import route writes to the filesystem, so it is additionally gated by a per-process
  // Random token handed to webviews over RPC.
  const importToken = crypto.randomUUID();
  const aiServer = Bun.serve({
    hostname: "127.0.0.1",
    // Imports stream for minutes with heartbeats every 15s; match the dev server's generous timeout.
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const aiResponse = await handleAiApi(req, url);
      if (aiResponse) {
        return aiResponse;
      }
      if (url.pathname === "/__studio/import-site") {
        if (url.searchParams.get("token") !== importToken) {
          return new Response("Forbidden", { status: 403 });
        }
        const importResponse = await handleImportApi(req, url, {
          resolveDest: (dir) => {
            // The webview resolves the destination under a natively-picked parent before posting.
            if (!isAbsolute(dir)) {
              throw new Error("directory must be an absolute path");
            }
            return dir;
          },
        });
        if (importResponse) {
          return importResponse;
        }
      }
      return new Response("Not Found", { status: 404 });
    },
    port: 0,
  });

  setAiServerUrl(`http://localhost:${aiServer.port}`);
  setImportServiceUrl(
    `http://127.0.0.1:${aiServer.port}/__studio/import-site?token=${importToken}`,
  );

  installApplicationMenu();

  startBackgroundChecks();
  setNotifyWebview((version) => broadcastUpdateReady(version));

  /* User settings are one file shared by every window and, on a machine running both
     launchers, by both. Watching it is what lets a change made in one window reach the
     others without a restart. */
  watchSettings(broadcastSettingsChanged);

  // ─── Initial window ────────────────────────────────────────────────────────
  // A project root from argv (CLI / file association) or JSONSX_PROJECT_ROOT opens that project; a
  // Bare launch opens a welcome window (the frontend shows the welcome screen when no project loads).

  const initialRoot = process.argv[2] || process.env.JSONSX_PROJECT_ROOT || null;
  openProjectWindow(initialRoot);

  // ─── File associations (open-url) ──────────────────────────────────────────
  // Double-clicking a project.json opens it in a new window (dedupe-focus if already open).

  Electrobun.events.on("open-url", (e: { data: { url: string } }) => {
    const dir = parseProjectDirFromUrl(e.data.url);
    if (dir) {
      openProjectWindow(dir);
    }
  });
}

// Intentional non-top-level-await: a top-level await here is dropped by Bun's test runtime when this
// Module is pulled in via dynamic import (the continuation after the await never resumes), which is
// Why the boot lives in main(). `ready` lets callers (tests) await the same sequence.
// oxlint-disable-next-line unicorn/prefer-top-level-await
export const ready = main();
