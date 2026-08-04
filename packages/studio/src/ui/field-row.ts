/// <reference lib="dom" />
/**
 * Field-row.js — Universal field row layout for all Studio panels.
 *
 * Renders the consistent pattern: indicator dot + label + widget slot, plus §7.1's **third
 * notification tier** — an `error` line rendered at the control, under the widget it belongs to.
 *
 * The other two tiers are hosted records in `services/notify.ts`: a toast is taken away on a timer,
 * a problem is kept until somebody fixes it. An inline error is neither, because it is not a record
 * at all — it is a property of the value currently in the field, and it lives exactly as long as
 * that value does. Which is the point: a rejected value used to be announced in a three-second grey
 * line at the bottom of the window, hundreds of pixels from the field that rejected it, and by the
 * time you looked down the field had snapped back and the reason was gone.
 *
 * Every panel that renders a field row inherits it: style, attributes, frontmatter, signals,
 * schema-driven settings forms. A consumer with a message passes one; a consumer with none passes
 * nothing and the row is exactly what it was.
 *
 * **Validated on commit, never on input** (§7.1). Producers decide a value is bad on `change` or
 * blur, not on `input` — a field cannot spend the middle of every word telling you it is wrong.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";

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
 * Render a universal field row with indicator dot, label, widget, and an optional inline error.
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
  error,
  errorCount,
}: FieldRowOptions) {
  const invalid = Boolean(error);
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
        ${
          hasValue && onClear
            ? html`<span
                class="set-dot"
                title="Clear ${prop}"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  onClear();
                }}
              ></span>`
            : nothing
        }
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
