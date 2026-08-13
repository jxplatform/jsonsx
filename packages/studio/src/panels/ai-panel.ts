/// <reference lib="dom" />
/**
 * Ai-panel.ts — AI assistant tab for the right panel (Stack B document assistant).
 *
 * Native lit-html chat UI (VSCode-Copilot style) over the reactive document-assistant
 * session: a view-state machine (sessions list ↔ chat), a message list with
 * stick-to-bottom scrolling, and the sticky composer.
 *
 * Credentials are NOT a state of this panel. A provider key is a roaming APPLICATION setting
 * configured once, so it lives in Preferences › Assistant (⌘,) — not in a dialog reachable only
 * from the panel that is broken for want of one. The panel with no key configured still opens on an
 * invitation to talk, with the way to fix it offered beneath. It repaints when a credential is
 * saved or revoked by subscribing to `settings/preferences-accounts.ts`, which is a LEAF both
 * modules depend on rather than an import back into the sheet.
 *
 * Rendering: this panel owns a private rAF-coalesced render loop into the assistant
 * `.panel-body` container (bound once via {@link bindAiPanelHost}). It deliberately
 * bypasses the right-panel scheduler's focus guard — streaming must repaint while the
 * composer is focused — which is safe because nothing here is value-bound (the composer
 * textarea is uncontrolled). The right panel renders the same template into the same
 * container on tab switches; lit reconciles both paths through one part cache.
 *
 * @docs studio/ai/chat
 * @license MIT
 */

import { html, render as litRender, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { effect, effectScope } from "../reactivity";
import { createDocumentAssistant } from "../services/document-assistant";
import { writesForTurn } from "../services/ai-writes";
import { notify } from "../services/notify";
import { undo } from "../tabs/transact";
import { activeTab } from "../workspace/workspace";
import { setOpenAiKey } from "../services/ai-settings";
import { hasAiCredentials } from "../services/ai-models";
import { openPreferences } from "../settings/preferences-dialog";
import { onCredentialsChanged } from "../settings/preferences-accounts";
import { setDockCollapsed } from "../shell";
import { hasSelection } from "../commands/context";
import { clearMarkdownCache } from "./ai-chat/chat-markdown";
import { renderChatHeader, renderMessageList } from "./ai-chat/chat-view";
import { createComposer } from "./ai-chat/composer";
import { renderSessionsList } from "./ai-chat/sessions-view";
import { setInspectorTab } from "./right-panel";

import type { AnyCommand } from "../commands/registry";
import type { CommandContext } from "../commands/context";
import type { EffectScope } from "@vue/reactivity";

// ─── State (module-level, persists across tab switches) ─────────────────────

let mounted = false;

/** Which pane the panel shows. */
let view: "chat" | "sessions" = "chat";

/** Document AST assistant session — created lazily, persists across tab switches. */
const assistant = createDocumentAssistant();
(globalThis as Record<string, unknown>).assistant = assistant;
let assistantScope: EffectScope | null = null;

// ─── Render loop ────────────────────────────────────────────────────────────

/** The assistant tab's `.panel-body` container, bound once by the right panel. */
let hostEl: HTMLElement | null = null;
let renderQueued = false;

/**
 * Bind the panel's render host and start the streaming watcher. Called once from the right panel's
 * container setup; replaces the old global render-bridge.
 *
 * @param {HTMLElement} el
 */
export function bindAiPanelHost(el: HTMLElement) {
  hostEl = el;
  watchAssistant();
}

/** Coalesce a re-render of the whole panel onto the next animation frame. */
function scheduleAiRender() {
  if (renderQueued || !hostEl) {
    return;
  }
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (hostEl) {
      litRender(renderAiPanelTemplate(), hostEl);
      maintainScroll();
    }
  });
}

/**
 * Reactively repaint on chat-state changes. Tracks the message count, the tail message's growth
 * (streaming deltas / tool calls), status, and errors; the actual DOM work happens in the
 * rAF-coalesced render, so token rate never exceeds frame rate.
 */
