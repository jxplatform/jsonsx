import Electrobun from "electrobun/bun";
import { setDirectoryDialog, setFileDialog } from "./project-session";
import { setNotifyWebview, startBackgroundChecks } from "./updater";
import { init as initUtils, openDirectoryDialog, openFileDialog } from "./utils";
import { handleAiApi } from "@jxsuite/server/ai-api";
import { installApplicationMenu } from "./menu";
import {
  broadcastUpdateReady,
  openProjectWindow,
  parseProjectDirFromUrl,
  setAiServerUrl,
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

  // AI HTTP server (SSE streaming requires HTTP). A single shared server: AI sessions are id-keyed
  // And process-global, so the server resolves requests by id and needs no fixed project root
  // (session creation flows through per-window RPC, which supplies the window's own root).
  const aiServer = Bun.serve({
    async fetch(req) {
      const url = new URL(req.url);
      const aiResponse = await handleAiApi(req, url);
      if (aiResponse) {
        return aiResponse;
      }
      return new Response("Not Found", { status: 404 });
    },
    port: 0,
  });

  setAiServerUrl(`http://localhost:${aiServer.port}`);

  installApplicationMenu();

  startBackgroundChecks();
  setNotifyWebview((version) => broadcastUpdateReady(version));

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
