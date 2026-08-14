/// <reference lib="dom" />
/**
 * Field-row.js — the inspector's row vocabulary, in one module.
 *
 * Three rows, and every panel that draws one imports it from here:
 *
 * - {@link renderFieldRow} — label + widget, plus §7.1's **third notification tier** (an `error` line
 *   rendered at the control) and §6.2's **provenance chip** (where this value came from). The chip
 *   itself is `panels/provenance.ts`'s: one vocabulary, two cascades, one template.
 * - {@link renderKvRow} — an editable key/value pair with a delete affordance. Custom attributes and
 *   custom CSS properties are the same row; they were two.
 * - {@link renderStaticKvRow} — the read-only name/value line. Observed Attributes, CSS Properties
 *   and CSS Parts each hand-wrote it with the same inline style declarations.
 *
 * **The error line.** The other two notification tiers are hosted records in `services/notify.ts`:
 * a toast is taken away on a timer, a problem is kept until somebody fixes it. An inline error is
 * neither, because it is not a record at all — it is a property of the value currently in the
 * field, and it lives exactly as long as that value does. Which is the point: a rejected value used
 * to be announced in a three-second grey line at the bottom of the window, hundreds of pixels from
 * the field that rejected it, and by the time you looked down the field had snapped back and the
 * reason was gone.
 *
 * **Validated on commit, never on input** (§7.1). Producers decide a value is bad on `change` or
 * blur, not on `input` — a field cannot spend the middle of every word telling you it is wrong.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { renderProvenanceChip } from "../panels/provenance";

import type { FieldProvenance } from "../panels/provenance";

// ─── The field row ───────────────────────────────────────────────────────────

/** Options for {@link renderFieldRow}. */
export interface FieldRowOptions {
  prop: string;
  label: string;
  hasValue: boolean;
  onClear?: () => void;
  widget: unknown;
  /** Rendered after the label inside the label cell (e.g. the dynamic-slot mode button). */
  labelExtra?: unknown;
  span?: number;
  warning?: boolean;
  /**
   * Where this value came from (§6.2). When omitted the row derives the `set`/`default` pair from
   * `hasValue` and `onClear`, which is what every caller meant by them all along; a caller that can
   * answer the richer question passes the answer.
   */
  provenance?: FieldProvenance | undefined;
  /**
   * Why the value in this control is not acceptable — §7.1's inline tier.
   *
   * Rendered under the widget in danger colour with `role="alert"`, so a screen reader announces it
   * when it appears. Presence also marks the row invalid, so the state is legible without reading:
   * `warning` says "this is unusual", `error` says "this is refused".
   *
   * Empty string and `undefined` both mean "no error", so a producer can pass its validator's
   * output straight through without a ternary.
   */
  error?: string | undefined;
  /**
   * How many times this value has been refused in a row — the "message + counter" §7.1 asks for.
   *
   * A repeat count is the difference between "the field is still red from last time" and "it just
   * refused me again", which is otherwise invisible when the second attempt fails the same way.
   * Rendered from 2 up.
   */
  errorCount?: number | undefined;
}

/**
 * Render a universal field row with a provenance chip, label, widget, and an optional inline error.
 *
 * @param {FieldRowOptions} opts
 * @returns {import("lit-html").TemplateResult}
 */
export function renderFieldRow({
  prop,
  label,
  hasValue,
  onClear,
  widget,
  labelExtra,
  span,
  warning,
  provenance,
  error,
  errorCount,
}: FieldRowOptions) {
  const invalid = Boolean(error);
  const chip: FieldProvenance | undefined =
    provenance ??
    (hasValue && onClear ? { onClick: onClear, state: "set", title: `Clear ${prop}` } : undefined);
  return html`
    <div
      class=${classMap({
        "style-row": true,
        "style-row--invalid": invalid,
        "style-row--warning": Boolean(warning) && !invalid,
      })}
      data-prop=${prop}
      style=${span === 2 ? "grid-column: 1 / -1" : ""}
    >
      <div class="style-row-label">
        ${chip ? renderProvenanceChip(prop, chip) : nothing}
        <sp-field-label size="s" title=${prop}>${label}</sp-field-label>
        ${labelExtra ?? nothing}
      </div>
      ${widget}
      ${
        invalid
          ? html`<p class="style-row-error" role="alert">
              ${error}${
                errorCount !== undefined && errorCount > 1
                  ? html`<span class="style-row-error-count">×${errorCount}</span>`
                  : nothing
              }
            </p>`
          : nothing
      }
    </div>
  `;
}

