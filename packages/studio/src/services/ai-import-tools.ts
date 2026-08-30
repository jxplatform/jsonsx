/**
 * Ai-import-tools.ts — `import_site`, the assistant's other way to bootstrap a project.
 *
 * A sibling of `create_project` (`ai-project-tools.ts`) with a different backend: it drives whatever
 * import pipeline the platform's `importSite` reaches — a local headless Chrome, or a hosted one —
 * streams its progress into a record the transcript draws, and then adopts the result exactly as a
 * scaffold is adopted. Its own module
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
import type { AdoptOutcome } from "./project-adoption";
import { currentToolCallId, turnSignal } from "./ai-turn-signal";

import type { ToolRegistry } from "@jxsuite/ai/tools";
import type { Tab } from "../tabs/tab";
import type { ImportBreakpointPolicy, ImportReadyEvent, ImportSiteSummary } from "../types";

/** The same bounds `packages/server/src/import-api.ts` clamps to. */
const MAX_DEPTH = 5;
const MAX_PAGES = 100;

/** Log lines quoted back on a hard failure — enough to see WHICH phase died. */
const FAILURE_TAIL = 5;

/** Low-fidelity pages named in the summary. A list of twenty is a wall, not a finding. */
const WEAKEST_PAGES = 3;

/** Below this, a page is worth naming. Above it, "close enough" is the honest reading. */
const WEAK_FIDELITY = 90;

/**
 * The default bar an import is measured against, matching `jx-import --min-fidelity`.
 *
 * A floor for "this is not a clone of anything" rather than a quality target: a faithful import of
 * a complicated site lands well under 100 for reasons no importer can fix.
 */
const DEFAULT_MIN_FIDELITY = 25;
const MAX_FIDELITY = 100;

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

/**
 * The breakpoint policy for this run: what the model asked for, else what the wizard collected.
 *
 * The model may narrow this — it is the one option a person is likely to have an opinion about
 * after seeing the crawl — but it never invents an override the user did not ask for, because the
 * wizard's control is already the answer to "how many breakpoints should this project have".
 *
 * @param {object} args - The model's `maxBreakpoints` / `breakpointWidths` / `breakpointRounding`
 * @param {ImportBreakpointPolicy | undefined} fromBrief - What the wizard collected, if anything
 * @returns {ImportBreakpointPolicy | undefined}
 */
function breakpointPolicyFor(
  args: { maxBreakpoints?: unknown; widths?: unknown; rounding?: unknown },
  fromBrief: ImportBreakpointPolicy | undefined,
): ImportBreakpointPolicy | undefined {
  const rounding =
    args.rounding === "down" || args.rounding === "up" || args.rounding === "nearest"
      ? args.rounding
      : (fromBrief?.rounding ?? "nearest");

  if (Array.isArray(args.widths) && args.widths.length > 0) {
    return { mode: "explicit", rounding, widths: args.widths.map(Number) };
  }
  if (typeof args.maxBreakpoints === "number" && Number.isFinite(args.maxBreakpoints)) {
    // Zero is the only spelling a count has for "keep all", and it is worth accepting: it is what
    // A model reaches for when a person says "keep them all".
    return args.maxBreakpoints <= 0
      ? { mode: "all" }
      : { count: Math.trunc(args.maxBreakpoints), mode: "limit", rounding };
  }
  return fromBrief;
}

/** Absolute on POSIX or Windows — the test `create_project` already applies to its `location`. */
function isAbsolutePath(path: string): boolean {
  return /^(?:[a-zA-Z]:[/\\]|\/)/.test(path);
}

/**
 * `owner/repo`, conservatively — the destination a `createDestination: "repo"` platform writes to.
 *
 * Narrower than GitHub's own rules on purpose: this guards a string the MODEL may supply, and the
 * cost of refusing an exotic-but-legal name is one clarifying question, while the cost of accepting
 * a path-shaped or query-shaped one is a request the backend has to defend against.
 */
const REPO_DESTINATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/**
 * Whether `destination` is a shape THIS platform can write to, or the sentence saying why not.
 *
 * The platform's `createDestination` decides, not the string's own look: a hosted backend creates a
 * GitHub repository and has no filesystem to hold an absolute path, and a desktop backend has no
 * repository to create. Answering by inspecting the string would accept `owner/repo` on desktop,
 * where it silently means a relative directory nobody named.
 *
 * @param {string} destination - The resolved destination, from the model or the wizard's brief
 * @returns {string | null} The refusal, or null when it is usable
 */
