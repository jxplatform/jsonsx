/// <reference lib="dom" />
/**
 * Chat-view.js — the active-conversation templates: header and message list.
 *
 * Message-row anatomy: user messages render as right-aligned bubbles (attached-context
 * blocks become chips), assistant messages render sanitized markdown plus tool-call
 * chips, tool messages surface failures only (ADR §11.3), the streaming tail renders
 * as plain text with a cursor (markdown parses once on finalize), and chat errors get
 * a danger row with recovery advice and a Retry. Templates only — chat state lives in ai-panel, and
 * the three buttons are records the registry holds (see below).
 *
 * §7.4 (AI honesty) is why three things here are not what they were:
 *
 * - **A chip renders its OUTCOME.** `ToolCallRecord.result` has always been populated by the loop
 *   and ignored by this renderer, so a chip that said `update_style: ["children",0]` said exactly
 *   as much when the edit had been refused as when it had landed.
 * - **A turn renders what it CHANGED.** The changed-files summary comes off the write ledger
 *   (`services/ai-writes.ts`), which records whether each change went through a transaction or
 *   straight to disk — so the undo caveat is rendered to the human holding ⌘Z instead of being
 *   appended to the model-facing tool summary.
 * - **An error offers Retry.** `chatState.retryLast()` has been implemented, exported and called by
 *   nobody; the error row is where it belongs.
 *
 * §11.1 is why the three buttons here are not callbacks any more. History, New Chat and Retry were
 * closures this module received and invoked, so the capabilities existed ONLY as buttons: the
 * `Assistant` category held zero records, and nothing could reach them from the palette, a chord,
 * the automation runner or the generated commands sheet. They run {@link commandButton} now, in the
 * idiom `panels/statusbar.ts` established — the record is the definition site, and this file only
 * decides where it is drawn.
 *
 * @license MIT
 */

import { html, nothing } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import type { TemplateResult } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type { Message, ToolCallRecord } from "@jxsuite/ai/chat-state";
import { splitAttachedContext } from "./attached-context";
import { renderMarkdown } from "./chat-markdown";
import { summarizeWrites, writesForTurn } from "../../services/ai-writes";
import { activeRegistry } from "../../commands/active-registry";

import type { ImportRunRecord } from "../../services/import-run";

// ─── Helpers (moved from ai-panel.ts) ────────────────────────────────────────

/**
 * Parse a tool result message content (JSON string) into its success/error shape. Returns null if
 * the content isn't a valid tool result.
 *
 * @param {string} content
 * @returns {{ success: boolean; error?: string; summary?: string } | null}
 */
export function tryParseToolResult(
  content: string,
): { success: boolean; error?: string; summary?: string } | null {
  try {
    const parsed = JSON.parse(content) as { success?: unknown; error?: string; summary?: string };
    if (parsed && typeof parsed.success === "boolean") {
      return parsed as { success: boolean; error?: string; summary?: string };
    }
  } catch {
    /* Not JSON — not a tool result */
  }
  return null;
}

/**
 * Label for an assistant tool call: the tool name plus the target path when present.
 *
 * @param {{ name: string; arguments: string }} tc
 * @returns {string}
 */
export function formatToolLabel(tc: { name: string; arguments: string }): string {
  let detail = "";
  try {
    const args = (tc.arguments ? JSON.parse(tc.arguments) : {}) as {
      path?: unknown;
      parentPath?: unknown;
    };
    if (Array.isArray(args.path)) {
      detail = `: ${JSON.stringify(args.path)}`;
    } else if (Array.isArray(args.parentPath)) {
      detail = `: ${JSON.stringify(args.parentPath)}`;
    }
  } catch {
    /* Partial/unparsed args — show name only */
  }
  return `${tc.name}${detail}`;
}

/**
 * Return actionable advice for common AI assistant errors so the user knows how to recover instead
 * of just seeing a raw error message.
 *
 * @param {string} error
 * @returns {string}
 */
export function formatErrorAdvice(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("no api key") || lower.includes("401")) {
    return "Use the settings button below the message box to add an OpenAI-compatible API key.";
  }
  if (lower.includes("network error") || lower.includes("fetch")) {
    return "Check that the dev server is running and reachable.";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "The API rate limit was hit. Wait a moment and try again.";
  }
  if (lower.includes("500") || lower.includes("internal")) {
    return "The upstream API returned a server error. Try again in a moment.";
  }
  return "";
}

