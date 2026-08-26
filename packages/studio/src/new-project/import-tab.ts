/**
 * The New Project modal's Import source step: an AI-guided clone of an existing site. Gated behind
 * the AI credentials gate (key form + the keyless Cloudflare option) until AI is usable — a local
 * key, or a backend holding its own; otherwise a URL, crawl options, a model and a brief. The
 * name/directory parameters live on the modal's shared Parameters step.
 *
 * **This form no longer runs the import.** It gathers a brief and hands it to the assistant, which
 * runs the pipeline as a tool call. The wizard used to own the run, and the consequence was that a
 * successful import destroyed its own account of itself: every phase line and every warning lived
 * in a log that vanished with the modal at the moment it handed off. In the transcript the run
 * survives, the model can read what the crawl actually found, and it can stop and ask about
 * anything the pipeline had to guess at.
 */

import { html } from "lit-html";
import { getPlatform } from "../platform";
import { preferredModel } from "../services/ai-models";
import { createModelPicker } from "../ui/ai-model-picker";
import { destinationPath } from "./location-fields";
import type { TemplateResult } from "lit-html";
import type { CreateProjectDestination } from "../types";
import { setPendingImportBrief } from "../services/import-seed";
import type { ImportBrief } from "../services/import-seed";

/** Structural view of src/ui/ai-credentials-form's controller (what this tab renders when gated). */
export interface CredsFormLike {
  render: () => TemplateResult;
  startEdit: () => void;
}

/** Structural view of src/ui/ai-managed-connect's controller (the keyless option beside the form). */
export interface ManagedConnectLike {
  canOffer: () => boolean;
  render: () => unknown;
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
  /**
   * Called with the brief the form gathered. The modal closes WITHOUT a project — the assistant
   * runs the import as a tool call and creates it.
   */
  onHandoff: (brief: ImportBrief) => void;
  /** The modal's shared credentials-form instance, rendered while the gate is closed. */
  credsForm: CredsFormLike;
  /**
   * Whether AI is usable — a local key OR a backend holding credentials of its own. Also fires the
   * capability probe while closed, so a managed platform's Cloudflare option can appear.
   */
  aiGateOpen: () => boolean;
  /** The modal's shared keyless "Connect Cloudflare" controller, rendered beside the form. */
  managedConnect: ManagedConnectLike;
}

let _url = "";
let _depth = 1;
let _maxPages = 20;
let _aiNaming = true;
/**
 * The model this import will run its AI passes on. Empty means "whatever the assistant would use",
 * which is what the tab did silently before there was a picker.
 *
 * A DRAFT, not the `jx.ai.model` preference: choosing a model for one import must not retarget the
 * assistant for every later conversation. `startImport` falls back to {@link preferredModel} so an
 * untouched picker behaves exactly as the tab did before.
 */
let _model = "";
/** What the user wants done with the site once it is imported. Handed to the assistant. */
let _prompt = "";
/**
 * Build the result and screenshot-diff it against the original.
 *
 * Off by default because it roughly doubles the run: a full compile plus a second browser pass.
 * Worth offering because it produces the only finding that says how WELL the clone came out — every
 * other one is a count of things that were skipped, and a page at 61% fidelity is a question the
 * assistant can put to a person.
 */
let _verify = false;
let _errorMsg = "";
let _dirManual = false;

/** Reset the tab's state when the modal opens. */
export function resetImportTab() {
  _url = "";
  _depth = 1;
  _maxPages = 20;
  _aiNaming = true;
  _model = "";
  _prompt = "";
  _verify = false;
  _errorMsg = "";
  _dirManual = false;
}

/**
 * The tab's model picker, and the scheduler it repaints through.
 *
 * Created once and kept: `createModelPicker` holds the in-flight fetch and the failed-connection
 * record, and a picker rebuilt per render would re-fetch the catalogue on every keystroke. The
 * scheduler is a SLOT rather than a captured closure because `ImportTabCtx` is rebuilt per render
 * (see `importCtxFor`), so the picker must reach whichever one is current.
 */
let _rerender: (() => void) | null = null;
let _picker: ReturnType<typeof createModelPicker> | null = null;

