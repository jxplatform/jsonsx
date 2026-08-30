/// <reference lib="dom" />
/**
 * Ai-model-picker.ts — the provider's model catalogue as one `sp-picker`, for every surface that
 * chooses a model.
 *
 * It was private to `panels/ai-chat/composer.ts`, which was correct while the chat composer was the
 * only place a model could be chosen. The New Project **Import** source now chooses one too — and
 * that run spends more tokens than any single chat turn — so the choice needed a second host. A
 * copy would have been two implementations of the invariant below, which is exactly the kind that
 * only breaks in the copy nobody looked at.
 *
 * **The list is never held privately.** It is read from `cachedModels(credentials)` on every
 * render, so a list can only ever be shown for the credentials it was listed under: change the key
 * and the catalogue becomes UNAVAILABLE rather than stale. Holding it in a closure is what once let
 * the picker offer one provider's models while another was configured.
 *
 * A closure factory (precedent: `createComposer`, `createAiCredentialsForm`) so two hosts never
 * share a loading flag or a failed-fetch record.
 *
 * @license MIT
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import {
  aiConnection,
  cachedModels,
  fetchAvailableModels,
  modelToolSupport,
  preferredModel,
} from "../services/ai-models";
import { setModel } from "../services/ai-settings";

import type { TemplateResult } from "lit-html";
import type { AiCredentials } from "../services/ai-models";

/** The `sp-menu-item` value that means "try listing again" rather than "select this model". */
export const RETRY_MODELS = "__retry_models__";

/** The `sp-menu-item` value of the disabled placeholder shown during the first fetch. */
export const LOADING_MODELS = "__loading__";

/** What a listed model's row says when the backend reported it cannot call tools. */
export const NO_TOOLS_SUFFIX = " — no tools";

/**
 * A model's row label: its name, plus a note when it is known to be chat-only.
 *
 * Labelled, never filtered or disabled. Choosing a chat-only model to ask questions of is a
 * legitimate thing to do, and a picker that hides half a managed catalogue would be reporting a
 * capability gap as an outage. Only `toolSupport === false` is labelled — `undefined` is a BYOK
 * provider saying nothing, and a suffix there would be an invention.
 */
function itemLabel(model: { id: string; name: string }): string {
  return modelToolSupport(model.id) === false ? `${model.name}${NO_TOOLS_SUFFIX}` : model.name;
}

export interface ModelPickerOptions {
  /** Host re-render scheduler — called whenever a fetch settles. */
  requestRender: () => void;
  /**
   * The model to show as selected. Defaults to the stored/proxy-preferred one, which is what the
   * chat composer wants; the Import form passes its own draft, which is not a stored setting until
   * the run starts.
   */
  getModel?: () => string;
  /**
   * Where a choice goes. Defaults to `setModel` (the roaming application preference). The Import
   * form passes its own setter, because choosing a model for one import must not silently retarget
   * the assistant.
   */
  onChange?: (id: string) => void;
  /** Extra class on the `sp-picker`, so a host can size it without touching this module. */
  className?: string;
  /** Picker size; `"s"` (the composer's) by default. */
  size?: "s" | "m";
}

export interface ModelPicker {
  render: () => TemplateResult;
  /** Whether a fetch is in flight — for a host that wants to disable a submit button. */
  isLoading: () => boolean;
  /** The last fetch's failure, or `""`. */
  error: () => string;
  /**
   * Whether the selected model is known NOT to support tools — for a host that wants to say so.
   *
   * `false` while the backend has no opinion, so a host reads it as "warn" rather than as "block".
   */
  selectedLacksTools: () => boolean;
}

/**
 * Create a model picker bound to a host's render scheduler.
 *
 * @param {ModelPickerOptions} opts
 * @returns {ModelPicker}
 */
export function createModelPicker(opts: ModelPickerOptions): ModelPicker {
  const getModel = opts.getModel ?? preferredModel;
  const onChange = opts.onChange ?? setModel;

  let loading = false;
  let failure = "";

  /**
   * The credentials the last fetch was made FOR, so a failure is not retried on every render.
   *
   * The list itself is deliberately not held here — see the module docblock.
   */
  let attempted: AiCredentials | null = null;

  function sameConnection(a: AiCredentials | null, b: AiCredentials): boolean {
    return a !== null && a.apiKey === b.apiKey && a.baseUrl === b.baseUrl;
  }

  function ensureModels(force = false) {
    const credentials = aiConnection();
    const settled = cachedModels(credentials) !== null || sameConnection(attempted, credentials);
    if (loading || (settled && !force)) {
      return;
    }
    loading = true;
    failure = "";
    attempted = credentials;
    fetchAvailableModels({ credentials, force })
      .catch((error: unknown) => {
        failure = (error as Error).message || "Failed to fetch models";
      })
      .finally(() => {
        loading = false;
        opts.requestRender();
      });
  }

  function onPickerChange(e: Event) {
    const { value } = e.target as HTMLInputElement;
    if (value === RETRY_MODELS) {
      attempted = null;
      ensureModels(true);
      // Re-render so the picker snaps back to the current model instead of showing "Retry".
      opts.requestRender();
      return;
    }
    if (value && value !== LOADING_MODELS) {
      onChange(value);
    }
  }

  function render(): TemplateResult {
    ensureModels();
    const current = getModel();
    const listed = cachedModels(aiConnection()) ?? [];
    /* A catalogue that does not contain the current model still has to show it selected — an
       unlisted id is the normal case for a self-hosted or newly released model. */
    const items = listed.some((m) => m.id === current)
      ? listed
      : [{ id: current, name: current }, ...listed];
    return html`
      <sp-picker
        size=${opts.size ?? "s"}
        quiet
        class=${opts.className ?? "ai-model-picker"}
        title=${failure ? `Couldn't load models: ${failure}` : "Model"}
        .value=${live(current)}
        @change=${onPickerChange}
      >
        ${items.map((m) => html`<sp-menu-item value=${m.id}>${itemLabel(m)}</sp-menu-item>`)}
        ${
          loading
            ? html`<sp-menu-item disabled value=${LOADING_MODELS}>Loading models…</sp-menu-item>`
            : nothing
        }
        ${
          failure
            ? html`<sp-menu-item value=${RETRY_MODELS}>Retry loading models</sp-menu-item>`
            : nothing
        }
      </sp-picker>
    `;
  }

  return {
    error: () => failure,
    isLoading: () => loading,
    render,
    selectedLacksTools: () => modelToolSupport(getModel()) === false,
  };
}