// ─── Commands as buttons ────────────────────────────────────────────────────

/** What {@link commandButton} draws inside the button, and how. */
export interface CommandButtonOptions {
  /** Slotted content — an icon element for the header, a label for the error row's Retry. */
  content: TemplateResult | string;
  /** Extra class, so the CSS that already targets `.ai-msg-retry` keeps landing. */
  className?: string;
  /** Quiet chrome. The header's icon buttons are quiet; the labelled Retry is not. */
  quiet?: boolean;
}

/**
 * One control that IS a command — `panels/statusbar.ts`'s `itemTpl`, for the assistant.
 *
 * A command the registry does not hold, or whose `when` is false, renders NOTHING rather than a
 * dead button; a visible-but-refused one renders disabled with its `requires` sentence in the
 * tooltip. That is what keeps this file a rendering of the registry instead of a second place the
 * assistant's capabilities are decided — and it is why `tests/ai-chat-view.test.ts` asserts the
 * ids, exactly as `tests/statusbar.test.ts` does: an id is not an interface between two files
 * unless something checks it.
 *
 * Before any registry exists (the bootstrap composes one at the END of `studio.ts`, and a reduced
 * test fixture may compose none) the button is simply absent. The chat is still readable, which is
 * the same bargain the status bar strikes for the frame it paints early.
 */
export function commandButton(
  id: string,
  opts: CommandButtonOptions,
): TemplateResult | typeof nothing {
  const registry = activeRegistry();
  const command = registry?.get(id);
  if (!registry || !command || !registry.isVisible(id)) {
    return nothing;
  }
  const reason = registry.disabledReason(id);
  const chord = registry.keymap.formatBinding(id);
  const title = reason
    ? `${command.title} — requires ${reason}`
    : chord
      ? `${command.title} (${chord})`
      : command.title;
  return html`<sp-action-button
    size="s"
    ?quiet=${opts.quiet ?? false}
    class=${opts.className ?? ""}
    ?disabled=${reason !== undefined}
    title=${title}
    @click=${() => {
      /* Re-asked at click time, not trusted from the render: state moves between the two, and
         `registry.run` THROWS on a refusal. Same bargain `registry.handleKeyEvent` strikes for a
         chord bound to a disabled command — swallow it here rather than make every surface wrap a
         dispatch in try/catch. */
      if (registry.isEnabled(id)) {
        void registry.run(id);
      }
    }}
  >
    ${opts.content}
  </sp-action-button>`;
}

// ─── Header ─────────────────────────────────────────────────────────────────

export interface ChatHeaderOptions {
  /** The open session's title, or null for a fresh unsaved chat. */
  title: string | null;
  streaming: boolean;
  /**
   * The conversation's estimated token count, and whether it is over the warning line.
   *
   * `services/context-manager.ts` has computed both on every turn since it was written, and
   * `chat-state.ts` has stored them — with NO READER anywhere. Plan §11.6: "Context budget manager
   * → tokenCount / contextWarning actually rendered". So a conversation was silently trimmed, the
   * assistant forgot what you told it ten turns ago, and the two numbers that would have explained
   * why sat in the store.
   */
  tokens: number;
  overBudget: boolean;
}

