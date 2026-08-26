/**
 * Ai-import-tools.ts — `import_site`, the assistant's other way to bootstrap a project.
 *
 * A sibling of `create_project` (`ai-project-tools.ts`) with a different backend: it drives the
 * headless-Chrome pipeline behind `POST /__studio/import-site`, streams its progress into a record
 * the transcript draws, and then adopts the result exactly as a scaffold is adopted. Its own module
 * rather than an eighth tool in `ai-project-tools.ts`, which is already 650 lines under a per-file
 * coverage bar.
 *
 * Two things it does NOT do are the point:
 *
 * - **It does not invent a destination.** `create_project` requires the model to supply `location`
 *   and refuses without one — correct when a bare chat bootstraps a project, a regression on the
 *   wizard path where the Location field already has a folder picker, validation and a live preview.
 *   The destination comes from the pending brief; a model-supplied one must match it.
 * - **It does not decide what the crawl found.** The pipeline is one-way: it reports and finishes.
 *   Everything worth a human's opinion — which skipped pages matter, whether the components it
 *   extracted are really components — is in the summary for the model to raise with `ask_user`
 *   AFTERWARDS, against real numbers rather than a guess made before the browser launched.
 *
 * @license MIT
 */

import { createToolDefinition, toolError, toolSuccess } from "@jxsuite/ai/tools";
import { getPlatform } from "../platform";
import { workspace } from "../workspace/workspace";
import { getBaseUrl, getOpenAiKey } from "./ai-settings";
import { preferredModel } from "./ai-models";
import { clearPendingImportBrief, pendingImportBrief } from "./import-seed";
import {
  abortImportRun,
  beginImportRun,
  finishImportRun,
  importRun,
  recordImportProgress,
} from "./import-run";
import { adoptCreatedProject } from "./project-adoption";
import { currentToolCallId, turnSignal } from "./ai-turn-signal";

import type { ToolRegistry } from "@jxsuite/ai/tools";
import type { Tab } from "../tabs/tab";
import type { ImportSiteSummary } from "../types";

/** The same bounds `packages/server/src/import-api.ts` clamps to. */
const MAX_DEPTH = 5;
const MAX_PAGES = 100;

/** Log lines quoted back on a hard failure — enough to see WHICH phase died. */
const FAILURE_TAIL = 5;

/** Low-fidelity pages named in the summary. A list of twenty is a wall, not a finding. */
const WEAKEST_PAGES = 3;

/** Below this, a page is worth naming. Above it, "close enough" is the honest reading. */
const WEAK_FIDELITY = 90;

