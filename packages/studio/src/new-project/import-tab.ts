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

import { html, nothing } from "lit-html";
import { live } from "lit/directives/live.js";
import { getPlatform } from "../platform";
import { preferredModel } from "../services/ai-models";
import { createModelPicker } from "../ui/ai-model-picker";
import { destinationPath } from "./location-fields";
import type { TemplateResult } from "lit-html";
import type { CreateProjectDestination, ImportBreakpointPolicy } from "../types";

import { setPendingImportBrief } from "../services/import-seed";
import type { ImportBrief } from "../services/import-seed";

/** The three answers the Breakpoints control offers. */
type BreakpointMode = "all" | "limit" | "explicit";

/** How a kept width matches one the site declared. */
type BreakpointRounding = "nearest" | "down" | "up";

/** The most breakpoints the control will offer to keep — `@jxsuite/import`'s own ceiling. */
const MAX_BREAKPOINTS = 12;

/**
 * The deepest crawl the pipeline accepts.
 *
 * The field said 2 while `import_site` and the endpoint both clamped to 5, so the wizard could not
 * ask for a depth the backend was willing to run.
 */
const MAX_DEPTH = 5;

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
   * missing (the modal has already rendered the reason inline). Either destination shape: a hosted
   * backend imports into a repository it creates, so `"repo"` reaches here too.
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
/**
 * How many of the site's breakpoints the project keeps, and how a kept width matches a declared
 * one.
 *
 * Three by default, and that default is the point of the control. A real site declares as many
 * breakpoints as it has accumulated frameworks — nine is ordinary — and the importer used to keep
 * every one, so an imported project opened with nine canvas sizes and nine columns in every style
 * editor. Nobody authors against nine, and nobody chose these nine.
 */
let _breakpointMode: BreakpointMode = "limit";
let _breakpointCount = 3;
let _breakpointWidths = "";
let _breakpointRounding: BreakpointRounding = "nearest";
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
/**
 * The average fidelity the clone has to reach before the run counts as having matched the original.
 *
 * A floor, not a quality target: a faithful import of a complicated site lands well under 100 for
 * reasons no importer can fix (a rotating hero, a font rendering a hair differently). What it
 * catches is the other case — the clone that came out at 8% and reported success anyway. Same
 * default as `jx-import --min-fidelity`, so the two surfaces answer the same question the same
 * way.
 *
 * Failing it is a FINDING here rather than a failure: the project is written and opened either way,
 * and the assistant reports that the bar was missed. The CLI turns the same number into an exit
 * code because a script in a pipeline has nobody to tell.
 */
let _minFidelity = 25;
let _errorMsg = "";
let _dirManual = false;

