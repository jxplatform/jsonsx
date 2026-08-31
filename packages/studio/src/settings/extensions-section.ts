/// <reference lib="dom" />
/**
 * The Extensions section of Project Settings — what this project can turn on, and what it has.
 *
 * **The section exists because enabling an extension is two writes, and nothing kept them
 * together.** A project names an extension in `project.json` `extensions[]`, and the package has to
 * be a dependency for the registry to resolve it. The section this replaces wrote only the first,
 * so typing a name that was not installed appended a string and the next build threw `Extension "…"
 * is not resolvable`. A toggle here does both halves, in the one order that cannot leave the
 * project broken (see `enableExtension`).
 *
 * **What is offered comes from the backend, not from a list here.** Not every host can run every
 * extension — a Worker ships a fixed set of packages (specs/extensions.md §5.5) — so the catalogue
 * is a platform capability, and a host that cannot answer simply offers nothing. That is also why
 * there is no `@jxsuite/` prefix test below: which extensions are first-party is the backend's
 * answer, and a second definition of it here would be wrong for a fork.
 *
 * @docs studio/projects/settings
 */

import { html, nothing, render as litRender } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { live } from "lit-html/directives/live.js";
import { repeat } from "lit-html/directives/repeat.js";
import { errorMessage } from "@jxsuite/schema/parse";
import { buildRows } from "./extension-rows";
import { getPlatform } from "../platform";
import { renderEmptyState } from "../panels/empty-state";
import {
  disableExtension,
  enableExtension,
  extensionOpInFlight,
  removeExtensionPackage,
} from "./extension-commands";
import type { ExtensionOrigin, ExtensionRow } from "./extension-rows";
import type { PackageInfo } from "../types";

/** Group headings, in render order, each with the sentence that says what the group is. */
const GROUPS: { origin: ExtensionOrigin; label: string; blurb: string }[] = [
  {
    blurb:
      "Extensions this project can turn on. Enabling one installs its package first if it is missing.",
    label: "Available",
    origin: "catalog",
  },
  {
    blurb: "Extension packages already in this project's dependencies.",
    label: "Installed",
    origin: "installed",
  },
  {
    blurb:
      "Named in project.json, but this backend does not describe them. You can still turn them off.",
    label: "Named in project.json",
    origin: "configured",
  },
];

let _container: HTMLElement | null = null;

/** The project's dependencies, re-read whenever an operation may have changed them. */
let _packages: PackageInfo[] | null = null;

/**
 * The last failed operation, shown after the control that failed.
 *
 * Not a second announcement: `updateSiteConfig` already files a Problem for a rejected write and
 * `activity.fail` files one for a rejected install. §13.1 makes INLINE the tier for "the value is
 * on screen, and nothing else is the right place" — the Problem is about the file, and this line is
 * about the switch the reader is looking at.
 */
let _error: string | null = null;

/** Re-read the package list, then repaint. Installed-ness is what a config write cannot move. */
async function reload(): Promise<void> {
  try {
    _packages = await getPlatform().listPackages();
  } catch {
    _packages = [];
  }
  render();
}

async function onToggle(row: ExtensionRow): Promise<void> {
  // Intent is the DOCUMENT's truth inverted, never the switch's own `checked` — the browser has
  // Already moved that by the time this fires, so reading it would compound a double event.
  _error = null;
  // Started, THEN painted: both operations take the in-flight latch synchronously before their
  // First await, so this repaint is what disables every other switch for the duration.
  const op = row.enabled ? disableExtension(row.specifier) : enableExtension(row.specifier);
  render();
  try {
    await op;
  } catch (error) {
    _error = errorMessage(error);
  }
  // Either way the row repaints from `project.json`, so `live()` puts a switch the operation did
  // Not earn back where the document says it belongs.
  await reload();
}

async function onRemove(row: ExtensionRow): Promise<void> {
  _error = null;
  const op = removeExtensionPackage(row.name);
  render();
  try {
    await op;
  } catch (error) {
    _error = errorMessage(error);
  }
  await reload();
}

/** The sentence a row's state deserves, or null. */
function noteFor(row: ExtensionRow): { text: string; warn: boolean } | null {
  if (row.unavailable !== undefined) {
    return { text: row.unavailable, warn: true };
  }
  if (row.broken) {
    return {
      text:
        `${row.name} is named in project.json but is not installed, so the next build will fail. ` +
        `Turn it off, or turn it off and on again to install it.`,
      warn: true,
    };
  }
  if (!row.installed && !row.bundled) {
    return { text: "Not installed. Turning this on installs it first.", warn: false };
  }
  if (row.bundled) {
    return { text: "Ships with this backend, so it needs no install.", warn: false };
  }
  return null;
}

