/**
 * `choiceField` — one labelled choice, rendered the way every Spectrum picker in Studio is.
 *
 * It exists so the New File dialog's format picker and the Convert dialog's target picker are the
 * SAME control rather than two that drift: same divider idiom for a sentinel row, same `live()`
 * guard, same "one kind is not a choice" collapse to static text.
 *
 * **It imports lit only.** Both callers live in modules the other imports — `ui/layers.ts` is
 * imported by `format/convert-file.ts`, which also wants this fragment — so a shared control that
 * reached into either would be a cycle, and `import/no-cycle` is an error here.
 *
 * `.value=${live(...)}` is not stylistic. `sp-picker` writes its own `value` when the reader picks
 * a row, so lit's dirty check sees the value it last committed and skips the re-commit that would
 * put the control back where the model says it is. `scripts/check-lit-conventions.ts` fails on the
 * unguarded form.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import type { TemplateResult } from "lit-html";

/** One row of a {@link choiceField}. */
export interface ChoiceOption {
  value: string;
  label: string;
  /** Draw an `sp-menu-divider` immediately before this row — how a sentinel row is set apart. */
  dividerBefore?: boolean;
}

/** What a {@link choiceField} renders and reports. */
export interface ChoiceSpec {
  label: string;
  options: readonly ChoiceOption[];
  value: string;
  onChange: (next: string) => void;
}

/**
 * A labelled picker, or static text when there is nothing to choose.
 *
 * The collapse is the rule `panels/pane-context.ts` already states about editor kinds: **one kind
 * is not a choice**. A picker whose menu holds a single row is a control that cannot do anything,
 * and drawing it invites the reader to open it and find out.
 *
 * @param spec - The label, the rows, the current value and the change sink.
 * @returns The fragment, for a caller's own template.
 */
export function choiceField(spec: ChoiceSpec): TemplateResult {
  const current = spec.options.find((option) => option.value === spec.value);
  if (spec.options.length < 2) {
    return html`<div class="choice-row">
      <sp-field-label size="s">${spec.label}</sp-field-label>
      <span class="choice-static">${current?.label ?? spec.value}</span>
    </div>`;
  }
  return html`<div class="choice-row">
    <sp-field-label size="s">${spec.label}</sp-field-label>
    <sp-picker
      size="s"
      label=${spec.label}
      .value=${live(spec.value)}
      @change=${(e: Event) => spec.onChange((e.target as HTMLInputElement).value)}
    >
      ${spec.options.map(
        (option) =>
          html`${
              option.dividerBefore === true ? html`<sp-menu-divider></sp-menu-divider>` : nothing
            }<sp-menu-item value=${option.value}>${option.label}</sp-menu-item>`,
      )}
    </sp-picker>
  </div>`;
}