/** Compact token count: 18400 → "18.4k". A four-digit number in a 28px header is noise. */
function tokenLabel(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** The chat header: history button, session title, the context budget, spinner, New Chat. */
export function renderChatHeader(opts: ChatHeaderOptions): TemplateResult {
  return html`
    <div class="ai-chat-header">
      ${commandButton("assistant.history", {
        content: html`<sp-icon-history slot="icon"></sp-icon-history>`,
        quiet: true,
      })}
      <span class="ai-chat-title">${opts.title ?? "New chat"}</span>
      <span class="ai-header-spacer"></span>
      ${
        opts.tokens > 0
          ? html`<span
              class=${opts.overBudget ? "ai-tokens ai-tokens--warn" : "ai-tokens"}
              title=${
                opts.overBudget
                  ? `About ${opts.tokens.toLocaleString()} tokens — past half the model's context. ` +
                    `The oldest turns are dropped as this grows; start a new chat to keep them.`
                  : `About ${opts.tokens.toLocaleString()} tokens of the model's context in use`
              }
              >${tokenLabel(opts.tokens)}</span
            >`
          : nothing
      }
      ${
        opts.streaming
          ? html`<sp-progress-circle size="s" indeterminate></sp-progress-circle>`
          : nothing
      }
      ${commandButton("assistant.newChat", {
        content: html`<sp-icon-add slot="icon"></sp-icon-add>`,
        quiet: true,
      })}
    </div>
  `;
}

// ─── Message rows ───────────────────────────────────────────────────────────

function renderUserMessage(msg: Message): TemplateResult {
  const { body, contextLines } = splitAttachedContext(msg.content);
  return html`
    <div class="ai-msg-user">
      <div class="ai-msg-user-body">${body}</div>
      ${
        contextLines.length > 0
          ? html`
              <div class="ai-msg-context-chips">
                ${contextLines.map((line) => html`<span class="ai-context-chip">${line}</span>`)}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

/** The tool whose chip is a question card rather than a chip. */
const ASK_TOOL = "ask_user";

/** The tool whose chip grows a live progress line while it runs. */
const IMPORT_TOOL = "import_site";

/** Log lines drawn under a running import. The tail is what a reader wants. */
/**
 * How close to the bottom counts as "following along".
 *
 * The same threshold and the same reasoning as the transcript's own scroller
 * (`panels/ai-panel.ts`): a reader who has scrolled up is reading something, and yanking them back
 * on every new line is the behaviour that makes a live log unreadable.
 */
const IMPORT_STICK_THRESHOLD = 24;

/**
 * Keep an import log pinned to its newest line, unless the reader has scrolled away from it.
 *
 * The log is a scroller now rather than a six-line tail, and a scroller that does not follow is a
 * box that shows the same six lines it started with while the interesting ones pile up below.
 */
function stickToBottom(element: Element | undefined): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
  if (distance <= IMPORT_STICK_THRESHOLD || element.scrollTop === 0) {
    element.scrollTop = element.scrollHeight;
  }
}

/** What `ask_user` was called with, as far as the arguments actually parse. */
interface AskArgs {
  question: string;
  options: string[];
  context: string;
}

/**
 * Read a question out of a tool call's arguments.
 *
 * Tolerant on purpose: the arguments are assembled from streamed fragments, so a chip can be asked
 * to render a call whose JSON is still half-written. A card with an empty question renders as an
 * ordinary chip rather than as an empty box.
 *
 * @param {ToolCallRecord} tc
 * @returns {AskArgs | null}
 */
export function parseAsk(tc: ToolCallRecord): AskArgs | null {
  let parsed: { question?: unknown; options?: unknown; context?: unknown };
  try {
    parsed = tc.arguments ? (JSON.parse(tc.arguments) as typeof parsed) : {};
  } catch {
    return null; // Still streaming, or malformed — the generic chip is the honest fallback.
  }
  if (typeof parsed.question !== "string" || !parsed.question.trim()) {
    return null;
  }
  return {
    context: typeof parsed.context === "string" ? parsed.context : "",
    options: Array.isArray(parsed.options)
      ? parsed.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
      : [],
    question: parsed.question,
  };
}

/**
 * What became of one tool call.
 *
 * `"unanswered"` is the fourth value and it exists for `ask_user`. A question's promise lives in
 * memory, so a reload kills it while the transcript survives: without this the restored card is
 * indistinguishable from a live one and spins forever waiting for a loop that is gone. It is a
 * property of the RUN, not of the record, so the caller supplies whether this call is still live.
 *
 * @param {ToolCallRecord} tc
 * @param {boolean} [live] - Whether the loop is still waiting on this call. Only consulted for a
 *   result-less interactive call; every other pending call belongs to a turn still in flight.
 * @returns {"pending" | "unanswered" | "ok" | "failed"}
 */
export function toolOutcome(
  tc: ToolCallRecord,
  live = true,
): "pending" | "unanswered" | "ok" | "failed" {
  if (!tc.result) {
    return tc.name === ASK_TOOL && !live ? "unanswered" : "pending";
  }
  return tc.result.success ? "ok" : "failed";
}

/**
 * The one line a chip says about its outcome — the tool's own words where it has any.
 *
 * A tool that succeeded already writes a human sentence into `summary` for the model to read; there
 * is no reason the human could not have been reading it all along. A tool that failed writes
 * `error`, which was surfaced only through the separate tool-message row and only after the fact.
 *
 * @param {ToolCallRecord} tc
 * @returns {string}
 */
export function toolOutcomeText(tc: ToolCallRecord): string {
  const { result } = tc;
  if (!result) {
    return "";
  }
  return (result.success ? result.summary : result.error) ?? "";
}

/**
 * A running import, under the chip that started it.
 *
 * An import takes minutes and says a line at a time. Rendering it here rather than in the modal it
 * used to live in is what stops a successful run destroying its own account of what it did: the
 * chip and the progress are one thing, joined by the tool-call id.
 */
function renderImportProgress(record: ImportRunRecord): TemplateResult {
  const running = record.status === "running";
  const determinate = record.total !== null && record.current !== null;
  const outcome =
    record.status === "done"
      ? `Imported ${record.url}`
      : record.status === "failed"
        ? `Import failed — ${record.error || "the run did not say why"}`
        : record.status === "stopped"
          ? "Import stopped"
          : record.message;
  return html`
    <details class="ai-import-progress" ?open=${running}>
      <summary class="ai-import-head">
        ${
          running
            ? determinate
              ? html`<sp-progress-circle
                  size="s"
                  progress=${Math.round((record.current! / Math.max(record.total!, 1)) * 100)}
                ></sp-progress-circle>`
              : html`<sp-progress-circle indeterminate size="s"></sp-progress-circle>`
            : nothing
        }
        ${running ? html`<span class="ai-import-phase">${record.phase}</span>` : nothing}
        <span class="ai-import-message">${outcome}</span>
        <span class="ai-import-count">${record.log.length}</span>
      </summary>
      <div class="ai-import-log" ${ref(stickToBottom)}>
        ${repeat(
          record.log,
          (evt, index) => `${index}:${evt.phase}`,
          (evt) => html`
            <div class="ai-import-log-line">
              <span class="ai-import-phase">${evt.phase}</span>${evt.message}
            </div>
          `,
        )}
      </div>
    </details>
  `;
}

/** How a question card reaches the store that resolves it. */
export interface AskHandlers {
  /** The id of the question the loop is still waiting on, or null. */
  pendingId?: string | null;
  onAnswer?: (text: string) => void;
  onSkip?: () => void;
  /** The live record for an `import_site` call, if this renderer's host has one. */
  importRun?: (id: string) => ImportRunRecord | null;
}

/**
 * A question, as the last thing in the transcript, waiting on the reader.
 *
 * The card IS the tool chip rather than a row beside it: the question, its options and its answer
 * are all facts about one tool call, and rendering them anywhere else would give the transcript two
 * accounts of the same event that can disagree after a reload.
 *
 * The options are a shortcut, never the whole answer — the composer is always live beneath, and its
 * placeholder says so. A question whose real answer is "neither, do this instead" must stay
 * answerable.
 */
function renderAskCard(
  tc: ToolCallRecord,
  ask: AskArgs,
  outcome: ReturnType<typeof toolOutcome>,
  handlers: AskHandlers,
): TemplateResult {
  const answered = tc.result?.success
    ? ((tc.result.data as { answer?: string | null; skipped?: boolean } | undefined) ?? null)
    : null;
  return html`
    <div class="ai-ask" data-outcome=${outcome}>
      <div class="ai-ask-question">${ask.question}</div>
      ${ask.context ? html`<div class="ai-ask-context">${ask.context}</div>` : nothing}
      ${
        outcome === "pending"
          ? html`
              <div class="ai-ask-options">
                ${ask.options.map(
                  (option) => html`
                    <sp-button
                      size="s"
                      variant="secondary"
                      treatment="outline"
                      @click=${() => handlers.onAnswer?.(option)}
                    >
                      ${option}
                    </sp-button>
                  `,
                )}
                <sp-action-button
                  size="s"
                  quiet
                  class="ai-ask-skip"
                  title="Let the assistant decide"
                  @click=${() => handlers.onSkip?.()}
                >
                  You decide
                </sp-action-button>
              </div>
            `
          : nothing
      }
      ${
        outcome === "unanswered"
          ? html`<div class="ai-ask-outcome">
              This question was still open when the session was reloaded — reply below to carry on.
            </div>`
          : nothing
      }
      ${
        answered
          ? html`<div class="ai-ask-answer">
              ${answered.skipped ? "You decide" : answered.answer}
            </div>`
          : nothing
      }
      ${
        outcome === "failed"
          ? html`<div class="ai-ask-outcome">${toolOutcomeText(tc)}</div>`
          : nothing
      }
    </div>
  `;
}

function renderToolChips(
  toolCalls: ToolCallRecord[],
  handlers: AskHandlers = {},
): TemplateResult | typeof nothing {
  if (toolCalls.length === 0) {
    return nothing;
  }
  return html`
    <div class="ai-msg-tools">
      ${toolCalls.map((tc) => {
        const ask = tc.name === ASK_TOOL ? parseAsk(tc) : null;
        const outcome = toolOutcome(tc, tc.id === handlers.pendingId || Boolean(tc.result));
        if (ask) {
          return renderAskCard(tc, ask, outcome, handlers);
        }
        const text = toolOutcomeText(tc);
        /*
         * For EVERY import chip, not only a running one.
         *
         * A finished run used to lose its whole account of itself at the instant it finished — the
         * record was fetched only while the call was pending, so the log vanished on success. That
         * is the failure the hand-off from the wizard to the assistant was made to fix, reproduced
         * one layer in. It stays, collapsed, under the chip that produced it.
         */
        const run = tc.name === IMPORT_TOOL ? (handlers.importRun?.(tc.id) ?? null) : null;
        return html`
          <span class="ai-tool-chip" data-outcome=${outcome} title=${text || formatToolLabel(tc)}>
            <sp-icon-gears size="xs"></sp-icon-gears>
            <span class="ai-tool-chip-name">${formatToolLabel(tc)}</span>
            ${
              outcome === "pending" || outcome === "unanswered"
                ? nothing
                : html`<span class="ai-tool-chip-outcome"
                    >${outcome === "ok" ? "✓" : "✗"} ${text}</span
                  >`
            }
          </span>
          ${run ? renderImportProgress(run) : nothing}
        `;
      })}
    </div>
  `;
}

/**
 * The turn's changed-files summary, with the two things it can honestly offer.
 *
 * Rendered only for a turn that changed something — "Changed 0 files" is noise, and a turn that
 * only read is the common case. **Restore to here** is offered only when every recorded change went
 * through a transaction: a disk write has no history behind it, so a button that claimed to restore
 * one would be the same lie the model-facing caveat used to be.
 */
function renderChangedFiles(
  msg: Message,
  onRestore?: (messageId: string) => void,
): TemplateResult | typeof nothing {
  const writes = writesForTurn(msg.id);
  if (writes.length === 0) {
    return nothing;
  }
  const summary = summarizeWrites(writes);
  if (!summary) {
    return nothing;
  }
  const restorable = writes.every((w) => !w.disk);
  return html`
    <details class="ai-msg-changes">
      <summary>
        ${summary}
        ${
          onRestore && restorable
            ? html`<sp-action-button
                size="xs"
                quiet
                title="Undo everything this turn changed"
                @click=${(e: Event) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onRestore(msg.id);
                }}
              >
                Restore to here
              </sp-action-button>`
            : nothing
        }
      </summary>
      <ul class="ai-msg-changes-list">
        ${writes.map(
          (w) => html`
            <li data-disk=${String(w.disk)} data-ok=${String(w.ok)}>
              <code>${w.path}</code>
              <span>${w.ok ? w.tool : `failed — ${w.error ?? w.tool}`}</span>
              ${w.disk ? html`<em>written to disk — undo cannot reach it</em>` : nothing}
            </li>
          `,
        )}
      </ul>
    </details>
  `;
}

