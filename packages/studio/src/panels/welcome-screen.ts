/// <reference lib="dom" />
/**
 * Start pane — the pane-grid surface shown when no project is loaded and no document tabs are open.
 *
 * Three regions, in the order a first run needs them: **Start** (the ways to get a project in front
 * of you), **Recent** (projects you have opened, identified by name + the folder that tells two
 * same-named projects apart + when you last opened them), and **Projects** (the catalogue a cloud
 * platform enumerates). A repository-access prompt sits above them when the account has no GitHub
 * App installation yet, because nothing else on the pane can succeed until it does.
 *
 * Recents never render a raw absolute path: `recentLocations()` gives every row the shortest
 * trailing path that distinguishes it from the other rows sharing its name.
 *
 * @docs studio/interface/welcome-screen
 */

import { html, render as litRender, nothing } from "lit-html";
import { getAccountStatus, needsAppInstall } from "../account-status";
import { platformSupportsAddRepo } from "../new-project/add-repo-modal";
import { getProjectList } from "../project-list";
import { now } from "../services/clock";
import { clearRecentProjects, getRecentProjects, removeRecentProject } from "../recent-projects";
import { renderOnly } from "../store";
import { platformSupportsClone } from "./git-panel";
import type { TemplateResult } from "lit-html";

interface WelcomeCtx {
  openProject: () => void;
  openRecentProject: (root: string) => void;
  openNewProject: (options?: { tab?: "starter" }) => void;
  cloneRepository: () => void;
  addExistingRepo: () => void;
}

let _ctx: WelcomeCtx | null = null;

/** @param {WelcomeCtx} ctx */
export function initWelcome(ctx: WelcomeCtx) {
  _ctx = ctx;
}

// ─── Location labels ──────────────────────────────────────────────────────────

/** Home-relative form of an absolute path (`/home/you/x` → `~/x`); other paths are unchanged. */
export function shortenPath(path: string): string {
  const match = /^\/(?:home|Users)\/[^/]+(?=\/|$)/.exec(path);
  return match ? `~${path.slice(match[0].length)}` : path;
}

/** The ancestor segments of a root, home-shortened — everything above the project folder itself. */
function ancestorSegments(root: string): string[] {
  const segments = shortenPath(root).split("/").filter(Boolean);
  return segments.slice(0, -1);
}

/**
 * The last `depth` ancestor folders of a root, as a path. Truncated labels lead with `…/`; a
 * complete absolute one keeps its leading `/`, so the string always says how much it is showing.
 */
function ancestorLabel(root: string, depth: number): string {
  const segments = ancestorSegments(root);
  if (segments.length === 0) {
    return shortenPath(root);
  }
  const tail = segments.slice(Math.max(0, segments.length - depth));
  if (tail.length < segments.length) {
    return `…/${tail.join("/")}`;
  }
  return tail[0] === "~" || !root.startsWith("/") ? tail.join("/") : `/${tail.join("/")}`;
}

/**
 * The location line for each entry: the shortest trailing path that tells apart the entries sharing
 * a display name. One folder deep is enough for almost every list; same-named projects under the
 * same parent fall back to their whole home-shortened root, which is unique because roots are.
 *
 * @param entries Projects to label, in any order.
 * @returns Root → location label, one entry per distinct root.
 */
export function recentLocations(
  entries: readonly { name: string; root: string }[],
): Map<string, string> {
  const groups = new Map<string, { name: string; root: string }[]>();
  for (const entry of entries) {
    const group = groups.get(entry.name);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.name, [entry]);
    }
  }

  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    const maxDepth = Math.max(...group.map((e) => ancestorSegments(e.root).length), 1);
    let chosen = group.map((e) => ancestorLabel(e.root, maxDepth));
    for (let depth = 1; depth <= maxDepth; depth++) {
      const candidate = group.map((e) => ancestorLabel(e.root, depth));
      if (new Set(candidate).size === group.length) {
        chosen = candidate;
        break;
      }
    }
    if (new Set(chosen).size !== group.length) {
      chosen = group.map((e) => shortenPath(e.root));
    }
    for (const [index, entry] of group.entries()) {
      labels.set(entry.root, chosen[index]!);
    }
  }
  return labels;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "When you last opened it", in the coarse units a project list is read in. Deliberately vague past
 * a week — the exact timestamp is in the row's tooltip.
 *
 * @param timestamp Epoch milliseconds.
 * @param at Epoch milliseconds to measure against. Defaults to the {@link now} seam, so a pinned
 *   clock makes "last opened" answer the same on every read.
 */
