/**
 * The New Project modal's Import source step: an AI-guided clone of an existing site. Gated behind
 * the AI credentials form when no key is stored; otherwise a URL + crawl-options form. The
 * name/directory parameters live on the modal's shared Parameters step; the running pipeline
 * streams its progress into a log here and resolves the modal with the imported project.
 */

import { html } from "lit-html";
import { getPlatform } from "../platform";
import { getBaseUrl, getModel, getOpenAiKey, hasOpenAiKey } from "../services/ai-settings";
import { errorMessage } from "@jxsuite/schema/parse";
import { destinationPath } from "./location-fields";
import type { TemplateResult } from "lit-html";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type { CreateProjectDestination, ImportProgressEvent } from "../types";

/** Structural view of src/ui/ai-credentials-form's controller (what this tab renders when gated). */
export interface CredsFormLike {
  render: () => TemplateResult;
  startEdit: () => void;
}

export interface ImportTabCtx {
  /** The modal's shared name/directory state (the import destination slug). */
  form: { name: string; directory: string };
  /**
   * Validate the shared Parameters fields and return where to write, or null when something is
   * missing (the modal has already rendered the reason inline). Import is always a `"path"`
   * destination — cloud ships no `importSite`, so the Import tab never renders there.
   */
  resolveDestination: () => CreateProjectDestination | null;
  rerender: () => void;
  /** Called with the imported project; the modal resolves and closes. */
  onDone: (result: { root: string; config: ProjectConfig }) => void;
  /** The modal's shared credentials-form instance, rendered while no key is stored. */
  credsForm: CredsFormLike;
}

let _url = "";
let _depth = 1;
let _maxPages = 20;
let _aiNaming = true;
let _status: "idle" | "running" | "error" = "idle";
let _log: ImportProgressEvent[] = [];
let _errorMsg = "";
let _abort: AbortController | null = null;
let _dirManual = false;

/** Reset the tab's state when the modal opens. */
export function resetImportTab() {
  _url = "";
  _depth = 1;
  _maxPages = 20;
  _aiNaming = true;
  _status = "idle";
  _log = [];
  _errorMsg = "";
  _abort = null;
  _dirManual = false;
}

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

/** True while an import stream is active (the modal disables tab switching and close). */
export function isImportRunning(): boolean {
  return _status === "running";
}

/** Abort the running import (the footer's Cancel Import button). */
export function cancelImport(ctx: ImportTabCtx) {
  _abort?.abort();
  _abort = null;
  _status = "idle";
  ctx.rerender();
}

/**
 * Validate the source step (the URL) before advancing to the Parameters step. Sets the inline error
 * and returns false when invalid.
 */
export function validateImportSource(ctx: ImportTabCtx): boolean {
  let parsed: URL | null = null;
  try {
    parsed = new URL(_url.trim());
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    _errorMsg = "Enter a valid URL (e.g. https://example.com)";
    ctx.rerender();
    return false;
  }
  _errorMsg = "";
  return true;
}

/** Validate and kick off the import. Wired to the modal footer's primary button. */
export async function startImport(ctx: ImportTabCtx) {
  const platform = getPlatform();
  if (_status === "running" || !platform.importSite) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(_url.trim());
  } catch {
    _errorMsg = "Enter a valid URL (e.g. https://example.com)";
    ctx.rerender();
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    _errorMsg = "The URL must start with http:// or https://";
    ctx.rerender();
    return;
  }
  const destination = ctx.resolveDestination();
  if (!destination || destination.kind !== "path") {
    return;
  }

  _status = "running";
  _errorMsg = "";
  _log = [];
  _abort = new AbortController();
  ctx.rerender();

  try {
    const key = getOpenAiKey();
    const baseUrl = getBaseUrl();
    const model = getModel();
    const result = await platform.importSite(
      {
        url: parsed.href,
        name: ctx.form.name.trim(),
        directory: destinationPath(destination, ctx.form.directory),
        depth: _depth,
        maxPages: _maxPages,
        aiComponents: _aiNaming,
        ...(key ? { apiKey: key } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
      },
      (evt) => {
        _log = [..._log, evt];
        ctx.rerender();
        requestAnimationFrame(() => {
          const el = document.querySelector(".new-project-import-log");
          if (el) {
            el.scrollTop = el.scrollHeight;
          }
        });
      },
      _abort.signal,
    );
    _status = "idle";
    _abort = null;
    ctx.onDone(result);
  } catch (error) {
    if (_status !== "running") {
      return; // Cancelled by the user — cancelImport already reset the tab.
    }
    _abort = null;
    _status = "error";
    _errorMsg = errorMessage(error);
    ctx.rerender();
  }
}