/** Reset the tab's state when the modal opens. */
export function resetImportTab() {
  _url = "";
  _depth = 1;
  _maxPages = 20;
  _breakpointMode = "limit";
  _breakpointCount = 3;
  _breakpointWidths = "";
  _breakpointRounding = "nearest";
  _aiNaming = true;
  _model = "";
  _prompt = "";
  _verify = false;
  _minFidelity = 25;
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

/**
 * The policy the three controls describe.
 *
 * Exported so a test can read what the form would send without driving the assistant, for the same
 * reason {@link importBriefFor} is.
 *
 * @returns {ImportBreakpointPolicy}
 */
export function breakpointPolicyFromForm(): ImportBreakpointPolicy {
  if (_breakpointMode === "all") {
    return { mode: "all" };
  }
  if (_breakpointMode === "explicit") {
    const widths = _breakpointWidths
      .split(",")
      .map((part) => Math.trunc(Number(part.trim())))
      .filter((width) => Number.isFinite(width) && width > 0);
    /* A half-typed width list is not an instruction to keep nothing. Until it parses into at least
       one width, the form still means "three, evenly spaced" — the value the field started from. */
    if (widths.length > 0) {
      return { mode: "explicit", rounding: _breakpointRounding, widths };
    }
  }
  return { count: _breakpointCount, mode: "limit", rounding: _breakpointRounding };
}

/**
 * Whether this backend can answer the fidelity question at all.
 *
 * `verify` builds the emitted project with the compiler and serves it to screenshot every page
 * against the original — it executes the project's own JavaScript, so `@jxsuite/import` keeps that
 * phase out of the portable pipeline entirely and a hosted backend deliberately never runs it.
 *
 * There is no PAL member for "this backend compiles", so the nearest DECLARED fact stands in:
 * `createDestination`. A `"repo"` platform commits the emitted project into a git tree it never
 * checks out, which is the same set of hosts and one the tab can read without naming a platform by
 * id. Offering the switch there would collect an answer nothing acts on.
 */
function canVerify(): boolean {
  return getPlatform().createDestination !== "repo";
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
  if (!destination) {
    return null;
  }
  return {
    aiComponents: _aiNaming,
    breakpoints: breakpointPolicyFromForm(),
    depth: _depth,
    directory: destinationPath(destination, ctx.form.directory),
    maxPages: _maxPages,
    model: _model,
    name: ctx.form.name.trim(),
    prompt: _prompt.trim(),
    minFidelity: _minFidelity,
    url: parsed.href,
    /* Never asked for where it cannot run: the switch is not rendered there, and a value left over
       from a session on another platform must not travel as a request the backend would ignore. */
    verify: canVerify() && _verify,
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

/**
 * The Breakpoints control: how many of the site's own breakpoints the project ends up with.
 *
 * Three controls rather than one because they answer different questions and only some of them
 * apply at a time — a count is meaningless once you have named the widths, and both are meaningless
 * when you are keeping everything. The rounding picker stays for the two that use it: it decides
 * which DECLARED width backs a kept one, and the styles flip where the site says they do.
 *
 * @param {ImportTabCtx} ctx
 * @returns {TemplateResult}
 */
function breakpointsField(ctx: ImportTabCtx): TemplateResult {
  const onMode = (e: Event) => {
    _breakpointMode = (e.target as HTMLInputElement).value as BreakpointMode;
    ctx.rerender();
  };
  return html`
    <label class="new-project-field">
      <span class="new-project-label">Breakpoints</span>
      <div class="new-project-import-breakpoints">
        <sp-picker
          size="m"
          class="new-project-breakpoint-mode"
          label="Breakpoints"
          .value=${live(_breakpointMode)}
          @change=${onMode}
        >
          <sp-menu-item value="limit">Limit to</sp-menu-item>
          <sp-menu-item value="explicit">Custom widths</sp-menu-item>
          <sp-menu-item value="all">Keep all</sp-menu-item>
        </sp-picker>
        ${
          _breakpointMode === "limit"
            ? html`<sp-number-field
                class="new-project-breakpoint-count"
                min="1"
                max=${MAX_BREAKPOINTS}
                .value=${live(_breakpointCount)}
                @change=${(e: Event) => {
                  _breakpointCount = Math.trunc(Number((e.target as HTMLInputElement).value)) || 3;
                }}
              ></sp-number-field>`
            : nothing
        }
        ${
          _breakpointMode === "explicit"
            ? html`<sp-textfield
                class="new-project-breakpoint-widths"
                placeholder="640, 1024, 1440"
                .value=${live(_breakpointWidths)}
                @input=${(e: Event) => {
                  _breakpointWidths = (e.target as HTMLInputElement).value;
                }}
              ></sp-textfield>`
            : nothing
        }
        ${
          _breakpointMode === "all"
            ? nothing
            : html`<sp-picker
                size="m"
                class="new-project-breakpoint-rounding"
                label="Rounding"
                .value=${live(_breakpointRounding)}
                @change=${(e: Event) => {
                  _breakpointRounding = (e.target as HTMLInputElement).value as BreakpointRounding;
                }}
              >
                <sp-menu-item value="nearest">nearest</sp-menu-item>
                <sp-menu-item value="down">round down</sp-menu-item>
                <sp-menu-item value="up">round up</sp-menu-item>
              </sp-picker>`
        }
      </div>
      <span class="new-project-hint">
        ${
          _breakpointMode === "all"
            ? "Every breakpoint the site declares becomes a canvas size. Real sites often declare nine."
            : _breakpointMode === "explicit"
              ? "The project gets these widths, each backed by the declared width nearest it."
              : "Evenly spaced across the widths the site declares — the narrowest, the widest, and the ones between."
        }
      </span>
    </label>
  `;
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
        .value=${live(_url)}
        @input=${onUrlInput(ctx)}
        style="width: 100%"
      ></sp-textfield>
    </label>
    <div class="new-project-import-grid">
      <label class="new-project-field">
        <span class="new-project-label">Crawl Depth</span>
        <sp-number-field
          min="0"
          max=${MAX_DEPTH}
          .value=${live(_depth)}
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
          .value=${live(_maxPages)}
          @change=${(e: Event) => {
            _maxPages = Math.trunc(Number((e.target as HTMLInputElement).value)) || 1;
          }}
        ></sp-number-field>
      </label>
    </div>
    ${breakpointsField(ctx)}
    <sp-switch
      .checked=${live(_aiNaming)}
      @change=${(e: Event) => {
        _aiNaming = (e.target as HTMLInputElement).checked;
      }}
    >
      AI component naming
    </sp-switch>
    ${
      canVerify()
        ? html`<sp-switch
            .checked=${live(_verify)}
            @change=${(e: Event) => {
              _verify = (e.target as HTMLInputElement).checked;
              // The bar below it only means anything while the check runs, so it appears with it.
              ctx.rerender();
            }}
          >
            Check fidelity against the original (slower)
          </sp-switch>`
        : nothing
    }
    ${
      canVerify() && _verify
        ? html`
            <label class="new-project-field">
              <span class="new-project-label">Minimum fidelity</span>
              <sp-number-field
                class="new-project-min-fidelity"
                min="0"
                max="100"
                .value=${live(_minFidelity)}
                @change=${(e: Event) => {
                  const raw = Math.trunc(Number((e.target as HTMLInputElement).value));
                  _minFidelity = Number.isNaN(raw) ? 0 : Math.min(100, Math.max(0, raw));
                }}
              ></sp-number-field>
              <span class="new-project-hint">
                Below this average, the assistant reports that the clone did not match the original.
                A floor rather than a target: a faithful import of a complicated site still lands
                well under 100. Set 0 to report the score without judging it.
              </span>
            </label>
          `
        : ""
    }
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
        .value=${live(_prompt)}
        @input=${(e: Event) => {
          _prompt = (e.target as HTMLInputElement).value;
        }}
      ></sp-textfield>
    </label>
    ${_errorMsg ? html`<div class="new-project-error">${_errorMsg}</div>` : ""}
  `;
}