/** Why a row's toggle cannot be used right now, or undefined when it can. */
function blockedReason(row: ExtensionRow): string | undefined {
  // Turning something OFF is always safe, even on a backend that cannot run it — otherwise a row
  // That arrived unsupported could never be removed from the project that names it.
  if (row.unavailable !== undefined && !row.enabled) {
    return row.unavailable;
  }
  const busy = extensionOpInFlight();
  return busy === null ? undefined : `Waiting for ${busy} to finish.`;
}

/**
 * The per-row Remove.
 *
 * Refused while the extension is still enabled, and rendered DISABLED with the reason rather than
 * hidden (guidelines §10): removing the package while `project.json` still names it manufactures
 * exactly the broken state this section exists to eliminate.
 */
function removeTemplate(row: ExtensionRow) {
  if (!row.installed || row.bundled) {
    return nothing;
  }
  const refusal = row.enabled
    ? `Turn ${row.title} off first. Removing the package while project.json still names it would fail the next build.`
    : undefined;
  return html`<sp-action-button
    size="s"
    quiet
    class="settings-extension-remove"
    title=${refusal ?? `Remove ${row.name}`}
    ?disabled=${refusal !== undefined || extensionOpInFlight() !== null}
    @click=${() => {
      void onRemove(row);
    }}
  >
    <sp-icon-delete slot="icon"></sp-icon-delete>
  </sp-action-button>`;
}

function rowTemplate(row: ExtensionRow) {
  const blocked = blockedReason(row);
  const note = noteFor(row);
  return html`
    <div
      class=${classMap({
        "settings-toggle-row": true,
        "settings-toggle-row--broken": row.broken,
      })}
    >
      <sp-switch
        size="s"
        class="settings-extension-toggle"
        aria-label=${row.title}
        .checked=${live(row.enabled)}
        ?disabled=${blocked !== undefined}
        title=${blocked ?? nothing}
        @change=${() => {
          void onToggle(row);
        }}
      ></sp-switch>
      <div class="settings-toggle-body">
        <span class="settings-toggle-title">${row.title}</span>
        <code class="settings-toggle-package">${row.name}</code>
        ${row.description ? html`<p class="settings-toggle-desc">${row.description}</p>` : nothing}
        ${
          row.sections.length === 0
            ? nothing
            : html`<div class="settings-toggle-sections">
                ${row.sections.map(
                  (key) => html`<span class="settings-toggle-section">${key}</span>`,
                )}
              </div>`
        }
        ${
          note === null
            ? nothing
            : html`<p
                class=${classMap({
                  "settings-toggle-note": true,
                  "settings-toggle-note--warn": note.warn,
                })}
              >
                ${note.text}
              </p>`
        }
      </div>
      <div class="settings-toggle-actions">${removeTemplate(row)}</div>
    </div>
  `;
}

function render(): void {
  if (!_container) {
    return;
  }
  const rows = buildRows(_packages);
  const groups: { label: string; blurb: string; rows: ExtensionRow[] }[] = [];
  for (const group of GROUPS) {
    const matching = rows.filter((row) => row.origin === group.origin);
    if (matching.length > 0) {
      groups.push({ blurb: group.blurb, label: group.label, rows: matching });
    }
  }

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Extensions</h3>
      <p class="settings-field-desc">
        Extensions add what the core does not do on its own: content collections, search, feeds,
        sign-ins and databases. Turning one on installs its package and enables it; turning it off
        leaves the package installed.
      </p>
      ${
        _error === null ? nothing : html`<p class="settings-field-error" role="alert">${_error}</p>`
      }
      ${
        groups.length === 0
          ? renderEmptyState({
              compact: true,
              detail: "This backend lists no catalogue, so nothing can be offered here yet.",
              message:
                "Extensions add what the core does not do on its own: content collections, search, feeds, sign-ins and databases.",
            })
          : groups.map(
              (group) => html`
                <div class="settings-extension-group">
                  <h4 class="settings-extension-group-title">${group.label}</h4>
                  <p class="settings-field-desc">${group.blurb}</p>
                  ${repeat(
                    group.rows,
                    (row) => row.name,
                    (row) => rowTemplate(row),
                  )}
                </div>
              `,
            )
      }
    </div>
  `;
  litRender(tpl, _container);
}

/**
 * Render the Extensions section into a settings-document container.
 *
 * @param {HTMLElement} container
 */
export function renderExtensionsSection(container: HTMLElement): void {
  _container = container;
  _error = null;
  render();
  void reload();
}
