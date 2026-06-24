/// <reference lib="dom" />
/**
 * Field-input.ts — Controlled text-input widgets with a draft-state layer.
 *
 * The single input paradigm for every Studio panel. Each field is identified by a stable `key`.
 * While a field is focused/edited, its in-progress text lives in a per-key DRAFT, decoupled from
 * the document. The visible value is always `getFieldValue(key, committed)` bound via lit's `live`
 * directive, so a render that slips through mid-edit never resets the field to a stale value.
 *
 * Commit semantics (consistent across all panels): commit a short debounce after typing pauses (so
 * the canvas/preview updates live) AND immediately on blur or Enter (so the latest value is never
 * lost). The draft is cleared on blur/Enter, after which the field reflects the committed (possibly
 * normalized) document value again.
 *
 * Pair this with the focus-aware panel scheduler (panels/panel-scheduler.ts), which keeps the panel
 * from re-rendering at all while a field is focused.
 */

import { html } from "lit-html";
import type { TemplateResult } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { keyed } from "lit-html/directives/keyed.js";

/** A lit-renderable value (template or directive result). */
type Renderable = unknown;

/** Default debounce (ms) before an in-progress edit is committed to the document. */
export const DEFAULT_DEBOUNCE_MS = 350;

interface DraftEntry {
  value: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** Active per-field drafts, keyed by a stable field key. */
const _drafts = new Map<string, DraftEntry>();

/** The committed value to show for a field — the live draft while editing, else `committed`. */
export function getFieldValue(key: string, committed: string): string {
  const d = _drafts.get(key);
  return d ? d.value : committed;
}

/** Whether a draft is currently being edited for `key`. */
export function hasDraft(key: string): boolean {
  return _drafts.has(key);
}

/** Record the in-progress value for a field without committing it. */
export function setDraft(key: string, value: string): void {
  const d = _drafts.get(key);
  if (d) {
    d.value = value;
  } else {
    _drafts.set(key, { value });
  }
}

/** Discard a field's draft (and cancel any pending debounced commit). */
export function clearDraft(key: string): void {
  const d = _drafts.get(key);
  if (d?.timer) {
    clearTimeout(d.timer);
  }
  _drafts.delete(key);
}

/**
 * Schedule a debounced commit of the current draft, KEEPING the draft afterwards so the field stays
 * controlled by the in-progress text until the user blurs. The committed value flows to the
 * document (live preview) while the cursor/text stay untouched. Exported for unit testing.
 */
export function scheduleDraftCommit(key: string, ms: number, commit: (v: string) => void): void {
  const d = _drafts.get(key);
  if (!d) {
    return;
  }
  if (d.timer) {
    clearTimeout(d.timer);
  }
  d.timer = setTimeout(() => {
    const cur = _drafts.get(key);
    if (!cur) {
      return;
    }
    delete cur.timer;
    commit(cur.value);
  }, ms);
}

/**
 * Flush a field's draft immediately (blur/Enter): commit the latest value and clear the draft so
 * the field reflects the committed document value on the next render.
 */
export function commitField(key: string, commit: (v: string) => void): void {
  const d = _drafts.get(key);
  if (!d) {
    return;
  }
  if (d.timer) {
    clearTimeout(d.timer);
  }
  const { value } = d;
  _drafts.delete(key);
  commit(value);
}

/** Shared option bag for the text widgets. */
export interface FieldOpts {
  placeholder?: string;
  size?: string;
  debounceMs?: number;
  /**
   * When to commit to the document: - "live" (default): debounced while typing AND on blur/Enter
   * (live preview). - "blur": only on blur/Enter — for fields where mid-typing commits are
   * disruptive (e.g. renaming a signal, which would rename on every keystroke pause).
   */
  commitMode?: "live" | "blur";
  /** Extra inline style for the control. */
  style?: string;
  /** Disable the control. */
  disabled?: boolean;
}

interface TextAreaOpts extends FieldOpts {
  minHeight?: string;
  mono?: boolean;
}

function makeHandlers(
  key: string,
  ms: number,
  commit: (v: string) => void,
  commitMode: "live" | "blur" = "live",
) {
  return {
    onCommit: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      setDraft(key, v);
      commitField(key, commit);
    },
    onInput: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      setDraft(key, v);
      if (commitMode === "live") {
        scheduleDraftCommit(key, ms, commit);
      }
    },
    onKeydown: (e: KeyboardEvent, multiline: boolean) => {
      if (e.key === "Enter" && !multiline) {
        commitField(key, commit);
      }
    },
  };
}

