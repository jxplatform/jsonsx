/// <reference lib="dom" />
/**
 * The Target Line — the Style tab's compound edit target, as one sentence (plan §6.1).
 *
 * ```text
 * ⌖  h1 · @md · :hover · dark variant                    [ all <h1> in this document ]
 * ```
 *
 * `style-panel.ts` has always computed this tuple exactly: it is the per-field key
 * (`style|${sel}|${editMedia}|${activeSelector}|${prop}`) and the five-branch if/else that picks
 * the commit function. What it did with it was hide it behind three disconnected widgets on two
 * different bars — a `<sp-tabs>` breakpoint strip, a `.selector-select` picker, and a
 * `.style-scheme-badge` whose class had **no CSS rule anywhere in the repo**, so the one control
 * that admitted the tab bar was overriding the panel rendered as unstyled inline text.
 *
 * Three rules shape what this module is allowed to be:
 *
 * 1. **Every segment is a control.** A sentence you cannot act on is a caption, and the panel already
 *    had one of those.
 * 2. **The Style tab does not own the breakpoint or the scheme.** Those axes are SELECTED on the pane
 *    context bar (region ⑦) and DEFINED in Project Settings › Contexts — §2 principle 5. The
 *    breakpoint and scheme segments therefore state the resolved value and route to the definition
 *    site; they do not offer a third list to pick from. The selector segment is the one axis this
 *    tab owns, so it is the one segment with a menu.
 * 3. **The scope chip is what makes Stylebook safe.** Entering Stylebook silently discards the element
 *    selection and converts every subsequent edit from "this element" to "every element of this
 *    tag" — with one line of text, after the fact, as the only signal. The chip states the blast
 *    radius BEFORE the first keystroke, and the project case is a warning band with an affected
 *    count and a "show affected" list.
 *
 * The count comes from `services/references.ts` where that query can answer, and says **"unknown"**
 * where it cannot. A confirmation may be silent; it may never be confidently wrong.
 */

