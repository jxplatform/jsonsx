/// <reference lib="dom" />
/**
 * Ai-credentials-form.ts — reusable AI provider credentials form (key / model / endpoint).
 *
 * Extracted from the ai-panel key gate so other hosts (e.g. the New Project modal) can embed the
 * same form. All draft/model-list state lives inside the closure, so multiple instances never
 * share state. Persists via src/services/ai-settings.ts on Save.
 *
 * @license MIT
 */

import { html, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { getPlatform } from "../platform";
import {
  getBaseUrl,
  getModel,
  getOpenAiKey,
  hasOpenAiKey,
  setBaseUrl,
  setModel,
  setOpenAiKey,
} from "../services/ai-settings";

export interface AiCredentialsFormOptions {
  /** Host re-render scheduler — called whenever the form's internal state changes. */
  requestRender: () => void;
  /** Called after Save persists the credentials. */
  onSaved?: () => void;
  /** Called when Cancel dismisses the form (Cancel is only offered when a key already exists). */
  onCancel?: () => void;
  /** Optional context line (TemplateResult | string) replacing the default blurb. */
  intro?: unknown;
}

export interface AiCredentialsForm {
  render: () => TemplateResult;
  /** Preload drafts from the stored ai-settings and auto-fetch the model list. */
  startEdit: () => void;
}

/**
 * Create an AI credentials form instance bound to a host's render scheduler.
 *
 * @param {AiCredentialsFormOptions} opts
 * @returns {AiCredentialsForm}
 */
export function createAiCredentialsForm(opts: AiCredentialsFormOptions): AiCredentialsForm {
  let keyDraft = "";
  let baseUrlDraft = "";
  let modelDraft = "";

  /** Fetched from the proxy's /models endpoint (sibling of the chat endpoint). */
  let availableModels: { id: string; name: string }[] = [];
  let modelsLoading = false;
  let modelsError = "";

  /** Open the form pre-filled with the current settings, and load the model list. */
  function startEdit() {
    keyDraft = getOpenAiKey();
    baseUrlDraft = getBaseUrl();
    modelDraft = getModel();
    opts.requestRender();
    // Auto-fetch available models if not already loaded.
    if (availableModels.length === 0 && !modelsLoading) {
      void fetchModels();
    }
  }

  /** Persist the drafted key + endpoint + model and notify the host. */
  function save() {
    setOpenAiKey(keyDraft);
    setBaseUrl(baseUrlDraft);
    setModel(modelDraft);
    keyDraft = "";
    baseUrlDraft = "";
    modelDraft = "";
    // Clear fetched models so they're re-fetched with the new credentials next time.
    availableModels = [];
    opts.onSaved?.();
    opts.requestRender();
  }

  /** Dismiss the form without saving (only offered when a key already exists). */
  function cancel() {
    keyDraft = "";
    baseUrlDraft = "";
    modelDraft = "";
    opts.onCancel?.();
    opts.requestRender();
  }

  /**
   * Fetch available models from the proxy's /models endpoint (the chat endpoint's sibling). Sends
   * the stored API key as X-Api-Key so the proxy can forward to the upstream provider, and the
   * chosen endpoint as X-Api-Base-URL so the proxy lists models from THAT provider rather than the
   * default OpenAI host.
   */
  async function fetchModels() {
    modelsLoading = true;
    modelsError = "";
    opts.requestRender();
    try {
      const plat = getPlatform();
      const chatUrl = await Promise.resolve(plat.aiChatUrl());
      const modelsUrl = chatUrl.replace(/\/chat$/, "/models");

      const headers: Record<string, string> = {};
      const storedKey = getOpenAiKey() || keyDraft;
      if (storedKey) {
        headers["X-Api-Key"] = storedKey;
      }
      const baseUrl = baseUrlDraft || getBaseUrl();
      if (baseUrl) {
        headers["X-Api-Base-URL"] = baseUrl;
      }

      const resp = await fetch(modelsUrl, { headers });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { models?: { id: string; name?: string }[] };
      availableModels = (data.models || []).map((m: { id: string; name?: string }) => ({
        id: m.id,
        name: m.name || m.id,
      }));
    } catch (error: unknown) {
      modelsError = (error as Error).message || "Failed to fetch models";
    } finally {
      modelsLoading = false;
      opts.requestRender();
    }
  }

  /** The key + model + endpoint form column. */
  function render(): TemplateResult {
    const haveKey = hasOpenAiKey();
    return html`
      <div
        class="ai-creds-form"
        style="display:flex;flex-direction:column;gap:10px;max-width:320px;text-align:left"
      >
        <div style="font-weight:600;align-self:center">AI provider key</div>
        ${opts.intro === undefined
          ? html`
              <div style="font-size:11px;color:var(--fg-dim)">
                Any OpenAI-compatible key works. Stored locally in this browser; sent only to the
                Studio proxy (never to a third party except your chosen endpoint).
              </div>
            `
          : html`<div style="font-size:11px;color:var(--fg-dim)">${opts.intro}</div>`}
        <input
          type="password"
          style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-input);color:var(--fg);font-size:12px"
          placeholder="sk-… or any compatible key"
          .value=${keyDraft}
          @input=${(e: Event) => {
            keyDraft = (e.target as HTMLInputElement).value;
          }}
        />
        <div style="font-weight:500;font-size:11px;margin-top:4px">Model</div>
        ${availableModels.length > 0
          ? html`
              <sp-combobox
                size="s"
                allows-custom-value
                .value=${modelDraft}
                @change=${(e: Event) => {
                  modelDraft = (e.target as HTMLInputElement).value;
                }}
                @input=${(e: Event) => {
                  modelDraft = (e.target as HTMLInputElement).value;
                }}
              >
                ${availableModels.map(
                  (m) => html`<sp-menu-item value=${m.id}>${m.name}</sp-menu-item>`,
                )}
              </sp-combobox>
            `
          : html`
              <input
                type="text"
                style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-input);color:var(--fg);font-size:12px"
                placeholder="Model ID (e.g. gpt-4o, claude-sonnet-4-20250514, etc.)"
                .value=${modelDraft}
                @input=${(e: Event) => {
                  modelDraft = (e.target as HTMLInputElement).value;
                }}
              />
            `}
        <div style="display:flex;gap:8px;align-items:center">
          <sp-button size="s" variant="secondary" ?disabled=${modelsLoading} @click=${fetchModels}>
            ${modelsLoading
              ? "Fetching…"
              : availableModels.length > 0
                ? "Refresh models"
                : "Fetch models"}
          </sp-button>
          ${modelsError
            ? html`<span style="font-size:10px;color:var(--danger)">${modelsError}</span>`
            : nothing}
        </div>
        <input
          type="text"
          style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-input);color:var(--fg);font-size:12px"
          placeholder="Endpoint (optional, e.g. http://localhost:11434/v1)"
          .value=${baseUrlDraft}
          @input=${(e: Event) => {
            baseUrlDraft = (e.target as HTMLInputElement).value;
          }}
        />
        <div style="display:flex;gap:8px;align-self:flex-end">
          ${haveKey
            ? html`<sp-button size="s" variant="secondary" @click=${cancel}>Cancel</sp-button>`
            : nothing}
          <sp-button size="s" variant="primary" @click=${save}>Save</sp-button>
        </div>
      </div>
    `;
  }

  return { render, startEdit };
}
