/**
 * Provenance — where the value in a field came from, as one chip (plan §6.2).
 *
 * Four states, and the two that carry information NAME THEIR SOURCE:
 *
 * | State     | Rendering                         | Click             |
 * | --------- | --------------------------------- | ----------------- |
 * | set       | accent dot                        | clear the value   |
 * | inherited | amber, "from Base" / "from Md"    | jump to the donor |
 * | default   | nothing — absence IS the ghost    | —                 |
 * | bound     | violet, naming the signal/formula | open the source   |
 * | mixed     | neutral, "mixed (3)" — see below  | clear across all  |
 *
 * **Mixed** is what a multi-selection says when the selected elements disagree about a field
 * (§6.5). It is a fifth state of THIS chip rather than a fifth widget, because it answers the same
 * question the other four answer — _where did the value in this box come from?_ — and the honest
 * answer is "from several places, and they differ". It names how many elements are involved, so
 * "mixed" never has to mean "some unknown number of things". Typing into a Mixed field commits the
 * new value to every selected element in one transaction; the chip's click clears it from all of
 * them, which is the same verb `set` has, applied to the same set.
 *
 * `set` and `default` are the only two the inspector could previously express, and it expressed
 * them as a dot or the absence of one. The other two were known at render time and thrown away: an
 * inherited style value arrived as an input placeholder, visually indistinguishable from the CSS
 * initial value `style-inputs.ts` renders into the same slot, and a `${…}`-bound value looked like
 * a literal that happened to contain braces.
 *
 * **One module, two cascades.** The Style tab reads provenance against the breakpoint / scheme /
 * site-token cascade; Component Props reads it against the component's declared defaults. Same
 * question, same words, same chip — so the two surfaces cannot drift into two vocabularies for one
 * idea. The chip's CSS lives in `styles/inspector.css` beside `.set-dot`, which the `set` state
 * reuses outright: a 6px accent dot that clears the value on click is exactly what the set state
 * has always been, and every stylesheet rule and test that addresses `.set-dot` keeps addressing
 * the same thing.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";

/** The states of §6.2 (four) plus §6.5's `mixed`, in the order the table lists them. */
export type ProvenanceState = "set" | "inherited" | "default" | "bound" | "mixed";

/** Where one field's value came from, and what clicking the chip does about it. */
export interface FieldProvenance {
  state: ProvenanceState;
  /**
   * Who supplied the value, in the words a reader would use — `"Base"`, `"Md"`, `"site tokens"`,
   * `"the component default"`, or a signal name. Rendered verbatim after the word "from" for
   * `inherited`, and on its own for `bound`, so a caller passes the noun and never the preposition.
   * For `mixed` it is the COUNT of disagreeing elements, as a string.
   */
  donor?: string | undefined;
  /**
   * Clear (`set`), jump to the donor (`inherited`), open the source (`bound`). A chip with no
   * handler renders as a `<span>`, never a `<button>`: a control that looks pressable and does
   * nothing is the defect this phase exists to remove.
   */
  onClick?: (() => void) | undefined;
  /** Overrides the derived tooltip. */
  title?: string | undefined;
}

/** The lead word of the derived tooltip, per state. */
const PROVENANCE_TITLES: Readonly<Record<ProvenanceState, string>> = {
  bound: "Bound",
  default: "Not set",
  inherited: "Inherited",
  mixed: "Mixed",
  set: "Set here",
};

/** The chip's own text. The dots say nothing; the two informative states name a donor. */
function provenanceText(p: FieldProvenance): string {
  if (p.state === "inherited") {
    return p.donor ? `from ${p.donor}` : "inherited";
  }
  if (p.state === "bound") {
    return p.donor ?? "bound";
  }
  if (p.state === "mixed") {
    return p.donor ? `mixed (${p.donor})` : "mixed";
  }
  return "";
}

/** The tooltip a chip carries when the caller does not supply one. */
export function provenanceTitle(prop: string, p: FieldProvenance): string {
  if (p.title) {
    return p.title;
  }
  const lead = PROVENANCE_TITLES[p.state];
  if (p.state === "inherited") {
    return `${lead} from ${p.donor ?? "the cascade"} — click to go there`;
  }
  if (p.state === "bound") {
    return p.donor ? `${lead} to ${p.donor} — click to open it` : lead;
  }
  if (p.state === "set") {
    return `${lead} — click to clear ${prop}`;
  }
  if (p.state === "mixed") {
    const count = p.donor ? `${p.donor} selected elements` : "the selected elements";
    return `${lead} — ${count} have different values for ${prop}; typing sets them all`;
  }
  return `${lead} — ${prop} falls back to the browser default`;
}