import { html, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { classMap } from "lit-html/directives/class-map.js";

/** The overlay this module drives — `open` is `overlay-trigger`'s own declared state. */
interface SelectorTrigger extends HTMLElement {
  open?: string | undefined;
}

/** The live selector trigger, captured by the template's own `ref`. */
let _selectorTrigger: SelectorTrigger | null = null;

/**
 * Forget the trigger — the Inspector unmounted, or a test is starting clean.
 *
 * A module-local handle rather than a `querySelector` at call time: the line is rebuilt on every
 * Inspector render, so anything that resolved it once would hold a detached node.
 */
export function resetSelectorTrigger(): void {
  _selectorTrigger = null;
}

/**
 * Open the selector menu.
 *
 * `open = "click"` is the element's own declared state, which is the difference between a command
 * that presses a control and a manifest that hands a CSS selector to a synthetic mouse (§13).
 *
 * @throws {RangeError} When the Style tab is not rendered.
 */
export function openSelectorMenu(): void {
  if (!_selectorTrigger?.isConnected) {
    throw new RangeError(
      `command "style.openSelectorMenu" needs the Inspector's Style tab rendered; its selector ` +
        `menu is not in the document`,
    );
  }
  _selectorTrigger.open = "click";
}

/** Close it again — every menu choice does this, so the sentence is readable straight after. */
function closeSelectorMenu(): void {
  if (_selectorTrigger) {
    _selectorTrigger.open = undefined;
  }
}

// ─── The model ───────────────────────────────────────────────────────────────

/** One clickable word of the sentence. */
export interface TargetSegment {
  /** `element` | `media` | `scheme` — the axis, used as the segment's `data-seg`. */
  key: string;
  label: string;
  title: string;
  /** What clicking it opens. A segment with no action is not rendered as a button. */
  onActivate?: (() => void) | undefined;
}

/** The selector axis — the one the Style tab owns, so the one with a menu. */
export interface TargetSelector {
  /** The active nested selector, or `null` for the element's own base rule. */
  value: string | null;
  /** Every selector offerable right now: the common set ∪ what the element declares. */
  options: string[];
  /** Which options the element already declares — marked in the menu. */
  declared: Set<string>;
  onSelect: (selector: string | null) => void;
  /** Opens the Add Nested Selector dialog (`showPromptDialog`, ui-guidelines §8.7). */
  onAddCustom: () => void;
}

/** How wide the blast radius is, and what the app can say about it. */
export interface TargetScope {
  kind: "element" | "document" | "project";
  /** "this element" / "all `<h1>` in this document" / "all `<h1>` in this project". */
  label: string;
  /** The affected-count sentence — "312 elements in 24 files", or "unknown". */
  affected?: string | undefined;
  /** The files the count came from, for the "show affected" disclosure. */
  affectedFiles?: readonly { path: string; count: number }[] | undefined;
  showAffected?: boolean | undefined;
  onToggleAffected?: (() => void) | undefined;
}

export interface TargetLineModel {
  segments: TargetSegment[];
  selector: TargetSelector;
  scope: TargetScope;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function segmentTpl(segment: TargetSegment) {
  const cls = `tl-seg tl-seg--${segment.key}`;
  if (!segment.onActivate) {
    return html`<span class=${cls} data-seg=${segment.key} title=${segment.title}
      >${segment.label}</span
    >`;
  }
  return html`<button
    type="button"
    class=${cls}
    data-seg=${segment.key}
    title=${segment.title}
    @click=${segment.onActivate}
  >
    ${segment.label}
  </button>`;
}

/** The label the selector segment wears when no nested selector is active. */
export const BASE_SELECTOR_LABEL = "base rule";

function selectorTpl(selector: TargetSelector) {
  const label = selector.value ?? BASE_SELECTOR_LABEL;
  const choose = (value: string | null) => {
    closeSelectorMenu();
    selector.onSelect(value);
  };
  return html`
    <overlay-trigger
      placement="bottom-start"
      triggered-by="click"
      ${ref((el) => {
        _selectorTrigger = (el as SelectorTrigger | undefined) ?? null;
      })}
    >
      <button
        slot="trigger"
        type="button"
        class="tl-seg tl-seg--selector"
        data-seg="selector"
        title="The state or nested rule these edits land in — click to choose another"
      >
        ${label} ⌄
      </button>
      <sp-popover slot="click-content" tip class="tl-selector-popover">
        <sp-menu class="tl-selector-menu">
          <sp-menu-item value="__base__" @click=${() => choose(null)}>
            ${BASE_SELECTOR_LABEL}
          </sp-menu-item>
          <sp-menu-divider></sp-menu-divider>
          ${selector.options.map(
            (option) => html`
              <sp-menu-item value=${option} @click=${() => choose(option)}>
                ${selector.declared.has(option) ? `${option}  ●` : option}
              </sp-menu-item>
            `,
          )}
          <sp-menu-divider></sp-menu-divider>
          <sp-menu-item
            value="__add_custom__"
            @click=${() => {
              closeSelectorMenu();
              selector.onAddCustom();
            }}
          >
            + Add custom…
          </sp-menu-item>
        </sp-menu>
      </sp-popover>
    </overlay-trigger>
  `;
}

function scopeTpl(scope: TargetScope) {
  const classes = classMap({
    "tl-scope": true,
    [`tl-scope--${scope.kind}`]: true,
  });
  const title =
    scope.kind === "element"
      ? "These edits apply to the selected element only"
      : `These edits apply to ${scope.label}`;
  return html`<span class=${classes} data-scope=${scope.kind} title=${title}>${scope.label}</span>`;
}

function warningTpl(scope: TargetScope) {
  if (scope.kind !== "project") {
    return nothing;
  }
  const files = scope.affectedFiles ?? [];
  return html`
    <div class="tl-warning" role="status">
      <p class="tl-warning-text">
        Every edit here restyles ${scope.label} — ${scope.affected ?? "unknown"}.
      </p>
      ${
        scope.onToggleAffected
          ? html`<button type="button" class="tl-warning-action" @click=${scope.onToggleAffected}>
              ${scope.showAffected ? "Hide affected" : "Show affected"}
            </button>`
          : nothing
      }
      ${
        scope.showAffected
          ? files.length > 0
            ? html`<ul class="tl-affected">
                ${files.map(
                  (file) => html`<li class="tl-affected-row">
                    <span class="tl-affected-path">${file.path}</span>
                    <span class="tl-affected-count">${file.count}</span>
                  </li>`,
                )}
              </ul>`
            : html`<p class="tl-affected-empty">
                No file list — the project could not be searched.
              </p>`
          : nothing
      }
    </div>
  `;
}

/**
 * Render the Target Line.
 *
 * @param {TargetLineModel} model
 * @returns {import("lit-html").TemplateResult}
 */
export function renderTargetLine(model: TargetLineModel) {
  return html`
    <div class="target-line" data-jx-region="inspector/target">
      <span class="tl-glyph" aria-hidden="true">⌖</span>
      <div class="tl-segments">
        ${model.segments.map(
          (segment, index) => html`
            ${index > 0 ? html`<span class="tl-sep" aria-hidden="true">·</span>` : nothing}
            ${segmentTpl(segment)}
          `,
        )}
        <span class="tl-sep" aria-hidden="true">·</span>
        ${selectorTpl(model.selector)}
      </div>
      ${scopeTpl(model.scope)}
    </div>
    ${warningTpl(model.scope)}
  `;
}