/**
 * Single-line Spectrum text field bound to the draft layer.
 *
 * @param key Stable field identity (e.g. "head:og:title", "fm:title", "prop:0/1/className").
 * @param value Committed value from the document.
 * @param commit Writes the value to the document (transactDoc/mutate…).
 */
export function spTextField(
  key: string,
  value: string,
  commit: (v: string) => void,
  opts: FieldOpts = {},
): Renderable {
  const ms = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const { onInput, onCommit, onKeydown } = makeHandlers(key, ms, commit, opts.commitMode);
  return keyed(
    key,
    html`
      <sp-textfield
        size=${opts.size ?? "s"}
        placeholder=${opts.placeholder ?? ""}
        ?disabled=${Boolean(opts.disabled)}
        style=${opts.style ?? ""}
        .value=${live(getFieldValue(key, value))}
        @input=${onInput}
        @change=${onCommit}
        @keydown=${(e: KeyboardEvent) => onKeydown(e, false)}
      ></sp-textfield>
    `,
  );
}

/** Multiline Spectrum text field bound to the draft layer (Enter inserts a newline). */
export function spTextArea(
  key: string,
  value: string,
  commit: (v: string) => void,
  opts: FieldOpts = {},
): Renderable {
  const ms = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const { onInput, onCommit } = makeHandlers(key, ms, commit, opts.commitMode);
  return keyed(
    key,
    html`
      <sp-textfield
        multiline
        size=${opts.size ?? "s"}
        placeholder=${opts.placeholder ?? ""}
        ?disabled=${Boolean(opts.disabled)}
        style=${opts.style ?? ""}
        .value=${live(getFieldValue(key, value))}
        @input=${onInput}
        @change=${onCommit}
      ></sp-textfield>
    `,
  );
}

/** Native `<textarea class="field-input">` bound to the draft layer (used by code-ish fields). */
export function rawTextArea(
  key: string,
  value: string,
  commit: (v: string) => void,
  opts: TextAreaOpts = {},
): Renderable {
  const ms = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const { onInput, onCommit } = makeHandlers(key, ms, commit, opts.commitMode);
  const style = [
    `min-height:${opts.minHeight ?? "40px"}`,
    opts.mono ? "font-family:var(--font-mono);font-size:var(--spectrum-font-size-50,11px)" : "",
    opts.style ?? "",
  ]
    .filter(Boolean)
    .join(";");
  return keyed(
    key,
    html`
      <textarea
        class="field-input"
        style=${style}
        placeholder=${opts.placeholder ?? ""}
        ?disabled=${Boolean(opts.disabled)}
        .value=${live(getFieldValue(key, value))}
        @input=${onInput}
        @change=${onCommit}
      ></textarea>
    `,
  );
}

/**
 * Spectrum number field. Numbers are short and not prone to the typing-truncation bug, so this
 * commits on change (blur/Enter) only — no draft buffering. `commit` receives the parsed number, or
 * undefined when the field is cleared / invalid.
 */
export function spNumberField(
  value: number | undefined,
  commit: (v: number | undefined) => void,
  opts: FieldOpts & { hideStepper?: boolean; min?: number; max?: number } = {},
): TemplateResult {
  return html`
    <sp-number-field
      size=${opts.size ?? "s"}
      ?hide-stepper=${opts.hideStepper ?? true}
      ?disabled=${Boolean(opts.disabled)}
      style=${opts.style ?? ""}
      .value=${live(value !== undefined ? Number(value) : undefined)}
      @change=${(e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        const n = Number(raw);
        commit(raw === "" || Number.isNaN(n) ? undefined : n);
      }}
    ></sp-number-field>
  `;
}