function renderAssistantMessage(
  msg: Message,
  onRestore?: (messageId: string) => void,
  ask: AskHandlers = {},
): TemplateResult | typeof nothing {
  const toolCalls = msg.toolCalls ?? [];
  if (!msg.content && toolCalls.length === 0) {
    return nothing;
  }
  return html`
    <div class="ai-msg-assistant">
      ${msg.content ? renderMarkdown(msg.id, msg.content) : nothing}
      ${renderToolChips(toolCalls, ask)} ${renderChangedFiles(msg, onRestore)}
    </div>
  `;
}

function renderToolMessage(msg: Message): TemplateResult | typeof nothing {
  // Show only failed tool results so the user knows why an edit didn't land
  // (ADR §11.3). Successful tool results stay hidden to reduce noise.
  const parsed = tryParseToolResult(msg.content);
  if (!parsed || parsed.success) {
    return nothing;
  }
  return html`<div class="ai-msg-tool-error">⚠️ ${parsed.error || "Tool call failed"}</div>`;
}

function renderStreamingTail(msg: Message, ask: AskHandlers = {}): TemplateResult {
  if (!msg.content) {
    return html`
      <div class="ai-msg-typing">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;
  }
  return html`
    <div class="ai-msg-assistant">
      <span class="ai-msg-streaming">${msg.content}</span>
      ${renderToolChips(msg.toolCalls ?? [], ask)}
    </div>
  `;
}

// ─── Message list ───────────────────────────────────────────────────────────

export interface MessageListOptions {
  messages: Message[];
  /** ChatState status — "streaming" renders the tail live. */
  status: string;
  error: string | null;
  onScroll: (e: Event) => void;
  /** Ref to the scrolling element, for stick-to-bottom maintenance. */
  listRef: (el: Element | undefined) => void;
  /** Undo everything one turn changed. Offered only for turns whose changes are all transactional. */
  onRestore?: ((messageId: string) => void) | undefined;
  /**
   * The outstanding question and how to settle it.
   *
   * Passed down rather than read from the store here, because this module renders templates and
   * holds no state — the same reason the three header buttons are command records.
   */
  ask?: AskHandlers | undefined;
}

/** The scrollable message list — THE scroller of the chat view. */
export function renderMessageList(opts: MessageListOptions): TemplateResult {
  const { messages, status } = opts;
  const ask = opts.ask ?? {};
  const lastIdx = messages.length - 1;
  return html`
    <div class="ai-chat-messages" ${ref(opts.listRef)} @scroll=${opts.onScroll}>
      ${
        messages.length === 0 && status !== "streaming"
          ? html`
              <div class="ai-chat-empty">
                Ask the assistant to build or edit this page — it can add sections, restyle
                elements, and wire up components.
              </div>
            `
          : nothing
      }
      ${repeat(
        messages,
        /* Keyed on msg.id, for two reasons a reader can see. The last assistant row swaps between
           renderStreamingTail and renderAssistantMessage the moment a stream completes, so an
           unkeyed list tears down and rebuilds the longest node in the transcript every time one
           finishes. And an assistant row holds the reader's OWN open/closed state on its
           ai-msg-changes details element, which position-based reuse hands to a different
           message. */
        (msg) => msg.id,
        (msg, i) => {
          if (msg.role === "user") {
            return renderUserMessage(msg);
          }
          if (msg.role === "tool") {
            return renderToolMessage(msg);
          }
          if (msg.role === "assistant") {
            if (status === "streaming" && i === lastIdx) {
              return renderStreamingTail(msg, ask);
            }
            return renderAssistantMessage(msg, opts.onRestore, ask);
          }
          return nothing;
        },
      )}
      ${
        status !== "streaming" && opts.error
          ? html`
              <div class="ai-msg-error">
                <div>${opts.error}</div>
                ${
                  formatErrorAdvice(opts.error)
                    ? html`<div class="ai-msg-error-advice">${formatErrorAdvice(opts.error)}</div>`
                    : nothing
                }
                ${
                  /* `assistant.retry`, not a closure. Its `enablement` reads `ctx.ai.configured`,
                     so the one error this row cannot recover from — no provider connected, whose
                     advice line above already says to add a key — draws the button disabled with
                     that sentence rather than offering a send that will fail identically. */
                  commandButton("assistant.retry", {
                    className: "ai-msg-retry",
                    content: "Retry",
                  })
                }
              </div>
            `
          : nothing
      }
    </div>
  `;
}
