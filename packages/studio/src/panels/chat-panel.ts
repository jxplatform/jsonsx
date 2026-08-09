/// <reference lib="dom" />
/**
 * Chat-panel.ts — the assistant, as the Inspector dock's fourth tab.
 *
 * **It is not a column and it is not a dock.** `#chat-panel` was a fifth permanent grid column
 * ~300px wide; then it was a node sharing the Inspector's cell; it is now the body of one tab
 * beside Content, Style and Logic. Nothing about the chat UI changed for any of those moves, which
 * is what {@link mount} taking a host rather than finding one has bought: `right-panel.ts` builds
 * the four tab containers and hands this module the fourth.
 *
 * The `inspector.assistant` region is stamped HERE, on the container this module owns, rather than
 * in `ui/regions.ts`'s shell table — the assistant no longer has a shell host to name. Three
 * screenshot shots address that id and none of them changed.
 *
 * Hosts the assistant UI from ai-panel.ts unconditionally: with no project (welcome screen), with a
 * project but no open document, and with a document open. The panel is mounted once at studio boot
 * and never tears down on tab switches — the assistant's module state and DOM (composer draft,
 * scroll position) persist.
 *
 * Deliberately NOT built on createPanelScheduler: ai-panel owns a focus-guard-free rAF render loop
 * (streaming must repaint while the composer is focused). This module only provides the host
 * container, the initial paint, and the pending-agent-prompt handoff; ai-panel's watcher drives all
 * chat-state repaints through the same lit part cache.
 *
 * @license MIT
 */

import { render as litRender } from "lit-html";
import { effect, effectScope } from "../reactivity";
import { setDockCollapsed } from "../shell";
import { workspace } from "../workspace/workspace";
import { consumePendingAgentPrompt, hasPendingAgentPrompt } from "../services/agent-seed";
import { setInspectorTab } from "./right-panel";
import { REGION_ATTR } from "../ui/regions";
import {
  bindAiPanelHost,
  mountAiPanel,
  renderAiPanelTemplate,
  seedAssistantPrompt,
} from "./ai-panel";

import type { EffectScope } from "@vue/reactivity";

/** The region id every assistant screenshot crops to. Stamped on the container, not on a div. */
const ASSISTANT_REGION = "inspector.assistant";

let _host: HTMLElement | null = null;
let _container: HTMLElement | null = null;
let _scope: EffectScope | null = null;

/**
 * Mount the assistant into the host the Inspector hands it. Idempotent per host: the persistent
 * `.ai-panel-host` container is created once and bound as the ai-panel render host (lit needs a
 * single render target for its part cache). A missing host (a reduced test fixture with no
 * inspector) is a no-op.
 *
 * @param {HTMLElement | null} host
 */
export function mount(host: HTMLElement | null) {
  if (!host || (_host === host && _container)) {
    return;
  }
  _host = host;
  _container = document.createElement("div");
  _container.className = "ai-panel-host";
  _container.setAttribute(REGION_ATTR, ASSISTANT_REGION);
  host.textContent = "";
  host.append(_container);

  mountAiPanel();
  // The AI panel owns a focus-guard-free rAF render loop into this container so
  // Streaming repaints while the composer is focused (see ai-panel.ts).
  bindAiPanelHost(_container);
  render();

  _scope?.stop();
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      // A pending agent prompt (stored by the New Project flow, possibly from another window) is
      // Keyed by the absolute project root — consume it as soon as this window adopts that root.
      const root = workspace.projectRoot;
      if (!root || !hasPendingAgentPrompt(root)) {
        return;
      }
      // Reveal the assistant the way any other inspector tab is revealed: open the dock it lives
      // In, then select it. There is no assistant dock left to open.
      setDockCollapsed("right", false);
      setInspectorTab("assistant");
      const prompt = consumePendingAgentPrompt(root);
      if (prompt) {
        // Defer past the current render so the assistant machinery is in place before the send.
        requestAnimationFrame(() => {
          void seedAssistantPrompt(prompt);
        });
      }
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  if (_host) {
    _host.textContent = "";
  }
  _host = null;
  _container = null;
}

/** Repaint the assistant template into the persistent container (no-op before mount). */
export function render() {
  if (_container) {
    litRender(renderAiPanelTemplate(), _container);
  }
}