function watchAssistant() {
  assistantScope?.stop();
  assistantScope = effectScope();
  assistantScope.run(() => {
    effect(() => {
      const cs = assistant.chatState;
      void cs.messages.length;
      const last = cs.messages.at(-1);
      void last?.content;
      void last?.toolCalls?.length;
      void cs.status;
      void cs.error;
      scheduleAiRender();
    });
  });
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function mountAiPanel() {
  if (mounted) {
    return;
  }
  mounted = true;
  // A key saved (or revoked) in Preferences changes what this panel shows — the setup notice, and
  // Whether the composer can send. One subscription, and no import back into the sheet.
  onCredentialsChanged(scheduleAiRender);
}

// ─── Auto-scroll (stick to bottom unless the user scrolled up) ──────────────

let messagesEl: HTMLElement | null = null;
let stickToBottom = true;

/** How close (px) to the bottom still counts as "at the bottom". */
const STICK_THRESHOLD = 48;

function onMessagesScroll(e: Event) {
  const el = e.target as HTMLElement;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
}

function onMessagesListRef(el: Element | undefined) {
  messagesEl = (el as HTMLElement | undefined) ?? null;
  maintainScroll();
}

function maintainScroll() {
  if (messagesEl && stickToBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ─── The credentials gate's in-panel residue ─────────────────────────────────

/**
 * One line and the action that fixes it, under a chat that still invites a conversation.
 *
 * The action is `Preferences › Assistant`, not a dialog of this panel's own: a provider key is an
 * application setting, and the surface that owns application settings is the one that can also list
 * and revoke it. The probe fires here for the same reason the old gate fired it — a managed
 * platform or an env-keyed dev server may already be configured, and only `/models` knows.
 */
function renderSetupNotice(): TemplateResult {
  return html`
    <div class="ai-setup-notice">
      <span>No AI provider is connected yet.</span>
      <sp-button
        size="s"
        variant="secondary"
        @click=${() => {
          void openPreferences("assistant");
        }}
      >
        Open Preferences…
      </sp-button>
    </div>
  `;
}

// ─── Sending ────────────────────────────────────────────────────────────────

/** Send a message through the document assistant agent loop. */
async function handleAssistantSend(text: string) {
  if (!text.trim() || assistant.chatState.status === "streaming") {
    return;
  }
  // A send always lands in the chat view, pinned to the newest message.
  view = "chat";
  stickToBottom = true;
  scheduleAiRender();
  try {
    await assistant.sendMessage(text);
  } catch {
    // Synchronous failure (e.g. network unreachable) — the DocumentAssistant's
    // Own try/catch calls chatState.setError(), which the watcher renders.
  }
}

/**
 * Re-send the last user message — §7.4's Retry.
 *
 * `chatState.retryLast()` pops the failed assistant turn AND the user message that caused it, on
 * the contract that the caller re-sends. It has been exported with zero callers since it was
 * written, so a failed turn's only recovery was retyping the prompt. Read the text before popping;
 * there is nowhere else it survives.
 */
async function handleRetry(): Promise<void> {
  const cs = assistant.chatState;
  const lastUser = cs.messages.toReversed().find((m) => m.role === "user");
  if (!lastUser) {
    return;
  }
  const { content } = lastUser;
  cs.retryLast();
  scheduleAiRender();
  await handleAssistantSend(content);
}

/**
 * Undo everything one assistant turn changed — §7.4's "Restore to here".
 *
 * The loop opens one batch per turn per document, so undoing the turn is undoing that batch. The
 * button is offered by the renderer only when every recorded change was transactional; this guard
 * is the second half of the same promise, because a ledger can be trimmed (MAX_TURNS) between the
 * render and the click and a Restore that silently restored SOME of a turn would be worse than one
 * that refused.
 *
 * @param {string} messageId
 */
/* Exported so the guard can be exercised directly: the button is not RENDERED for a turn that
   touched disk, which would otherwise make the refusal path unreachable from the panel. */
export function handleRestore(messageId: string): void {
  const writes = writesForTurn(messageId);
  if (writes.length === 0) {
    notify.warn("There is no longer a record of what that turn changed.", { source: "Assistant" });
    return;
  }
  const disk = writes.filter((w) => w.disk).map((w) => w.path);
  if (disk.length > 0) {
    notify.warn(
      `Cannot restore: ${disk.join(", ")} ${disk.length === 1 ? "was" : "were"} written straight ` +
        "to disk, which undo cannot reach.",
      { source: "Assistant" },
    );
    return;
  }
  const tab = activeTab.value;
  if (!tab) {
    notify.warn("Open the document that turn edited to restore it.", { source: "Assistant" });
    return;
  }
  undo(tab);
  notify.success("Restored to before that turn.", { action: "edit.redo", source: "Assistant" });
  scheduleAiRender();
}

/**
 * Seed the assistant with a prompt programmatically (e.g. the New Project flow handing off a
 * project brief). Delegates to the same send path as the composer. Safe to call right after the
 * Assistant tab renders — the reactive watcher paints chat-state into the panel whenever it
 * mounts.
 */
export async function seedAssistantPrompt(text: string): Promise<void> {
  await handleAssistantSend(text);
}

// ─── Automation seeding (screenshot runner) ─────────────────────────────────

/** A canned tool-call chip for {@link seedAssistantMessages}. */
export interface SeededToolCall {
  name: string;
  /** JSON-encoded arguments, e.g. `{"path":["children",0],"text":"…"}`. */
  arguments: string;
}

/** A canned transcript entry for {@link seedAssistantMessages}. */
export interface SeededAssistantMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: SeededToolCall[];
}

let seededCount = 0;

/**
 * Automation-only seam (scripts/screenshots): stage a canned conversation without ever invoking a
 * model. Stores an inert demo key so the key gate opens (localStorage-only on the dev server — no
 * request fires), switches to the chat view, and pushes fully-formed messages straight into the
 * reactive chat state — the same path session restore uses — so the panel repaints through its
 * normal watcher.
 */
export function seedAssistantMessages(messages: SeededAssistantMessage[]): void {
  setOpenAiKey("sk-demo");
  view = "chat";
  stickToBottom = true;
  for (const msg of messages) {
    seededCount += 1;
    const seq = seededCount;
    assistant.chatState.messages.push({
      content: msg.content,
      id: `seeded_${seq}`,
      role: msg.role,
      timestamp: seq,
      ...(msg.toolCalls
        ? {
            toolCalls: msg.toolCalls.map((tc, i) => ({
              arguments: tc.arguments,
              id: `seeded_${seq}_tc${i}`,
              name: tc.name,
            })),
          }
        : {}),
    });
  }
  scheduleAiRender();
}

// ─── Controls ─────────────────────────────────────────────────────────────────

/**
 * Show the assistant: open the Inspector, then select its fourth tab.
 *
 * The two lines `view.setAssistant { open: true }` runs, in the module that owns the surface, so
 * the three callers that need them — that record, `chat-panel.ts`'s pending-prompt handoff, and
 * every `Assistant:` command below — do not each keep their own copy. `chat-panel.ts` had one
 * inline, and a reveal that opens the dock but forgets the tab (or the reverse) is a silent
 * half-success.
 */
export function revealAssistant(): void {
  setDockCollapsed("right", false);
  setInspectorTab("assistant");
}

/**
 * Whether a turn is in flight — the probe `commands/live-context.ts` declares as `aiStreaming` and
 * projects onto `ctx.ai.streaming`.
 *
 * That source was declared optional with the note "there is nothing to read yet; the caller passes
 * a probe when one exists", and no caller ever did — so `ctx.ai.streaming` read `false` forever and
 * `assistant.stop` would have been permanently refused. Reading the reactive chat state here is
 * what makes the fact LIVE: `createLiveContext` builds a fresh record per predicate evaluation, so
 * a surface repainting from an effect tracks this status and re-renders when the stream starts or
 * ends.
 */
export function isAssistantStreaming(): boolean {
  return assistant.chatState.status === "streaming";
}

function stop() {
  assistant.stop();
}

function newChat() {
  assistant.newChat();
  clearMarkdownCache();
  view = "chat";
  stickToBottom = true;
  scheduleAiRender();
}

function openSession(id: string) {
  assistant.openSession(id);
  clearMarkdownCache();
  view = "chat";
  stickToBottom = true;
  scheduleAiRender();
}

function deleteSession(id: string) {
  assistant.deleteSession(id);
  scheduleAiRender();
}

function showSessions() {
  view = "sessions";
  scheduleAiRender();
}

/** The open session's title for the chat header (null → "New chat"). */
function activeSessionTitle(): string | null {
  const id = assistant.activeSessionId();
  if (!id) {
    return null;
  }
  return assistant.listSessions().find((s) => s.id === id)?.title ?? null;
}

// ─── Composer ───────────────────────────────────────────────────────────────

const composer = createComposer({
  isStreaming: isAssistantStreaming,
  onOpenSettings: () => {
    void openPreferences("assistant");
  },
  onSend: (text) => {
    void handleAssistantSend(text);
  },
  onStop: stop,
  requestRender: scheduleAiRender,
});

/**
 * Reveal the assistant, put it on the chat view, and place the caret in the composer.
 *
 * The focus rides a frame because {@link scheduleAiRender} is rAF-coalesced: revealing from the
 * sessions list means the textarea does not exist yet, and focusing a node that is about to be
 * replaced would leave the caret nowhere. Ordering holds because this frame is queued after the
 * render's.
 */
function focusComposer(): void {
  revealAssistant();
  if (view !== "chat") {
    view = "chat";
    scheduleAiRender();
  }
  requestAnimationFrame(() => {
    composer.focus();
  });
}

// ─── The `Assistant:` command family (§11.1) ────────────────────────────────

/**
 * Six records, beside the chat session they write.
 *
 * §11.1 pays for the chat column's demotion into an Inspector tab with a command family, and the
 * `Assistant` category — declared in `commands/levels.ts` since the taxonomy landed — held ZERO
 * records. Every capability below already existed and every one of them existed ONLY as a button in
 * this panel: not in the palette, not bindable, not reachable by `__jxAutomation` or by name, and
 * absent from the generated commands and shortcuts sheets. A capability that one surface can reach
 * and the registry cannot is the second definition site inverted.
 *
 * **All six are `level: "application"`, by principle 3 — a record is filed by the level of the
 * state it WRITES, not the state it reads.** The chat session is application state: it outlives the
 * open document, survives project close, and `assistant.attachSelection` is the case that proves
 * the rule — it READS the canvas selection and writes a chip into the composer, so it is
 * application, not selection, however selection-ish it looks. That is also why it may declare
 * `menus: ["palette"]` at all: `blockbar` and `context/element` admit selection-level records
 * only.
 *
 * **No `aiTool` on any of them.** The assistant projecting "start a new chat" into its own tool
 * list would let a turn end its own conversation; the tier tables in `services/ai-tools.ts` gate
 * what the agent may do TO A PROJECT, not to the chat it is running inside.
 */
export function assistantCommands(): AnyCommand[] {
  return [
    {
      category: "Assistant",
      id: "assistant.focus",
      level: "application",
      /* A sixth record, and it earns its place: `inspector.focus.assistant` (⌘⇧4) is DOCUMENT-level
         and refuses when nothing is open — which is exactly the state the assistant is most wanted
         in, because the panel deliberately renders with no project and no document. `view.setAssistant`
         is `menus: ["never"]`. Neither puts the caret anywhere, so neither answers "let me type".
         The title is distinct on purpose: two palette rows printing one sentence is the defect
         `tests/app-commands-composition.test.ts` refuses, and "Show Assistant" is already taken. */
      title: "Focus Composer",
      keybinding: "mod+shift+a",
      menus: ["palette"],
      group: "1_chat",
      run: focusComposer,
    },
    {
      category: "Assistant",
      id: "assistant.newChat",
      level: "application",
      title: "New Chat",
      menus: ["palette"],
      group: "1_chat",
      // No `enablement` on the stream: `newChat()` calls `stop()` first (see
      // `services/document-assistant.ts`), so starting one mid-turn is already the handled case.
      run: () => {
        revealAssistant();
        newChat();
      },
    },
    {
      category: "Assistant",
      id: "assistant.history",
      level: "application",
      title: "Chat History",
      menus: ["palette"],
      group: "1_chat",
      run: () => {
        revealAssistant();
        showSessions();
      },
    },
    {
      category: "Assistant",
      id: "assistant.attachSelection",
      level: "application",
      title: "Attach Selection",
      menus: ["palette"],
      group: "2_turn",
      requires: "an element selected on the canvas",
      // `hasSelection` is `commands/context.ts`'s shared predicate — the same one the element menu
      // And the structural verbs are gated on, so "a selection" means one thing in three menus.
      when: (ctx: CommandContext) => hasSelection(ctx),
      run: () => {
        if (!composer.attachSelection()) {
          // Reachable despite `when`: a script or the palette can race the selection away between
          // The predicate and the run, and a silent no-op would look like the chip had landed.
          notify.warn("Nothing is selected to attach.", { source: "Assistant" });
          return;
        }
        focusComposer();
      },
    },
    {
      category: "Assistant",
      id: "assistant.retry",
      level: "application",
      title: "Retry Last Message",
      menus: ["palette"],
      group: "2_turn",
      requires: "a connected AI provider, and no turn already in flight",
      /* `ctx.ai.configured` and `ctx.ai.streaming` have been declared in `commands/context.ts` with
         zero readers; this record and `assistant.stop` are the first. Re-sending with no provider
         connected reproduces the same failure the error row is already explaining, and re-sending
         mid-stream would interleave two turns. */
      enablement: (ctx: CommandContext) => ctx.ai.configured && !ctx.ai.streaming,
      run: () => {
        revealAssistant();
        void handleRetry();
      },
    },
    {
      category: "Assistant",
      id: "assistant.stop",
      level: "application",
      title: "Stop Responding",
      menus: ["palette"],
      group: "2_turn",
      requires: "a turn in flight",
      enablement: (ctx: CommandContext) => ctx.ai.streaming,
      run: stop,
    },
  ];
}

// ─── Template ───────────────────────────────────────────────────────────────

/** @returns {TemplateResult} */
export function renderAiPanelTemplate(): TemplateResult {
  if (view === "sessions") {
    return html`
      <div class="ai-tab-body">
        ${renderSessionsList({
          onDelete: deleteSession,
          onOpen: openSession,
          sessions: assistant.listSessions(),
        })}
      </div>
    `;
  }

  const cs = assistant.chatState;
  return html`
    <div class="ai-tab-body">
      ${renderChatHeader({
        overBudget: cs.contextWarning,
        streaming: cs.status === "streaming",
        title: activeSessionTitle(),
        tokens: cs.tokenCount,
      })}
      ${renderMessageList({
        error: cs.error,
        listRef: onMessagesListRef,
        messages: cs.messages,
        onRestore: handleRestore,
        onScroll: onMessagesScroll,
        status: cs.status,
      })}
      ${hasAiCredentials() ? nothing : renderSetupNotice()} ${composer.render()}
    </div>
  `;
}