// ─── The editable key/value row ──────────────────────────────────────────────

/** Options for {@link renderKvRow}. */
export interface KvRowOptions {
  /** The pair's current key. */
  name: string;
  /** The pair's current value. */
  value: string;
  /** Commit both cells, debounced, with the current contents of each. */
  onCommit: (name: string, value: string) => void;
  /** Remove the pair outright. */
  onDelete: () => void;
  /**
   * The value cell's placeholder, resolved from the key — a CSS property's initial value, say.
   *
   * A resolver rather than a string because the key is editable: typing `display` into the key cell
   * should offer `inline` under it before anything is committed, and only the caller knows the
   * map.
   */
  placeholderFor?: ((name: string) => string) | undefined;
  /** Debounce before {@link KvRowOptions.onCommit}, in ms. */
  debounceMs?: number;
}

/**
 * An editable key/value pair with a delete affordance — the ONE implementation.
 *
 * Custom HTML attributes and custom CSS properties are the same row and were written twice, with
 * different rename behaviour (one committed on `input`, the other on `change`) and different
 * placeholder plumbing. They now differ only in what they pass in.
 *
 * @param {KvRowOptions} opts
 */
export function renderKvRow({
  name,
  value,
  onCommit,
  onDelete,
  placeholderFor,
  debounceMs = 400,
}: KvRowOptions) {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let currentName = name;
  let currentValue = value;
  const commit = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => onCommit(currentName, currentValue), debounceMs);
  };
  return html`
    <div class="kv-row" data-prop=${name}>
      <sp-textfield
        size="s"
        class="kv-key"
        .value=${name}
        @input=${(e: Event) => {
          currentName = (e.target as HTMLInputElement).value;
          commit();
        }}
        @change=${
          placeholderFor
            ? (e: Event) => {
                const cell = (e.target as HTMLInputElement)
                  .closest(".kv-row")
                  ?.querySelector(".kv-val");
                cell?.setAttribute(
                  "placeholder",
                  placeholderFor((e.target as HTMLInputElement).value),
                );
              }
            : nothing
        }
      ></sp-textfield>
      <sp-textfield
        size="s"
        class="kv-val"
        .value=${value}
        placeholder=${placeholderFor ? placeholderFor(name) : ""}
        @input=${(e: Event) => {
          currentValue = (e.target as HTMLInputElement).value;
          commit();
        }}
      ></sp-textfield>
      <sp-action-button size="xs" quiet title="Remove ${name}" @click=${onDelete}>
        <sp-icon-close slot="icon"></sp-icon-close>
      </sp-action-button>
    </div>
  `;
}

// ─── The read-only key/value row ─────────────────────────────────────────────

/** Options for {@link renderStaticKvRow}. */
export interface StaticKvRowOptions {
  /** The thing being named — an attribute, a custom property, a part. Rendered as code. */
  name: string;
  /** What it maps to, rendered immediately after the name ("→ count", "<button>"). */
  detail?: string | undefined;
  /** Its value or type, rendered hard right. */
  value?: string | undefined;
  /** Flags, rendered hard right after the value ("reflects"). */
  tags?: readonly string[] | undefined;
}

/**
 * A read-only name/value line.
 *
 * Observed Attributes, CSS Properties and CSS Parts each hand-wrote this with the same
 * `display:flex;gap:6px;align-items:center;padding:2px 0;font-size:…` inline block — three copies
 * of one row, none of them addressable by a stylesheet, and so none of them able to respond to the
 * theme. They differ only in which of the three slots they fill.
 *
 * @param {StaticKvRowOptions} opts
 */
export function renderStaticKvRow({ name, detail, value, tags }: StaticKvRowOptions) {
  return html`
    <div class="kv-static-row" data-prop=${name}>
      <code class="kv-static-name">${name}</code>
      ${detail ? html`<span class="kv-static-detail">${detail}</span>` : nothing}
      ${value ? html`<span class="kv-static-value">${value}</span>` : nothing}
      ${(tags ?? []).map((tag) => html`<span class="kv-static-tag">${tag}</span>`)}
    </div>
  `;
}