/**
 * The provenance chip.
 *
 * `default` renders **nothing**, and that is the ghost: a dot on every unset row is 138 dots on the
 * Style tab and a uniform grey field on Content, which says less than silence. `.set-dot`'s own
 * documented rule already reads "only show when the property is explicitly set" (ui-guidelines
 * §4.2) — this keeps it, and gives the two states that were previously indistinguishable from
 * absence a chip of their own.
 *
 * @param {string} prop — the field key, used in the derived tooltip.
 * @param {FieldProvenance} p
 * @returns {import("lit-html").TemplateResult | typeof nothing}
 */
export function renderProvenanceChip(prop: string, p: FieldProvenance) {
  if (p.state === "default") {
    return nothing;
  }
  const text = provenanceText(p);
  const title = provenanceTitle(prop, p);
  const isDot = p.state === "set";
  const classes = classMap({
    "provenance-chip": true,
    [`provenance-chip--${p.state}`]: true,
    // The set state reuses `.set-dot`'s geometry — the chip is a generalisation of the dot, not a
    // Replacement for it, and a 6px circle is not a button.
    "set-dot": isDot,
  });
  const { onClick } = p;
  if (!onClick) {
    return html`<span class=${classes} title=${title}>${text}</span>`;
  }
  const activate = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  };
  return isDot
    ? html`<span class=${classes} title=${title} @click=${activate}>${text}</span>`
    : html`<button type="button" class=${classes} title=${title} @click=${activate}>
        ${text}
      </button>`;
}

// ─── Section summaries ────────────────────────────────────────────────────────

/** How many fields in a group are in each informative state. */
export interface ProvenanceCounts {
  set: number;
  inherited: number;
  bound: number;
  mixed: number;
}

/**
 * Tally a group of states.
 *
 * @param {Iterable<ProvenanceState>} states
 * @returns {ProvenanceCounts}
 */
export function countProvenance(states: Iterable<ProvenanceState>): ProvenanceCounts {
  const counts: ProvenanceCounts = { bound: 0, inherited: 0, mixed: 0, set: 0 };
  for (const state of states) {
    if (state !== "default") {
      counts[state] += 1;
    }
  }
  return counts;
}

/** Whether a tally has anything to show at all. */
export function hasProvenance(counts: ProvenanceCounts): boolean {
  return counts.set > 0 || counts.inherited > 0 || counts.bound > 0 || counts.mixed > 0;
}

/** "3 set here · 2 inherited · 1 bound" — the summary a collapsed section states on hover. */
export function provenanceSummaryText(counts: ProvenanceCounts): string {
  const parts: string[] = [];
  if (counts.set > 0) {
    parts.push(`${counts.set} set here`);
  }
  if (counts.inherited > 0) {
    parts.push(`${counts.inherited} inherited`);
  }
  if (counts.bound > 0) {
    parts.push(`${counts.bound} bound`);
  }
  if (counts.mixed > 0) {
    parts.push(`${counts.mixed} mixed`);
  }
  return parts.length > 0 ? parts.join(" · ") : "nothing set";
}

/**
 * A collapsed accordion heading's provenance dots.
 *
 * This is what retires the Style tab's "Active" filter toggle. That toggle existed for one reason —
 * with a section closed there was no way to tell whether anything inside it was set, so the only
 * way to find your own overrides was to hide every property that had none. A heading that says "3
 * set here · 2 inherited" answers the question without changing what the panel shows.
 *
 * The `set` dot keeps its clear-all handler, so the heading loses no affordance.
 *
 * @param {ProvenanceCounts} counts
 * @param {{ onClearSet?: () => void; clearTitle?: string }} opts
 */
export function renderProvenanceDots(
  counts: ProvenanceCounts,
  opts: { onClearSet?: (() => void) | undefined; clearTitle?: string | undefined } = {},
) {
  if (!hasProvenance(counts)) {
    return nothing;
  }
  const summary = provenanceSummaryText(counts);
  return html`
    <span class="provenance-dots" title=${summary} aria-label=${summary}>
      ${
        counts.set > 0
          ? renderProvenanceChip("section", {
              state: "set",
              title: opts.clearTitle ?? summary,
              ...(opts.onClearSet ? { onClick: opts.onClearSet } : {}),
            })
          : nothing
      }
      ${
        counts.inherited > 0
          ? html`<span
              class="provenance-chip provenance-chip--inherited set-dot"
              title=${summary}
            ></span>`
          : nothing
      }
      ${
        counts.bound > 0
          ? html`<span
              class="provenance-chip provenance-chip--bound set-dot"
              title=${summary}
            ></span>`
          : nothing
      }
      ${
        counts.mixed > 0
          ? html`<span
              class="provenance-chip provenance-chip--mixed set-dot"
              title=${summary}
            ></span>`
          : nothing
      }
    </span>
  `;
}
