/// <reference lib="dom" />
/**
 * Composer.js — the sticky bottom chat input (VSCode-Copilot style).
 *
 * Auto-growing textarea (Enter sends, Shift+Enter newline) above a control row with a
 * context-attach menu, model picker, settings button, and a Send button that morphs
 * into Stop while streaming. Closure factory (precedent: createAiCredentialsForm) so
 * draft state never leaks between hosts.
 *
 * The textarea is intentionally uncontrolled (no .value binding): lit re-renders reuse
 * the DOM node, so streaming updates never clobber the draft, focus, or caret — the
 * reason this panel can re-render without the panel-scheduler's focus guard.
 *
 * @license MIT
 */

import { html, nothing } from "lit-html";
import { displayTagName } from "@jxsuite/schema/guards";
import type { TemplateResult } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { ref } from "lit-html/directives/ref.js";
import { getNodeAtPath } from "../../state";
import {
  aiConnection,
  cachedModels,
  fetchAvailableModels,
  preferredModel,
} from "../../services/ai-models";
import { setModel } from "../../services/ai-settings";
import { activeTab } from "../../workspace/workspace";
import { primarySelection } from "../../tabs/selection";
import { buildMessageWithContext } from "./attached-context";
import type { ContextChip } from "./attached-context";
import type { AiCredentials } from "../../services/ai-models";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** Tallest the textarea auto-grows before it scrolls internally. */
const MAX_INPUT_HEIGHT = 120;
const RETRY_MODELS = "__retry_models__";

export interface ComposerOptions {
  /** Receives the full message content (typed text + serialized context). */
  onSend: (text: string) => void;
  onStop: () => void;
  /** Opens the credentials form. */
  onOpenSettings: () => void;
  isStreaming: () => boolean;
  /** Host re-render scheduler — called whenever composer state changes. */
  requestRender: () => void;
}

export interface Composer {
  render: () => TemplateResult;
  focus: () => void;
  clear: () => void;
  /**
   * Attach the canvas selection as a context chip, as the attach menu's second item does.
   *
   * `false` when nothing is selected, so a caller can say why nothing happened. This exists because
   * `assistant.attachSelection` (`panels/ai-panel.ts`) must reach the SAME chip the menu builds —
   * the attach convention is one delimiter and one `ContextChip` shape (`attached-context.ts`), and
   * a command that assembled its own line would be a second way to say "this element", diverging
   * the first time the label changes.
   */
  attachSelection: () => boolean;
}

/**
 * Create a composer instance bound to a host's render scheduler.
 *
 * @param {ComposerOptions} opts
 * @returns {Composer}
 */