function modelPicker() {
  _picker ??= createModelPicker({
    className: "new-project-import-model",
    getModel: () => _model || preferredModel(),
    // A draft, deliberately not `setModel` — see `_model`.
    onChange: (id) => {
      _model = id;
    },
    requestRender: () => _rerender?.(),
  });
  return _picker;
}

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
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

/**
 * The brief this form has gathered, or null when something is still missing (the modal has already
 * rendered the reason inline).
 *
 * Exported so a test can read what the form would hand over without driving the assistant.
 *
 * @param {ImportTabCtx} ctx
 * @returns {ImportBrief | null}
 */
export function importBriefFor(ctx: ImportTabCtx): ImportBrief | null {
  let parsed: URL;
  try {
    parsed = new URL(_url.trim());
  } catch {
    _errorMsg = "Enter a valid URL (e.g. https://example.com)";
    ctx.rerender();
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    _errorMsg = "The URL must start with http:// or https://";
    ctx.rerender();
    return null;
  }
  const destination = ctx.resolveDestination();
  if (!destination || destination.kind !== "path") {
    return null;
  }
  return {
    aiComponents: _aiNaming,
    depth: _depth,
    directory: destinationPath(destination, ctx.form.directory),
    maxPages: _maxPages,
    model: _model,
    name: ctx.form.name.trim(),
    prompt: _prompt.trim(),
    url: parsed.href,
    verify: _verify,
  };
}

/**
 * Hand the brief to the assistant and close the wizard. Wired to the modal footer's primary button.
 *
 * **The wizard does not run the import any more.** It used to, and the run's whole account of
 * itself — every phase line, every warning — was destroyed the moment it succeeded and the modal
 * handed off. It is a tool call now (`services/ai-import-tools.ts`), so the progress lives in the
 * transcript, the model can read what the crawl actually found, and it can stop and ask about
 * anything the pipeline had to guess at.
 *
 * @param {ImportTabCtx} ctx
 */
export function handoffImport(ctx: ImportTabCtx) {
  if (!getPlatform().importSite) {
    return;
  }
  const brief = importBriefFor(ctx);
  if (!brief) {
    return;
  }
  /* Stored HERE, by the form that gathered it, rather than inside the assistant's hand-off: two
     readers need it — the turn that gets composed now, and `import_site` minutes later for the
     destination — and the producer is the one place both can be sure it was written. */
  setPendingImportBrief(brief);
  ctx.onHandoff(brief);
}

/** The footer's primary-button label. One state: the wizard hands off and closes. */
export function importButtonLabel(): string {
  return "Import Site";
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

export function renderImportSource(ctx: ImportTabCtx): TemplateResult {
  // `ctx` is rebuilt per render, so the picker's scheduler has to be re-pointed at the current one.
  _rerender = ctx.rerender;
  if (!ctx.aiGateOpen()) {
    return html`
      <div class="new-project-tab-intro">
        Importing uses an AI-guided pipeline to clone an existing site.
        ${
          ctx.managedConnect.canOffer()
            ? "Connect Cloudflare, or add an OpenAI-compatible API key, to continue."
            : "Add an OpenAI-compatible API key to continue."
        }
      </div>
      <div class="new-project-creds">${ctx.managedConnect.render()} ${ctx.credsForm.render()}</div>
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
    <sp-switch
      ?checked=${_verify}
      @change=${(e: Event) => {
        _verify = (e.target as HTMLInputElement).checked;
      }}
    >
      Check fidelity against the original (slower)
    </sp-switch>
    <label class="new-project-field">
      <span class="new-project-label">Model</span>
      ${modelPicker().render()}
    </label>
    <label class="new-project-field">
      <span class="new-project-label">What should the assistant do with it?</span>
      <sp-textfield
        multiline
        class="new-project-import-prompt"
        placeholder="Keep the layout but modernise the typography, and turn the news list into a content collection…"
        .value=${_prompt}
        @input=${(e: Event) => {
          _prompt = (e.target as HTMLInputElement).value;
        }}
      ></sp-textfield>
    </label>
    ${_errorMsg ? html`<div class="new-project-error">${_errorMsg}</div>` : ""}
  `;
}
