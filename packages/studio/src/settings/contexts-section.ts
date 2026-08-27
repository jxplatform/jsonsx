/// <reference lib="dom" />
/**
 * Contexts — the ONE place a project's rendering contexts are defined (plan §4.2, §2 principle 5).
 *
 * A rendering context is anything the document can be resolved _under_: a size breakpoint, a colour
 * scheme, a feature query. All three are the same thing on disk — one entry in `project.json`'s
 * `$media` map — and until this section existed they were **defined in four places**, none of which
 * said "context" and only one of which said "breakpoint":
 *
 * 1. The New Project wizard's four breakpoint presets, described by media-query direction;
 * 2. Settings › General's "Breakpoints" field;
 * 3. Properties › Media, which renders **only when the document root is selected** — so adding a
 *    breakpoint cost you your element selection, the Style tab's scope, and your place;
 * 4. The CSS Variables editor's "Enable dark scheme" button, which appended `'--dark':
 *    '(prefers-color-scheme: dark)'` to `$media` **without ever using the word breakpoint**, so the
 *    one control that created a colour scheme was filed under variables.
 *
 * All four are gone. §2 principle 5 is why: **definition and selection are different levels.** The
 * pane context bar's Rendering-context control _selects_ among these; its popover's footer is
 * "Manage contexts…", which opens this section. Nothing here selects, and nothing there defines.
 *
 * **This section writes the project, not the document.** Per-document `$media` overlays still merge
 * at render time (`site-context.ts`'s `getEffectiveMedia`) and the on-disk format is unchanged —
 * what moved is the authoring surface, from a panel that required a selection to a settings section
 * that requires only a project.
 *
 * Failures are surfaced, not swallowed: every write runs through {@link persistMedia}, which
 * schema-validates the candidate `project.json` with `jx-validate` first (the human editing this
 * file used to get **no validation at all** — that was wired to the AI's `write_project_config`
 * alone), parks any rejection under the control that caused it, and re-renders. §7.1's third tier:
 * a bad value belongs at its control, not in a toast that expires.
 *
 * @docs studio/projects/settings
 */