function destinationProblem(destination: string): string | null {
  if (getPlatform().createDestination === "repo") {
    if (!REPO_DESTINATION.test(destination)) {
      return `"directory" must name a repository as "owner/repo": ${destination}`;
    }
  } else if (!isAbsolutePath(destination)) {
    return `"directory" must be an absolute path: ${destination}`;
  }
  if (destination.split(/[/\\]/).includes("..")) {
    return `"directory" must not contain "..": ${destination}`;
  }
  return null;
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
    /*
     * The bar the user set, and whether this run cleared it. Stated FIRST among the details,
     * because it is the difference between a number to note and a result to act on: an import at
     * 8% used to report exactly like one at 95%, and the only way to tell them apart was to open
     * the project and look.
     */
    if (summary.verify.passed === false && (summary.verify.buildErrors ?? []).length === 0) {
      lines.push(
        `That is below the ${summary.verify.minFidelity ?? 0}% minimum this import was asked ` +
          "for, so the clone does not match the original closely enough. Say so plainly, and " +
          "offer to look at what went wrong rather than moving on.",
      );
    }
    /*
     * The score says a page looks wrong; this says why. A page that 404s on fifteen asset
     * references scores badly for one fixable reason, and reading a percentage on its own sends
     * the reader looking for the wrong thing entirely (jxsuite/jx issue 232).
     */
    const missing = (summary.verify.pages ?? []).reduce(
      (sum, page) => sum + (page.failedRequests ?? 0),
      0,
    );
    if (missing > 0) {
      lines.push(
        `${missing} request${missing === 1 ? "" : "s"} failed or 404'd in the rendered pages — ` +
          "check the emitted asset paths before treating a low score as a layout problem.",
      );
    }
    for (const error of summary.verify.buildErrors ?? []) {
      lines.push(`The emitted project did not build cleanly: ${error}`);
    }
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
              "Where the project goes, in whichever form this studio's backend uses: an absolute " +
              'folder on a filesystem host, or "owner/repo" on a host where a project IS a ' +
              "repository. Omit it when an import was started from the New Project form — that " +
              "destination is the one the user chose, and it wins.",
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
          minFidelity: {
            type: "number",
            description:
              "With verify on, the average fidelity (0-100) the clone must reach to count as " +
              "matching the original. A floor rather than a target: a faithful import of a " +
              "complicated site lands well under 100, so raise it only when the user asks for a " +
              "stricter bar. 0 reports the score without judging it. Default 25.",
          },
          aiComponents: {
            type: "boolean",
            description:
              "Refine component and prop names with the model. Costs one model call per extracted " +
              "component, so it is worth asking about on a wide crawl. Default true.",
          },
          maxBreakpoints: {
            type: "number",
            description:
              "How many of the site's declared breakpoints to keep, evenly spaced across its " +
              "range (1-12). A real site declares as many as it has accumulated frameworks, and " +
              "each one is a canvas size and a column in every style editor. Default 3; pass 0 to " +
              "keep every one. Ignored when breakpointWidths is given.",
          },
          breakpointWidths: {
            type: "array",
            items: { type: "number" },
            description:
              "Keep these widths instead of a count, e.g. [640, 1024, 1440]. Each is backed by " +
              "the declared width nearest it, because the styles flip where the site says they " +
              "do. Ask the user before choosing widths they did not name.",
          },
          breakpointRounding: {
            type: "string",
            enum: ["nearest", "down", "up"],
            description: "How a kept width matches a declared one. Default nearest.",
          },
        },
        required: ["url"],
      },
      async execute(args) {
        const {
          url,
          directory,
          depth,
          maxPages,
          aiComponents,
          verify,
          minFidelity,
          maxBreakpoints,
          breakpointWidths,
          breakpointRounding,
        } = args as {
          url?: unknown;
          directory?: unknown;
          depth?: unknown;
          maxPages?: unknown;
          aiComponents?: unknown;
          verify?: unknown;
          minFidelity?: unknown;
          maxBreakpoints?: unknown;
          breakpointWidths?: unknown;
          breakpointRounding?: unknown;
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
            platform.createDestination === "repo"
              ? 'Pass "directory" — the "owner/repo" to create the project as. Ask the user which ' +
                  "account and repository name rather than guessing."
              : 'Pass "directory" — the absolute folder to create the project in. Ask the user ' +
                  "where the project should live rather than guessing.",
          );
        }
        const problem = destinationProblem(destination);
        if (problem) {
          return toolError(problem);
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

        const breakpoints = breakpointPolicyFor(
          { maxBreakpoints, rounding: breakpointRounding, widths: breakpointWidths },
          brief?.breakpoints,
        );

        /*
         * Adoption happens the moment the destination is a project, not when the run ends.
         *
         * A crawl takes minutes, and it used to spend all of them with the author on the welcome
         * screen — the tool opened the project once `importSite` resolved, so the one view of what
         * the import was doing was a log in the sidebar. Opening at `ready` puts them IN the project
         * while it fills: the Files tree gets each page, component and asset as the pipeline writes
         * it, through the watcher that is already running.
         *
         * It runs at most once (a backend may send the line once, and only one can be first), and a
         * failure here is not the run's failure: the import continues either way, and the terminal
         * path below reports honestly on whichever state the window ended up in.
         */
        let adoption: Promise<AdoptOutcome> | null = null;
        const onReady = ({ root }: ImportReadyEvent) => {
          adoption ??= adoptCreatedProject(root, {
            getTab,
            ...(adoptProject ? { adopt: adoptProject } : {}),
          });
        };

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
              ...(breakpoints === undefined ? {} : { breakpoints }),
              ...(typeof verify === "boolean"
                ? { verify }
                : brief?.verify === undefined
                  ? {}
                  : { verify: brief.verify }),
              /* The wizard's number is the user's own answer to "how close is close enough"; the
                 model may only override it when it was told to. */
              verifyMinFidelity: clamp(
                Number(minFidelity ?? brief?.minFidelity ?? DEFAULT_MIN_FIDELITY) || 0,
                0,
                MAX_FIDELITY,
              ),
              ...(apiKey ? { apiKey } : {}),
              ...(baseUrl ? { baseUrl } : {}),
              ...(model ? { model } : {}),
            },
            (evt) => recordImportProgress(id, evt),
            signal,
            onReady,
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

        /* The early adoption if there was one, otherwise adopt now: a backend that sends no `ready`
           line is not broken, it is older, and the project must still open. */
        const { adopted, error: adoptionError } = await (adoption ??
          adoptCreatedProject(result.root, {
            getTab,
            ...(adoptProject ? { adopt: adoptProject } : {}),
          }));
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