export function createComposer(opts: ComposerOptions): Composer {
  let textareaEl: HTMLTextAreaElement | null = null;
  let hasText = false;
  let chips: ContextChip[] = [];

  /** Null until the first fetch settles; kept on error so the picker can offer Retry. */
  let modelsLoading = false;
  let modelsError = "";

  /**
   * The connection the last fetch was made for, so a failure is not retried on every render.
   *
   * The list itself is NOT held here. A private copy is how the picker came to show one provider's
   * catalogue while another was configured: it was filled once and never reconsidered. Reading it
   * from `cachedModels(connection)` means a list can only ever be shown for the credentials it was
   * listed under, and a credential change makes it unavailable rather than stale.
   */
  let attempted: AiCredentials | null = null;

  // ── Model picker ──────────────────────────────────────────────────────

  function sameConnection(a: AiCredentials | null, b: AiCredentials): boolean {
    return a !== null && a.apiKey === b.apiKey && a.baseUrl === b.baseUrl;
  }

  function ensureModels(force = false) {
    const credentials = aiConnection();
    const settled = cachedModels(credentials) !== null || sameConnection(attempted, credentials);
    if (modelsLoading || (settled && !force)) {
      return;
    }
    modelsLoading = true;
    modelsError = "";
    attempted = credentials;
    fetchAvailableModels({ credentials, force })
      .catch((error: unknown) => {
        modelsError = (error as Error).message || "Failed to fetch models";
      })
      .finally(() => {
        modelsLoading = false;
        opts.requestRender();
      });
  }

  function onModelChange(e: Event) {
    const { value } = e.target as HTMLInputElement;
    if (value === RETRY_MODELS) {
      attempted = null;
      ensureModels(true);
      // Re-render so the picker snaps back to the stored model instead of "Retry".
      opts.requestRender();
      return;
    }
    if (value) {
      setModel(value);
    }
  }

  function renderModelPicker(): TemplateResult {
    ensureModels();
    const current = preferredModel();
    const listed = cachedModels(aiConnection()) ?? [];
    const items = listed.some((m) => m.id === current)
      ? listed
      : [{ id: current, name: current }, ...listed];
    return html`
      <sp-picker
        size="s"
        quiet
        class="ai-model-picker"
        title=${modelsError ? `Couldn't load models: ${modelsError}` : "Model"}
        .value=${live(current)}
        @change=${onModelChange}
      >
        ${items.map((m) => html`<sp-menu-item value=${m.id}>${m.name}</sp-menu-item>`)}
        ${
          modelsLoading
            ? html`<sp-menu-item disabled value="__loading__">Loading models…</sp-menu-item>`
            : nothing
        }
        ${
          modelsError
            ? html`<sp-menu-item value=${RETRY_MODELS}>Retry loading models</sp-menu-item>`
            : nothing
        }
      </sp-picker>
    `;
  }

  // ── Context attach ────────────────────────────────────────────────────

  /** Snapshot the current page / selected element into chip candidates. */
  function contextCandidates() {
    const tab = activeTab.value;
    const documentPath = tab?.documentPath || null;
    const selection = primarySelection(tab?.session.selection);
    let selectionChip: ContextChip | null = null;
    if (tab && selection) {
      /* No `tagName?: string` in this cast any more. It overrode the widened type — a tag may be
         a name or a choice between names — so the compiler could not see that this chip would
         render `[object Object]` for a chosen one. A cast that narrows a field back to what it
         used to be is a hole the type system cannot report. */
      const node = getNodeAtPath(tab.doc.document as JxMutableNode, selection) as
        | (JxMutableNode & { textContent?: string })
        | undefined;
      const tag = displayTagName(node?.tagName) || "element";
      const text = typeof node?.textContent === "string" ? node.textContent.slice(0, 40) : "";
      selectionChip = {
        detail: `Selected element at ${JSON.stringify(selection)}: <${tag}>${text ? ` "${text}"` : ""}`,
        kind: "selection",
        label: `<${tag}>`,
      };
    }
    return {
      pageChip: documentPath
        ? ({ detail: `Page: ${documentPath}`, kind: "page", label: documentPath } as ContextChip)
        : null,
      selectionChip,
    };
  }

  /** Add (or refresh) a chip of the given kind — one chip per kind. */
  function addChip(chip: ContextChip) {
    chips = [...chips.filter((c) => c.kind !== chip.kind), chip];
    opts.requestRender();
  }

  function removeChip(kind: ContextChip["kind"]) {
    chips = chips.filter((c) => c.kind !== kind);
    opts.requestRender();
  }

  /** {@link Composer.attachSelection} — the attach menu's "Selected element" item, by name. */
  function attachSelection(): boolean {
    const { selectionChip } = contextCandidates();
    if (!selectionChip) {
      return false;
    }
    addChip(selectionChip);
    return true;
  }

  function renderAttachMenu(): TemplateResult {
    const { pageChip, selectionChip } = contextCandidates();
    return html`
      <overlay-trigger placement="top-start" triggered-by="click">
        <sp-action-button size="s" quiet slot="trigger" title="Attach context">
          <sp-icon-attach slot="icon"></sp-icon-attach>
        </sp-action-button>
        <sp-popover slot="click-content" tip>
          <sp-menu
            @change=${(e: Event) => {
              const { value } = e.target as unknown as HTMLInputElement;
              if (value === "page" && pageChip) {
                addChip(pageChip);
              } else if (value === "selection" && selectionChip) {
                addChip(selectionChip);
              }
            }}
          >
            <sp-menu-item value="page" ?disabled=${!pageChip}>
              Current page${pageChip ? ` — ${pageChip.label}` : ""}
            </sp-menu-item>
            <sp-menu-item value="selection" ?disabled=${!selectionChip}>
              Selected element${selectionChip ? ` — ${selectionChip.label}` : ""}
            </sp-menu-item>
          </sp-menu>
        </sp-popover>
      </overlay-trigger>
    `;
  }

  function renderChips(): TemplateResult | typeof nothing {
    if (chips.length === 0) {
      return nothing;
    }
    return html`
      <div class="ai-composer-chips">
        ${chips.map(
          (c) => html`
            <span class="ai-context-chip" title=${c.detail}>
              ${c.label}
              <sp-action-button quiet size="s" title="Remove" @click=${() => removeChip(c.kind)}>
                <sp-icon-close slot="icon"></sp-icon-close>
              </sp-action-button>
            </span>
          `,
        )}
      </div>
    `;
  }

  // ── Input ─────────────────────────────────────────────────────────────

  function autoGrow() {
    if (!textareaEl) {
      return;
    }
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }

  function onInput() {
    autoGrow();
    const nowHasText = Boolean(textareaEl?.value.trim());
    if (nowHasText !== hasText) {
      hasText = nowHasText;
      // Only re-render on the empty↔non-empty flip so typing stays cheap.
      opts.requestRender();
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      trySend();
    }
  }

  function trySend() {
    const text = textareaEl?.value ?? "";
    if (!text.trim() || opts.isStreaming()) {
      return;
    }
    opts.onSend(buildMessageWithContext(text, chips));
    clear();
    opts.requestRender();
  }

  function clear() {
    if (textareaEl) {
      textareaEl.value = "";
      textareaEl.style.height = "auto";
    }
    hasText = false;
    chips = [];
  }

  function focus() {
    textareaEl?.focus();
  }

  // ── Template ──────────────────────────────────────────────────────────

  function render(): TemplateResult {
    const streaming = opts.isStreaming();
    return html`
      <div class="ai-composer">
        ${renderChips()}
        <textarea
          class="ai-composer-input"
          rows="1"
          placeholder="Ask the assistant… (Enter to send)"
          ${ref((el) => {
            textareaEl = (el as HTMLTextAreaElement | null) || null;
          })}
          @input=${onInput}
          @keydown=${onKeydown}
        ></textarea>
        <div class="ai-composer-row">
          ${renderAttachMenu()} ${renderModelPicker()}
          <span class="ai-header-spacer"></span>
          <sp-action-button size="s" quiet title="API key & endpoint" @click=${opts.onOpenSettings}>
            <sp-icon-settings slot="icon"></sp-icon-settings>
          </sp-action-button>
          ${
            streaming
              ? html`
                  <sp-action-button size="s" class="ai-send-btn" title="Stop" @click=${opts.onStop}>
                    <sp-icon-stop slot="icon"></sp-icon-stop>
                  </sp-action-button>
                `
              : html`
                  <sp-action-button
                    size="s"
                    class="ai-send-btn"
                    title="Send"
                    ?disabled=${!hasText}
                    @click=${trySend}
                  >
                    <sp-icon-send slot="icon"></sp-icon-send>
                  </sp-action-button>
                `
          }
        </div>
      </div>
    `;
  }

  return { attachSelection, clear, focus, render };
}
