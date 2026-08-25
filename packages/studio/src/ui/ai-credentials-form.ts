/// <reference lib="dom" />
/**
 * Ai-credentials-form.ts — reusable AI provider credentials form (key / model / endpoint).
 *
 * Embedded by every host that needs a provider configured — **Preferences › Assistant** (⌘,) and the
 * New Project modal's Import/Agent gates. All draft/model-list state lives inside the closure, so
 * multiple instances never share state. Persists via src/services/ai-settings.ts on Save.
 *
 * The interim `Assistant: Settings…` dialog that used to host it is deleted: a provider key is an
 * application setting, and the surface that owns application settings is also the one that can list
 * it and revoke it (plan §9.3). Nothing about this form changed for the move, which is the argument
 * for it having been a reusable form rather than a section of a dialog.
 *
 * Built from Spectrum controls with its layout in `styles/shell.css`: a roaming credential the user
 * configures once does not get its own bespoke inputs, and it certainly does not get 200-character
 * inline `style=` strings that stop responding the moment the theme changes.
 *
 * @license MIT
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import type { TemplateResult } from "lit-html";
import { fetchAvailableModels } from "../services/ai-models";
import {
  getBaseUrl,
  getOpenAiKey,
  hasOpenAiKey,
  saveAiProvider,
  storedModel,
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

  /**
   * Load the drafts from what is stored.
   *
   * The model comes from {@link storedModel} rather than `getModel()`, so a user who has never
   * picked one drafts an empty field instead of the `"gpt-4o"` default. Saving a prefilled default
   * writes a choice nobody made, and `jx.ai.model: "gpt-4o"` is exactly what a broken install was
   * left holding.
   */
  function loadDrafts() {
    keyDraft = getOpenAiKey();
    baseUrlDraft = getBaseUrl();
    modelDraft = storedModel();
  }

  /** Open the form pre-filled with the current settings, and load the model list. */
  function startEdit() {
    loadDrafts();
    opts.requestRender();
    // Auto-fetch available models if not already loaded.
    if (availableModels.length === 0 && !modelsLoading) {
      void fetchModels();
    }
  }

  /**
   * Persist the drafted key + endpoint + model and notify the host.
   *
   * **Re-seeds the drafts; it must never blank them.** Preferences is a place rather than a wizard
   * step, so the sheet stays open across Save and `startEdit` is not called again — which meant
   * every field emptied the instant a save succeeded. That reads as "it didn't take", and the
   * obvious response to it destroyed the credentials: a blank draft is what
   * `setOpenAiKey`/`setBaseUrl` treat as _clear_, so pressing Save a second time on the emptied
   * form deleted the key and endpoint that the first press had just stored. Reading back through
   * the getters also shows what was actually kept — trimmed, and with the endpoint's trailing slash
   * stripped — rather than what was typed.
   */
  function save() {
    saveAiProvider({ apiKey: keyDraft, baseUrl: baseUrlDraft, model: modelDraft });
    loadDrafts();
    modelsError = "";
    /* The fetched list stays: it was listed under exactly these credentials, and dropping it
       collapsed the model combobox back to a free-text field on every save. The module cache is
       dropped by ai-models' own settings subscription, so this form does not have to remember to. */
    opts.onSaved?.();
    opts.requestRender();
  }

  /** Dismiss the form without saving (only offered when a key already exists). */
  function cancel() {
    loadDrafts();
    modelsError = "";
    opts.onCancel?.();
    opts.requestRender();
  }

  /**
   * Fetch available models via src/services/ai-models.ts, preferring the in-form drafts over the
   * stored settings so the list reflects the credentials being edited. Always forces past the
   * module cache — this runs on explicit user action (or first open) with possibly-new drafts.
   *
   * Both lines below read draft-first. The key used to read stored-first, against this paragraph
   * and against the line beside it: editing a key in place and pressing Fetch models listed the OLD
   * key's models, and — worse — a form whose drafts had been blanked still fetched successfully
   * from storage, which is what made an emptied form look like it was working.
   */
  async function fetchModels() {
    modelsLoading = true;
    modelsError = "";
    opts.requestRender();
    try {
      availableModels = await fetchAvailableModels({
        credentials: {
          apiKey: keyDraft || getOpenAiKey(),
          baseUrl: baseUrlDraft || getBaseUrl(),
        },
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
          .value=${live(keyDraft)}
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
                  .value=${live(modelDraft)}
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
                  .value=${live(modelDraft)}
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
          .value=${live(baseUrlDraft)}
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
