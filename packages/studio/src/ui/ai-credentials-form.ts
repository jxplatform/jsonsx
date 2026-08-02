/// <reference lib="dom" />
/**
 * Ai-credentials-form.ts — reusable AI provider credentials form (key / model / endpoint).
 *
 * Embedded by every host that needs a provider configured — the `Assistant: Settings…` dialog and
 * the New Project modal's Import/Agent gates. All draft/model-list state lives inside the closure,
 * so multiple instances never share state. Persists via src/services/ai-settings.ts on Save.
 *
 * Built from Spectrum controls with its layout in `styles/shell.css`: a roaming credential the user
 * configures once does not get its own bespoke inputs, and it certainly does not get 200-character
 * inline `style=` strings that stop responding the moment the theme changes.
 *
 * @license MIT
 */

import { html, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { fetchAvailableModels, invalidateModelCache } from "../services/ai-models";
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
    invalidateModelCache();
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
   * Fetch available models via src/services/ai-models.ts, preferring the in-form drafts over the
   * stored settings so the list reflects the credentials being edited. Always forces past the
   * module cache — this runs on explicit user action (or first open) with possibly-new drafts.
   */
  async function fetchModels() {
    modelsLoading = true;
    modelsError = "";
    opts.requestRender();
    try {
      availableModels = await fetchAvailableModels({
        apiKey: getOpenAiKey() || keyDraft,
        baseUrl: baseUrlDraft || getBaseUrl(),
        force: true,
      });
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
      <div class="ai-creds-form">
        <div class="ai-creds-title">AI provider key</div>
        <div class="ai-creds-note">
          ${
            opts.intro === undefined
              ? html`
                  Any OpenAI-compatible key works. Stored locally in this browser; sent only to the
                  Studio proxy (never to a third party except your chosen endpoint).
                `
              : opts.intro
          }
        </div>
        <sp-textfield
          class="ai-creds-field"
          type="password"
          size="s"
          placeholder="sk-… or any compatible key"
          .value=${keyDraft}
          @input=${(e: Event) => {
            keyDraft = (e.target as HTMLInputElement).value;
          }}
        ></sp-textfield>
        <div class="ai-creds-label">Model</div>
        ${
          availableModels.length > 0
            ? html`
                <sp-combobox
                  class="ai-creds-field"
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
                <sp-textfield
                  class="ai-creds-field"
                  size="s"
                  placeholder="Model ID (e.g. gpt-4o, claude-sonnet-4-20250514, etc.)"
                  .value=${modelDraft}
                  @input=${(e: Event) => {
                    modelDraft = (e.target as HTMLInputElement).value;
                  }}
                ></sp-textfield>
              `
        }
        <div class="ai-creds-models">
          <sp-button size="s" variant="secondary" ?disabled=${modelsLoading} @click=${fetchModels}>
            ${
              modelsLoading
                ? "Fetching…"
                : availableModels.length > 0
                  ? "Refresh models"
                  : "Fetch models"
            }
          </sp-button>
          ${modelsError ? html`<span class="ai-creds-error">${modelsError}</span>` : nothing}
        </div>
        <sp-textfield
          class="ai-creds-field"
          size="s"
          placeholder="Endpoint (optional, e.g. http://localhost:11434/v1)"
          .value=${baseUrlDraft}
          @input=${(e: Event) => {
            baseUrlDraft = (e.target as HTMLInputElement).value;
          }}
        ></sp-textfield>
        <div class="ai-creds-actions">
          ${
            haveKey
              ? html`<sp-button size="s" variant="secondary" @click=${cancel}>Cancel</sp-button>`
              : nothing
          }
          <sp-button size="s" variant="primary" @click=${save}>Save</sp-button>
        </div>
      </div>
    `;
  }

  return { render, startEdit };
}