import { html, render as litRender, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { errorMessage } from "@jxsuite/schema/parse";
import { projectState } from "../store";
import { updateSiteConfig } from "../site-context";
import { validateProjectConfig } from "../services/jx-validate";
import { isSchemeQuery, schemeOfQuery } from "../utils/canvas-media";
import { mediaDisplayName } from "../panels/shared";

import type { ProjectConfig } from "@jxsuite/schema/types";

/** The `$media` key the base width lives under. Not a query — a number of CSS pixels. */
const BASE_KEY = "--";

/** What a new size breakpoint starts as. Narrow-first, because `--` is the widest canvas. */
const NEW_BREAKPOINT_QUERY = "(max-width: 768px)";

/** What a new feature query starts as — a real query, so the row is valid the moment it exists. */
const NEW_FEATURE_QUERY = "(prefers-reduced-motion: reduce)";

/** The three kinds of context, in the order they are defined and rendered. */
export type ContextKind = "size" | "scheme" | "feature";

/** One `$media` entry, classified. */
export interface ContextEntry {
  key: string;
  query: string;
  kind: ContextKind;
}

/**
 * Which kind of context an entry is.
 *
 * The classification is the same one the canvas makes (`utils/canvas-media.ts`) so a row defined
 * here lands in the group the pane context bar will show it in — a size breakpoint gets a canvas
 * width, a scheme query drives the Auto/Light/Dark segment, and everything else is a plain toggle.
 * Deriving it from the query rather than storing it is what keeps the on-disk format unchanged.
 *
 * @param {string} query
 * @returns {ContextKind}
 */
export function contextKindOf(query: string): ContextKind {
  if (isSchemeQuery(query)) {
    return "scheme";
  }
  return /(?:min|max)-width:/.test(query) ? "size" : "feature";
}

/**
 * Split a `$media` map into the base width and the three context groups.
 *
 * @param {Record<string, string> | undefined} media
 * @returns {{ base: string; entries: ContextEntry[] }}
 */
export function splitContexts(media?: Record<string, string> | undefined): {
  base: string;
  entries: ContextEntry[];
} {
  const source = media ?? {};
  const entries: ContextEntry[] = [];
  for (const [key, raw] of Object.entries(source)) {
    if (key === BASE_KEY) {
      continue;
    }
    const query = String(raw);
    entries.push({ key, kind: contextKindOf(query), query });
  }
  return { base: String(source[BASE_KEY] ?? ""), entries };
}

/**
 * The `$media` key a typed name becomes: `Wide screen` → `--wide-screen`.
 *
 * Typing the leading dashes is allowed but never required — the dashes are a storage detail of the
 * CSS custom-property namespace `$media` shares, and §8.4 says a definition surface may not make
 * the user spell one.
 *
 * @param {string} name
 * @returns {string}
 */
export function contextKeyOf(name: string): string {
  const slug = name
    .trim()
    .replace(/^-+/, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug ? `--${slug}` : "";
}

// ─── Per-container error state ────────────────────────────────────────────────

/**
 * Where an error belongs. A `$media` key addresses the row it came from; `"base"` is the base-width
 * field and `"section"` is a whole-file write failure with no single guilty control.
 */
type ErrorTarget = string;

/**
 * The last failure, per rendered container.
 *
 * Keyed by container so two mounted copies (and two tests) never share a message — the same reason
 * `general-settings.ts` does it. One at a time is deliberate: settings persist on change, so there
 * is exactly one write in flight and exactly one thing that just went wrong.
 */
const errors = new WeakMap<HTMLElement, { target: ErrorTarget; message: string }>();

/**
 * Schema errors the file already had when this section last wrote to it.
 *
 * Reported at section level rather than under a control, because they belong to no control — and
 * kept per container for the same reason {@link errors} is. Populated by the first write, since
 * validating on every render would compile a schema for a section nobody is editing.
 */
const inheritedErrors = new WeakMap<HTMLElement, string[]>();

/** Read the current failure for a container — exported for tests and for re-render helpers. */
export function contextsError(container: HTMLElement): { target: string; message: string } | null {
  return errors.get(container) ?? null;
}

// ─── Render ───────────────────────────────────────────────────────────────────

/**
 * Render Project Settings › Contexts into `container`.
 *
 * @param {HTMLElement} container
 */
export function renderContextsSection(container: HTMLElement): void {
  const config = (projectState?.projectConfig || {}) as ProjectConfig;
  const media = (config.$media || {}) as Record<string, string>;
  const shown = errors.get(container);
  const { base, entries } = splitContexts(media);

  /** Park a failure under one control without writing anything. */
  const reject = (target: ErrorTarget, message: string) => {
    errors.set(container, { message, target });
    renderContextsSection(container);
  };

  /**
   * Write a whole `$media` map, validating it first and surfacing whatever refuses it.
   *
   * Both failure modes are real and both used to be invisible here: the schema can refuse the
   * shape, and the disk can refuse the write. The predecessor surfaces (`Properties › Media` and
   * the CSS-variables "Enable dark scheme") did `void updateSiteConfig(...)` and dropped the
   * rejection, so a failed write read as the field snapping back for no reason.
   *
   * **Only the errors THIS edit introduces block it.** The candidate is the whole `project.json`,
   * so a violation anywhere else in the file used to refuse every context edit and park the reason
   * under whichever control had been touched — typing `1280px` into Base width reported three
   * unevaluated-property errors about `title`, `description` and `$style`, none of which is a
   * width. The baseline is validated first and subtracted, the same way `services/ai-tools.ts`
   * subtracts it before blaming the model for a document it inherited. A pre-existing problem is
   * still worth saying, so it is reported once at section level, where a whole-file problem belongs
   * — and it is reported rather than repaired, because `project.json` is the author's file and a
   * settings screen that silently drops keys it did not recognise is worse than one that names
   * them.
   */
  const persistMedia = async (next: Record<string, string>, target: ErrorTarget) => {
    const candidate = { ...config, $media: next } as unknown;
    let schemaErrors: string[] = [];
    let inherited: string[] = [];
    try {
      inherited = await validateProjectConfig(config);
      const found = await validateProjectConfig(candidate);
      schemaErrors = found.filter((error) => !inherited.includes(error));
    } catch (error) {
      /* A validator that cannot compile must not block the edit — but it must not be silent
         either, so the message rides the same inline slot the schema errors would have used. */
      reject(target, `Could not validate project.json — ${errorMessage(error)}`);
      return;
    }
    if (schemaErrors.length > 0) {
      reject(target, schemaErrors.join("; "));
      return;
    }
    inheritedErrors.set(container, inherited);
    try {
      await updateSiteConfig({ $media: next });
      errors.delete(container);
    } catch (error) {
      errors.set(container, {
        message: `Could not save project.json — ${errorMessage(error)}`,
        target,
      });
    }
    renderContextsSection(container);
  };

  /**
   * What is already wrong with `project.json`, said once and not blamed on a control.
   *
   * It does not block anything — the edit that surfaced it went through. It is here because a file
   * that fails its own schema will keep failing it, and until this notice existed the only place
   * that fact appeared was as an unexplained refusal of an unrelated field.
   */
  const inheritedNotice = () => {
    const inherited = inheritedErrors.get(container) ?? [];
    return inherited.length === 0
      ? nothing
      : html`<p class="settings-section-notice" role="status">
          project.json has ${inherited.length} pre-existing schema
          ${inherited.length === 1 ? "problem" : "problems"} that this section did not cause:
          ${inherited.join("; ")}
        </p>`;
  };

  /** The error line for one control, when that is where the current failure belongs. */
  const errorFor = (target: ErrorTarget) =>
    shown?.target === target
      ? html`<p class="settings-field-error" role="alert">${shown.message}</p>`
      : nothing;

  // ─── Base width ────────────────────────────────────────────────────────────

  const onBaseChange = (e: Event) => {
    const value = (e.target as HTMLInputElement).value.trim();
    if (value && !/^\d+px$/.test(value)) {
      reject("base", "Enter a width in pixels, like 1280px.");
      return;
    }
    const next = { ...media };
    if (value) {
      next[BASE_KEY] = value;
    } else {
      delete next[BASE_KEY];
    }
    void persistMedia(next, "base");
  };

  // ─── Row editing ───────────────────────────────────────────────────────────

  const onRename = (oldKey: string) => (e: Event) => {
    const newKey = contextKeyOf((e.target as HTMLInputElement).value);
    if (!newKey) {
      reject(oldKey, "A context needs a name.");
      return;
    }
    if (newKey === oldKey) {
      return;
    }
    if (newKey in media) {
      reject(oldKey, `"${mediaDisplayName(newKey)}" is already defined.`);
      return;
    }
    /* Rebuild in place so renaming never reorders the list — the order is the order the pane
       context bar offers them in, and a rename is not a reordering. */
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(media)) {
      next[key === oldKey ? newKey : key] = value;
    }
    void persistMedia(next, newKey);
  };

  const onQueryChange = (key: string) => (e: Event) => {
    const query = (e.target as HTMLInputElement).value.trim();
    if (!query) {
      reject(key, "A context needs a media query, like (max-width: 768px).");
      return;
    }
    void persistMedia({ ...media, [key]: query }, key);
  };

  const onRemove = (key: string) => () => {
    const next = { ...media };
    delete next[key];
    void persistMedia(next, "section");
  };

  /** Add an entry under the first free `--<stem>` / `--<stem>-2` … name. */
  const add = (stem: string, query: string) => () => {
    let key = `--${stem}`;
    let n = 2;
    while (key in media) {
      key = `--${stem}-${n}`;
      n += 1;
    }
    void persistMedia({ ...media, [key]: query }, key);
  };

  /** The scheme picker writes the canonical query, so a scheme is never mistyped into a feature. */
  const onSchemeChange = (key: string) => (e: Event) => {
    const scheme = (e.target as HTMLInputElement).value;
    void persistMedia({ ...media, [key]: `(prefers-color-scheme: ${scheme})` }, key);
  };

  // ─── Group templates ───────────────────────────────────────────────────────

  const removeButton = (key: string) => html`
    <sp-action-button
      size="s"
      quiet
      data-remove=${key}
      title="Remove ${mediaDisplayName(key)}"
      @click=${onRemove(key)}
    >
      ×
    </sp-action-button>
  `;

  const nameField = (key: string) => html`
    <sp-textfield
      size="s"
      class="settings-media-name"
      .value=${live(key.replace(/^--/, ""))}
      placeholder="name"
      ?invalid=${shown?.target === key}
      @change=${onRename(key)}
    ></sp-textfield>
  `;

  const queryRow = (entry: ContextEntry) => html`
    <div class="settings-media-row" data-context=${entry.key}>
      ${nameField(entry.key)}
      <sp-textfield
        size="s"
        class="settings-media-value"
        .value=${live(entry.query)}
        placeholder=${NEW_BREAKPOINT_QUERY}
        ?invalid=${shown?.target === entry.key}
        @change=${onQueryChange(entry.key)}
      ></sp-textfield>
      ${removeButton(entry.key)}
    </div>
    ${errorFor(entry.key)}
  `;

  const schemeRow = (entry: ContextEntry) => html`
    <div class="settings-media-row" data-context=${entry.key}>
      ${nameField(entry.key)}
      <sp-picker
        size="s"
        class="settings-media-value"
        label="Scheme"
        .value=${schemeOfQuery(entry.query) ?? "dark"}
        @change=${onSchemeChange(entry.key)}
      >
        <sp-menu-item value="light">Light</sp-menu-item>
        <sp-menu-item value="dark">Dark</sp-menu-item>
      </sp-picker>
      ${removeButton(entry.key)}
    </div>
    ${errorFor(entry.key)}
  `;

  const group = (
    kind: ContextKind,
    label: string,
    desc: string,
    row: (entry: ContextEntry) => unknown,
    addLabel: string,
    onAdd: () => void,
    empty: string,
  ) => {
    const rows = entries.filter((entry) => entry.kind === kind);
    return html`
      <div class="settings-field" data-context-group=${kind}>
        <label class="settings-field-label">${label}</label>
        <p class="settings-field-desc">${desc}</p>
        <div class="settings-media-list">
          ${
            rows.length === 0
              ? html`<p class="settings-field-desc">${empty}</p>`
              : rows.map((entry) => row(entry))
          }
        </div>
        <sp-action-button size="s" data-add=${kind} @click=${onAdd}>${addLabel}</sp-action-button>
      </div>
    `;
  };

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Contexts</h3>
      <p class="settings-field-desc">
        The conditions this project's pages are rendered under. Define them once here; choose
        between them on the pane's context control while you edit.
      </p>
      ${errorFor("section")} ${inheritedNotice()}

      <div class="settings-field">
        <label class="settings-field-label">Base width</label>
        <p class="settings-field-desc">
          How wide the canvas is when no other context applies. Styles written here apply
          everywhere.
        </p>
        <div class="settings-media-row">
          <span class="settings-media-name-fixed">Base</span>
          <sp-textfield
            size="s"
            class="settings-media-value"
            data-context="base"
            placeholder="1280px"
            .value=${live(base)}
            ?invalid=${shown?.target === "base"}
            @change=${onBaseChange}
          ></sp-textfield>
        </div>
        ${errorFor("base")}
      </div>

      ${group(
        "size",
        "Size breakpoints",
        "Screen widths that get their own canvas and their own style values.",
        queryRow,
        "+ Add breakpoint",
        add("breakpoint", NEW_BREAKPOINT_QUERY),
        "No breakpoints yet — every width uses the base styles.",
      )}
      ${group(
        "scheme",
        "Colour schemes",
        "Light and dark renderings. Defining one turns on the Auto / Light / Dark control.",
        schemeRow,
        "+ Add colour scheme",
        add("dark", "(prefers-color-scheme: dark)"),
        "No colour schemes yet — the project renders one way.",
      )}
      ${group(
        "feature",
        "Feature queries",
        "Anything else a media query can ask: reduced motion, print, hover, orientation.",
        queryRow,
        "+ Add feature query",
        add("feature", NEW_FEATURE_QUERY),
        "No feature queries yet.",
      )}
    </div>
  `;

  litRender(tpl, container);
}