/** The footer's primary-button label for the Import tab's current state. */
export function importButtonLabel(): string {
  if (_status === "running") {
    return "Importing…";
  }
  return _status === "error" ? "Retry Import" : "Import Site";
}

function onUrlInput(ctx: ImportTabCtx) {
  return (e: Event) => {
    _url = (e.target as HTMLInputElement).value;
    // Prefill the project name from the hostname while the user hasn't typed one.
    if (!ctx.form.name.trim()) {
      try {
        const host = new URL(_url).hostname.replace(/^www\./, "");
        if (host) {
          ctx.form.name = host;
          if (!_dirManual) {
            ctx.form.directory = slugOf(host);
          }
        }
      } catch {
        /* Partial URL while typing — leave the name alone. */
      }
    }
    ctx.rerender();
  };
}

function renderProgress(): TemplateResult {
  const latest = _log.at(-1);
  return html`
    <div class="new-project-import-progress">
      <sp-progress-circle indeterminate size="s"></sp-progress-circle>
      <span class="new-project-import-phase">${latest ? latest.phase : "starting"}</span>
      <span>${latest ? latest.message : "Starting import…"}</span>
    </div>
    <div class="new-project-import-log">
      ${_log.map(
        (evt) => html`
          <div class="new-project-import-log-line">
            <span class="new-project-import-phase">${evt.phase}</span>
            ${evt.message}
          </div>
        `,
      )}
    </div>
  `;
}

/** The streaming progress view shown (in place of the Parameters step) while a run is active. */
export function renderImportProgress(): TemplateResult {
  return renderProgress();
}

/** Inline error + retained log, rendered on the Parameters step after a failed run. */
export function renderImportStatus(): TemplateResult {
  if (_status !== "error") {
    return html``;
  }
  return html`
    ${_errorMsg ? html`<div class="new-project-error">${_errorMsg}</div>` : ""}
    ${
      _log.length > 0
        ? html`
            <div class="new-project-import-log">
              ${_log.map(
                (evt) => html`
                  <div class="new-project-import-log-line">
                    <span class="new-project-import-phase">${evt.phase}</span>
                    ${evt.message}
                  </div>
                `,
              )}
            </div>
          `
        : ""
    }
  `;
}

export function renderImportSource(ctx: ImportTabCtx): TemplateResult {
  if (!hasOpenAiKey()) {
    return html`
      <div class="new-project-tab-intro">
        Importing uses an AI-guided pipeline to clone an existing site. Add an OpenAI-compatible API
        key to continue.
      </div>
      <div class="new-project-creds">${ctx.credsForm.render()}</div>
    `;
  }

  return html`
    <div class="new-project-tab-intro">
      Clone an existing site into an editable Jx project: pages, styles, assets, and components.
    </div>
    <label class="new-project-field">
      <span class="new-project-label">Site URL *</span>
      <sp-textfield
        placeholder="https://example.com"
        .value=${_url}
        @input=${onUrlInput(ctx)}
        style="width: 100%"
      ></sp-textfield>
    </label>
    <div class="new-project-import-grid">
      <label class="new-project-field">
        <span class="new-project-label">Crawl Depth</span>
        <sp-number-field
          min="0"
          max="2"
          .value=${_depth}
          @change=${(e: Event) => {
            _depth = Math.trunc(Number((e.target as HTMLInputElement).value)) || 0;
          }}
        ></sp-number-field>
      </label>
      <label class="new-project-field">
        <span class="new-project-label">Max Pages</span>
        <sp-number-field
          min="1"
          max="100"
          .value=${_maxPages}
          @change=${(e: Event) => {
            _maxPages = Math.trunc(Number((e.target as HTMLInputElement).value)) || 1;
          }}
        ></sp-number-field>
      </label>
    </div>
    <sp-switch
      ?checked=${_aiNaming}
      @change=${(e: Event) => {
        _aiNaming = (e.target as HTMLInputElement).checked;
      }}
    >
      AI component naming
    </sp-switch>
    ${_errorMsg ? html`<div class="new-project-error">${_errorMsg}</div>` : ""}
    ${
      _status === "error" && _log.length > 0
        ? html`
            <div class="new-project-import-log">
              ${_log.map(
                (evt) => html`
                  <div class="new-project-import-log-line">
                    <span class="new-project-import-phase">${evt.phase}</span>
                    ${evt.message}
                  </div>
                `,
              )}
            </div>
          `
        : ""
    }
  `;
}
