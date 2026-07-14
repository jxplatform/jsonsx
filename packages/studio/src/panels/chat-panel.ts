/// <reference lib="dom" />
/**
 * Chat-panel.ts — the persistent AI chat sidebar (`#chat-panel` shell region).
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
import { applyPanelCollapse, view } from "../view";
import { workspace } from "../workspace/workspace";
import { consumePendingAgentPrompt, hasPendingAgentPrompt } from "../services/agent-seed";
import {
  bindAiPanelHost,
  mountAiPanel,
  renderAiPanelTemplate,
  seedAssistantPrompt,
} from "./ai-panel";

import type { EffectScope } from "@vue/reactivity";

let _host: HTMLElement | null = null;
let _container: HTMLElement | null = null;
let _scope: EffectScope | null = null;

/**
 * Mount the chat sidebar into its shell region. Idempotent per host: the persistent `.panel-body`
 * container is created once and bound as the ai-panel render host (lit needs a single render target
 * for its part cache). A missing host (shell without a #chat-panel region, e.g. reduced test
 * fixtures) is a no-op.
 *
 * @param {HTMLElement | null} host
 */
export function mount(host: HTMLElement | null) {
  if (!host || (_host === host && _container)) {
    return;
  }
  _host = host;
  _container = document.createElement("div");
  _container.className = "panel-body";
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
      if (view.chatPanelCollapsed) {
        view.chatPanelCollapsed = false;
        applyPanelCollapse();
      }
      const prompt = consumePendingAgentPrompt(root);
      if (prompt) {
        // Defer past the current render so the assistant machinery is in place before the send.
        requestAnimationFrame(() => void seedAssistantPrompt(prompt));
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