export interface ImportToolsCtx {
  /** The active tab, read AFTER adoption to re-anchor the agent loop's undo batch. */
  getTab: () => Tab | null;
  /** Open the imported project in this window. Defaults to the late-bound adopter. */
  adoptProject?: (root: string) => Promise<void>;
  /** Fired once adoption is VERIFIED — the session store re-keys the live chat here. */
  onProjectAdopted?: (root: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Absolute on POSIX or Windows — the test `create_project` already applies to its `location`. */
function isAbsolutePath(path: string): boolean {
  return /^(?:[a-zA-Z]:[/\\]|\/)/.test(path);
}

/**
 * One run has already succeeded in this session.
 *
 * Not the same question as `workspace.projectRoot`, and that is the whole reason it exists: on
 * desktop, adoption may open the project in ANOTHER window, leaving this one's root empty — so the
 * `no-project` tier would happily advertise a second import over the top of the first.
 * `create_project` has the identical hazard today.
 */
let imported = false;

/** Forget that an import ran. New Chat, and tests. */
export function resetImportGuard(): void {
  imported = false;
}

/**
 * A compact, factual account of the run for the model to reason about — and to ask about.
 *
 * Counts only where they are real. `streamImport` returns `{ root, config }` and nothing else, so
 * the page and file totals are not available here; inventing them from log prose is exactly how a
 * confidently wrong number gets into a summary. It says what it knows and points at the tool that
 * knows the rest.
 */
function describeRun(id: string, root: string, summary?: ImportSiteSummary): string {
  const record = importRun(id);
  const warnings = [...(record?.warnings ?? []), ...(summary?.warnings ?? [])];
  const lines = [`Imported ${record?.url ?? "the site"} into ${root} and opened it.`];

  const pages = summary?.pages ?? [];
  if (pages.length > 0) {
    lines.push(
      `${pages.length} page${pages.length === 1 ? "" : "s"}` +
        `${summary?.fileCount ? `, ${summary.fileCount} files` : ""}: ` +
        `${pages.map((p) => p.route).join(", ")}.`,
    );
  }

  /* Per page, because the average cannot name one. "84% average" is a fact nobody can act on;
     "the pricing page renders at 61%" is a decision — and it is the one finding here worth
     interrupting a person for. */
  if (summary?.verify) {
    const weakest = (summary.verify.pages ?? [])
      .filter((p) => p.fidelity < WEAK_FIDELITY)
      .toSorted((a, b) => a.fidelity - b.fidelity)
      .slice(0, WEAKEST_PAGES);
    const detail =
      weakest.length > 0
        ? `; weakest: ${weakest.map((p) => `${p.route} at ${p.fidelity}%`).join(", ")}.`
        : " on every page.";
    lines.push(
      `Fidelity against the original averaged ${summary.verify.averageFidelity}%${detail}`,
    );
  }

  if (warnings.length > 0) {
    lines.push(
      `${warnings.length} warning${warnings.length === 1 ? "" : "s"} during the run: ` +
        `${warnings.join("; ")}.`,
    );
  }
  lines.push(
    "The file and document tools are available now. Read the emitted pages, layouts and " +
      "components before proposing changes — then ask the user about anything the import had to " +
      "guess at (pages it skipped, components it may have split wrongly, a layout it did not find, " +
      "a page that did not render faithfully).",
  );
  return lines.join(" ");
}

/**
 * Register `import_site`.
 *
 * @param {Pick<ToolRegistry, "register">} registry
 * @param {ImportToolsCtx} ctx
 */
export function registerImportTools(
  registry: Pick<ToolRegistry, "register">,
  { getTab, adoptProject, onProjectAdopted }: ImportToolsCtx,
): void {
  registry.register(
    createToolDefinition({
      name: "import_site",
      description:
        "Clone a live website into a new Jx project and open it in the studio: pages, styles, " +
        "assets, a shared layout and recurring components. Only available while no project is " +
        "open. Progress streams into the conversation as it runs. When the user reached you " +
        "through the New Project Import form, the URL, crawl options and destination are already " +
        "settled — call this with the url alone and the rest is filled in. After it succeeds the " +
        "file and document tools become available in the next round.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The site to clone. Must be http(s)." },
          directory: {
            type: "string",
            description:
              "Absolute destination folder. Omit it when an import was started from the New " +
              "Project form — that destination is the one the user chose, and it wins.",
          },
          depth: {
            type: "number",
            description:
              "Crawl depth. 0 imports the single page and runs an entirely different, much faster " +
              "pipeline — no crawl, no shared-layout detection. Default 1.",
          },
          maxPages: { type: "number", description: "Most pages to capture (1–100). Default 20." },
          verify: {
            type: "boolean",
            description:
              "Build the imported project and screenshot-diff every page against the original, " +
              "reporting a per-page fidelity score. Roughly doubles the run, and is the only " +
              "finding that says how WELL the clone came out rather than what was skipped.",
          },
          aiComponents: {
            type: "boolean",
            description:
              "Refine component and prop names with the model. Costs one model call per extracted " +
              "component, so it is worth asking about on a wide crawl. Default true.",
          },
        },
        required: ["url"],
      },
      async execute(args) {
        const { url, directory, depth, maxPages, aiComponents, verify } = args as {
          url?: unknown;
          directory?: unknown;
          depth?: unknown;
          maxPages?: unknown;
          aiComponents?: unknown;
          verify?: unknown;
        };

        if (workspace.projectRoot) {
          return toolError(
            "A project is already open in this window — import_site is only for bootstrapping.",
          );
        }
        if (imported) {
          return toolError(
            "A site has already been imported in this conversation. Start a new chat to import " +
              "another, or use the file tools on the project that was created.",
          );
        }
        const platform = getPlatform();
        if (!platform.importSite) {
          return toolError("This Studio platform has no site-import backend.");
        }

        let target: URL;
        try {
          target = new URL(String(url ?? "").trim());
        } catch {
          return toolError('Pass "url" — an absolute http(s) address, e.g. https://example.com.');
        }
        if (target.protocol !== "http:" && target.protocol !== "https:") {
          return toolError("The url must start with http:// or https://.");
        }

        const brief = pendingImportBrief();
        const requested = typeof directory === "string" ? directory.trim() : "";
        if (requested && brief && requested !== brief.directory) {
          /* The wizard's Location field is the user's answer to "where does this go". A model that
             disagrees with it is guessing at a decision that was already made in front of them. */
          return toolError(
            `The destination is already set to ${brief.directory} — call import_site without ` +
              '"directory", or ask the user before changing it.',
          );
        }
        const destination = requested || brief?.directory || "";
        if (!destination) {
          return toolError(
            'Pass "directory" — the absolute folder to create the project in. Ask the user where ' +
              "the project should live rather than guessing.",
          );
        }
        if (!isAbsolutePath(destination)) {
          return toolError(`"directory" must be an absolute path: ${destination}`);
        }
        if (destination.split(/[/\\]/).includes("..")) {
          return toolError(`"directory" must not contain "..": ${destination}`);
        }

        const id = currentToolCallId();
        const signal = beginImportRun(id, { directory: destination, url: target.href });
        /* The turn's own signal too. `assistant.stop` aborts the request through `abortImportRun`,
           but that is not the only way a turn ends: the loop's signal can be aborted directly, and
           a run left going after its turn died would keep a headless browser open for minutes with
           nothing left to receive the result. */
        turnSignal()?.addEventListener("abort", () => {
          abortImportRun();
          finishImportRun(id, { status: "stopped" });
        });

        const apiKey = getOpenAiKey();
        const baseUrl = getBaseUrl();
        const model = brief?.model || preferredModel();

        let result: { root: string; result?: ImportSiteSummary };
        try {
          result = await platform.importSite(
            {
              aiComponents:
                typeof aiComponents === "boolean" ? aiComponents : (brief?.aiComponents ?? true),
              depth: clamp(Number(depth ?? brief?.depth ?? 1) || 0, 0, MAX_DEPTH),
              directory: destination,
              maxPages: clamp(Number(maxPages ?? brief?.maxPages ?? 20) || 1, 1, MAX_PAGES),
              name: brief?.name || target.hostname.replace(/^www\./, ""),
              url: target.href,
              ...(typeof verify === "boolean"
                ? { verify }
                : brief?.verify === undefined
                  ? {}
                  : { verify: brief.verify }),
              ...(apiKey ? { apiKey } : {}),
              ...(baseUrl ? { baseUrl } : {}),
              ...(model ? { model } : {}),
            },
            (evt) => recordImportProgress(id, evt),
            signal,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (signal.aborted) {
            finishImportRun(id, { error: message, status: "stopped" });
            return toolError("The import was stopped.");
          }
          finishImportRun(id, { error: message, status: "failed" });
          /* The tail, not just the message: the commonest recovery is retrying at depth 0, which is
             an entirely different code path, and the phase that died is what says whether that
             would help. */
          const tail = (importRun(id)?.log ?? [])
            .slice(-FAILURE_TAIL)
            .map((e) => `[${e.phase}] ${e.message}`)
            .join("\n");
          return toolError(
            `The import failed: ${message}${tail ? `\n\nLast steps:\n${tail}` : ""}`,
          );
        }

        finishImportRun(id, { status: "done" });
        imported = true;
        clearPendingImportBrief();

        const { adopted, error: adoptionError } = await adoptCreatedProject(result.root, {
          getTab,
          ...(adoptProject ? { adopt: adoptProject } : {}),
        });
        if (adopted) {
          onProjectAdopted?.(result.root);
          return toolSuccess(
            { root: result.root, ...(result.result ? { summary: result.result } : {}) },
            describeRun(id, result.root, result.result),
          );
        }
        return toolSuccess(
          { root: result.root },
          `Imported the site into ${result.root}, but it was not opened in this window` +
            `${adoptionError ? ` (${adoptionError})` : " (it may have opened in another window)"}. ` +
            "Ask the user to open it from the welcome screen or recent projects.",
        );
      },
    }),
  );
}