export function lastOpenedLabel(timestamp: number, at: number = now()): string {
  const elapsed = Math.max(0, at - timestamp);
  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(elapsed / DAY);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} month${months === 1 ? "" : "s"} ago` : "over a year ago";
}

// ─── Templates ────────────────────────────────────────────────────────────────

/** One Start-list command: a labelled, icon-led action button. */
function startActionTpl(label: string, icon: TemplateResult, run: () => void): TemplateResult {
  return html`
    <sp-action-button class="welcome-action" quiet size="m" @click=${run}>
      ${icon} ${label}
    </sp-action-button>
  `;
}

function startSectionTpl(ctx: WelcomeCtx): TemplateResult {
  return html`
    <section class="welcome-section">
      <h2 class="welcome-section-title">Start</h2>
      <div class="welcome-actions">
        ${
          // One entry, not two: the starter gallery IS the first step of New Project now, so the
          // Separate "Start from an Example…" button it used to hide behind is gone.
          startActionTpl("New Project…", html`<sp-icon-add slot="icon"></sp-icon-add>`, () =>
            ctx.openNewProject(),
          )
        }
        ${startActionTpl(
          "Open Project…",
          html`<sp-icon-folder-open slot="icon"></sp-icon-folder-open>`,
          () => ctx.openProject(),
        )}
        ${
          platformSupportsClone()
            ? startActionTpl(
                "Clone Git Repository…",
                html`<sp-icon-download slot="icon"></sp-icon-download>`,
                () => ctx.cloneRepository(),
              )
            : nothing
        }
        ${
          platformSupportsAddRepo()
            ? startActionTpl(
                "Add Existing Repository…",
                html`<sp-icon-box slot="icon"></sp-icon-box>`,
                () => ctx.addExistingRepo(),
              )
            : nothing
        }
      </div>
    </section>
  `;
}

/**
 * The GitHub-App install prompt. Gated on `needsAppInstall()`: the account is connected, reports
 * zero installations, and told us where to fix that — the recovery path for the structured
 * needs-installation 403 that `platform-errors.ts` decodes.
 */
function appInstallTpl(): TemplateResult {
  return html`
    <section class="welcome-section">
      <h2 class="welcome-section-title">Repository access</h2>
      <div class="welcome-actions">
        <sp-action-button
          class="welcome-action"
          quiet
          size="m"
          href=${getAccountStatus()?.appInstallUrl ?? "#"}
          target="_blank"
          rel="noreferrer"
        >
          <sp-icon-link slot="icon"></sp-icon-link>
          Install the Jx Suite GitHub App
        </sp-action-button>
      </div>
      <p class="welcome-install-note">
        Grants repository access so you can create and open projects — choose “All repositories”.
      </p>
    </section>
  `;
}

/** One row of the Recent list: the project, its distinguishing folder, and when it was last open. */
function recentRowTpl(
  ctx: WelcomeCtx,
  entry: { name: string; root: string; timestamp: number },
  location: string,
): TemplateResult {
  return html`
    <li class="welcome-recent-row">
      <button
        class="welcome-recent"
        title=${entry.root}
        @click=${() => ctx.openRecentProject(entry.root)}
      >
        <span class="welcome-recent-name">${entry.name}</span>
        <span class="welcome-recent-path">${location}</span>
        <span class="welcome-recent-when">${lastOpenedLabel(entry.timestamp)}</span>
      </button>
      <sp-action-button
        class="welcome-recent-remove"
        quiet
        size="s"
        label="Remove ${entry.name} from Recent"
        @click=${() => {
          removeRecentProject(entry.root);
          renderOnly("canvas");
        }}
      >
        <sp-icon-close slot="icon"></sp-icon-close>
      </sp-action-button>
    </li>
  `;
}

function recentSectionTpl(
  ctx: WelcomeCtx,
  recent: readonly { name: string; root: string; timestamp: number }[],
): TemplateResult {
  const locations = recentLocations(recent);
  return html`
    <section class="welcome-section">
      <div class="welcome-section-header">
        <h2 class="welcome-section-title">Recent</h2>
        <sp-action-button
          class="welcome-clear"
          quiet
          size="s"
          @click=${() => {
            clearRecentProjects();
            renderOnly("canvas");
          }}
        >
          Clear all
        </sp-action-button>
      </div>
      <ul class="welcome-list">
        ${recent.map((entry) => recentRowTpl(ctx, entry, locations.get(entry.root) ?? entry.root))}
      </ul>
    </section>
  `;
}

/**
 * Projects the platform enumerates that are not already in Recent. Cloud catalogues carry their own
 * one-line description; anything else gets the same location treatment the recents get.
 */
function catalogueSectionTpl(
  ctx: WelcomeCtx,
  catalogue: readonly { name: string; root: string; description?: string | undefined }[],
): TemplateResult {
  const locations = recentLocations(catalogue);
  return html`
    <section class="welcome-section">
      <h2 class="welcome-section-title">Projects</h2>
      <ul class="welcome-list">
        ${catalogue.map(
          (project) => html`
            <li class="welcome-recent-row">
              <button
                class="welcome-recent welcome-catalogue"
                title=${project.root}
                @click=${() => ctx.openRecentProject(project.root)}
              >
                <span class="welcome-recent-name">${project.name}</span>
                <span class="welcome-recent-path">
                  ${project.description ?? locations.get(project.root) ?? project.root}
                </span>
              </button>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

/** @param {HTMLElement} host */
export function renderWelcome(host: HTMLElement) {
  const ctx = _ctx as WelcomeCtx;
  const recent = getRecentProjects();
  // Catalogue entries already in Recent stay in that section only.
  const catalogue = getProjectList().filter((p) => !recent.some((r) => r.root === p.root));

  litRender(
    html`
      <div class="welcome-screen">
        <div class="welcome-content">
          <h1 class="welcome-title">Jx Studio</h1>
          <p class="welcome-subtitle">Design, build, and publish websites</p>
          ${startSectionTpl(ctx)} ${needsAppInstall() ? appInstallTpl() : nothing}
          ${recent.length > 0 ? recentSectionTpl(ctx, recent) : nothing}
          ${catalogue.length > 0 ? catalogueSectionTpl(ctx, catalogue) : nothing}
        </div>
      </div>
    `,
    host,
  );
}
