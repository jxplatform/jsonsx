/// <reference lib="dom" />
/**
 * New Project modal — a two-step wizard. Step 1 ("Start new project from:") picks the source on one
 * of four tabs: a built-in Template, a Starter Site, an Import of an existing site, or an Agent
 * prompt. Step 2 ("New Project Parameters") collects the project identity plus a design quickstart
 * (colors, fonts, logo, breakpoints — a creation-time subset of the settings modal), prefilled from
 * the chosen source and customizable before anything is written.
 *
 * Import and Agent are gated behind the AI credentials form until a key is stored.
 */

import { html } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { openModal } from "../ui/layers";
import { getPlatform } from "../platform";
import { installUrlOf } from "../platform-errors";
import { hasOpenAiKey } from "../services/ai-settings";
import { setPendingAgentPrompt } from "../services/agent-seed";
import { createAiCredentialsForm } from "../ui/ai-credentials-form";
import { PROJECT_TEMPLATES } from "./templates";
import { collectDesign, renderDesignFields, resetDesignFields } from "./design-fields";
import {
  collectDestination,
  loadLocationOptions,
  renderLocationFields,
  resetLocationFields,
} from "./location-fields";
import {
  cancelImport,
  importButtonLabel,
  isImportRunning,
  renderImportProgress,
  renderImportSource,
  renderImportStatus,
  resetImportTab,
  startImport,
  validateImportSource,
} from "./import-tab";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type { CreateProjectDestination, StarterInfo } from "../types";
import type { ImportTabCtx } from "./import-tab";

type NewProjectTab = "template" | "starter" | "import" | "agent";
type WizardStep = "source" | "params";

let _handle: ReturnType<typeof openModal> | null = null;

let _form = {
  adapter: "static",
  description: "",
  directory: "",
  name: "",
  url: "",
};

let _tab: NewProjectTab = "template";
let _step: WizardStep = "source";
let _template = "blank";
let _starter = "";
let _agentPrompt = "";

/** Which source the Parameters step was last seeded for — Back/Next keeps user edits intact. */
let _paramsSeededFor = "";

let _error = "";

/**
 * Inline validation error shown at the Project Name field (the global strip is for backend
 * failures).
 */
let _nameError = "";

/** GitHub-App install link carried by a structured needs_installation_access failure. */
let _errorInstallUrl = "";

function captureError(error: unknown) {
  _error = errorMessage(error);
  _errorInstallUrl = installUrlOf(error) ?? "";
}

/** After a failed submit, bring the params step back to the top and focus the name field. */
function focusNameField() {
  requestAnimationFrame(() => {
    const body = document.querySelector(".new-project-modal-body");
    body?.scrollTo?.(0, 0);
    body?.querySelector<HTMLElement>("sp-textfield")?.focus?.();
  });
}

let _creating = false;

/** Starter templates offered in the picker (empty until loaded / on platforms without starters). */
let _starters: StarterInfo[] = [];

let _resolve: ((result: { root: string; config: ProjectConfig } | null) => void) | null = null;

// One credentials form shared by the Import and Agent gates; lazy so the modal module can load
// Before a platform is registered (the form fetches models through the platform on edit).
let _credsForm: ReturnType<typeof createAiCredentialsForm> | null = null;

function credsForm() {
  _credsForm ??= createAiCredentialsForm({
    onSaved: () => {
      if (_handle) {
        renderModal();
      }
    },
    requestRender: () => {
      if (_handle) {
        renderModal();
      }
    },
  });
  return _credsForm;
}

/**
 * Open the New Project modal. Returns a promise that resolves with the created project info (or
 * null if cancelled).
 *
 * @returns {Promise<{ root: string; config: object } | null>}
 */
export function openNewProjectModal(options?: { tab?: "template" | "starter" }): Promise<{
  root: string;
  config: ProjectConfig;
} | null> {
  if (_handle) {
    return Promise.resolve(null);
  }
  _form = {
    adapter: "static",
    description: "",
    directory: "",
    name: "",
    url: "",
  };
  _tab = options?.tab ?? "template";
  _step = "source";
  _template = "blank";
  _starter = "";
  _agentPrompt = "";
  _paramsSeededFor = "";
  _error = "";
  _nameError = "";
  _errorInstallUrl = "";
  _creating = false;
  _starters = [];
  _dirDerived = true;
  resetImportTab();
  resetDesignFields();
  resetLocationFields();

  // Load the destination options (repo-mode owners) and starter templates in the background,
  // Re-rendering when they arrive. Platforms without starters leave the Starter Site tab showing
  // Its empty note.
  const platform = getPlatform();
  loadLocationOptions(() => {
    if (_handle) {
      renderModal();
    }
  });
  if (platform.listStarters) {
    void platform
      .listStarters()
      .then((starters) => {
        _starters = starters;
        if (!_starter) {
          _starter = starters[0]?.id ?? "";
        }
        if (_handle) {
          renderModal();
        }
      })
      .catch(() => {
        /* Non-fatal: the Starter tab keeps its empty note. */
      });
  }

  return new Promise((resolve) => {
    _resolve = resolve;
    renderModal();
  });
}

export function closeNewProjectModal() {
  if (!_handle || _creating || isImportRunning()) {
    return;
  }
  _handle.close();
  _handle = null;
  if (_resolve) {
    _resolve(null);
    _resolve = null;
  }
}

/** Close the modal and resolve its promise with a created/imported project. */
function finish(result: { root: string; config: ProjectConfig }) {
  _creating = false;
  if (_handle) {
    _handle.close();
    _handle = null;
  }
  if (_resolve) {
    _resolve(result);
    _resolve = null;
  }
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

/** The human label of the chosen source, shown as context on the Parameters step. */
function sourceLabel(): string {
  switch (_tab) {
    case "starter": {
      return `Starter Site · ${_starters.find((s) => s.id === _starter)?.name ?? _starter}`;
    }
    case "import": {
      return "Import";
    }
    case "agent": {
      return "Agent";
    }
    default: {
      return `Template · ${PROJECT_TEMPLATES.find((t) => t.id === _template)?.name ?? _template}`;
    }
  }
}

function renderModal() {
  const platform = getPlatform();
  const importCtx: ImportTabCtx = {
    credsForm: credsForm(),
    form: _form,
    onDone: finish,
    rerender: renderModal,
    resolveDestination: () => validateParams(),
  };

  const onInput =
    (field: "name" | "description" | "url" | "adapter" | "directory") => (e: Event) => {
      _form[field] = (e.target as HTMLInputElement).value;
      if (field === "name") {
        _nameError = "";
      }
      if (field === "name" && !_form.directory) {
        // Auto-derive directory slug from name while user hasn't manually typed one
        _dirDerived = true;
      }
      if (_dirDerived && field === "name") {
        _form.directory = deriveSlug(_form.name);
      }
      if (field === "directory") {
        _dirDerived = false;
      }
      renderModal();
    };

  const onAdapterChange = (e: Event) => {
    _form.adapter = (e.target as HTMLInputElement).value;
    renderModal();
  };

  const selectTemplate = (id: string) => {
    _template = id;
    renderModal();
  };

  const selectStarter = (id: string) => {
    _starter = id;
    renderModal();
  };

  const onTabChange = (e: Event) => {
    if (_creating || isImportRunning()) {
      return;
    }
    _tab = (e.target as HTMLElement & { selected: string }).selected as NewProjectTab;
    _error = "";
    renderModal();
  };

  // ─── Step transitions ──────────────────────────────────────────────────────

  const goNext = () => {
    if (_tab === "starter" && !_starter) {
      _error = "Choose a starter site";
      renderModal();
      return;
    }
    if (_tab === "import" && !validateImportSource(importCtx)) {
      return;
    }
    if (_tab === "agent" && !_agentPrompt.trim()) {
      _error = "Describe the site you want the agent to build";
      renderModal();
      return;
    }

    // Seed the Parameters step from the chosen source — only when the source changed, so Back +
    // Next round-trips keep the user's edits.
    const seedKey = `${_tab}:${_template}:${_starter}`;
    if (_paramsSeededFor !== seedKey) {
      _paramsSeededFor = seedKey;
      if (_tab === "starter") {
        const meta = _starters.find((s) => s.id === _starter);
        if (meta && !_form.description.trim()) {
          _form.description = meta.tagline;
        }
        resetDesignFields({
          ...(meta?.accent ? { accent: meta.accent } : {}),
          mediaNote: "Leave empty to keep the starter's breakpoints.",
        });
      } else if (_tab === "template" || _tab === "agent") {
        const templateId = _tab === "agent" ? "blank" : _template;
        const meta = PROJECT_TEMPLATES.find((t) => t.id === templateId);
        resetDesignFields(meta ? { media: meta.media } : {});
      }
    }

    _step = "params";
    _error = "";
    renderModal();
  };

  const goBack = () => {
    if (_creating || isImportRunning()) {
      return;
    }
    _step = "source";
    _error = "";
    _nameError = "";
    renderModal();
  };

  // ─── Submission ────────────────────────────────────────────────────────────

  /**
   * Validate the Parameters step, returning the destination to create at (null when something is
   * missing — the reason is already rendered inline and the modal re-drawn). The slug is derived
   * from the name when left blank, but the destination itself is never guessed.
   */
  const validateParams = (): CreateProjectDestination | null => {
    if (!_form.name.trim()) {
      _nameError = "Project name is required";
      renderModal();
      focusNameField();
      return null;
    }
    if (!_form.directory.trim()) {
      _form.directory = deriveSlug(_form.name);
    }
    const destination = collectDestination(_form.directory);
    if (!destination) {
      _nameError = "";
      renderModal();
      focusNameField();
      return null;
    }
    return destination;
  };

  const onSubmit = async () => {
    const destination = validateParams();
    if (!destination) {
      return;
    }

    _creating = true;
    _error = "";
    _nameError = "";
    renderModal();

    try {
      const design = collectDesign();
      const result = await getPlatform().createProject({
        ..._form,
        destination,
        ...(_tab === "starter" && _starter ? { starter: _starter } : { template: _template }),
        ...(design ? { design } : {}),
      });
      finish(result);
    } catch (error) {
      _creating = false;
      captureError(error);
      renderModal();
    }
  };

  const onAgentSubmit = async () => {
    const destination = validateParams();
    if (!destination) {
      return;
    }

    _creating = true;
    _error = "";
    _nameError = "";
    renderModal();

    try {
      const design = collectDesign();
      const result = await getPlatform().createProject({
        ..._form,
        destination,
        template: "blank",
        ...(design ? { design } : {}),
      });
      // The window that opens the project consumes this and hands the prompt to the assistant.
      setPendingAgentPrompt(result.root, _agentPrompt.trim());
      finish(result);
    } catch (error) {
      _creating = false;
      captureError(error);
      renderModal();
    }
  };

  // ─── Step 1: source selection ──────────────────────────────────────────────

  const templateSourceTpl = () => html`
    <div class="new-project-templates">
      ${PROJECT_TEMPLATES.map(
        (t) => html`
          <button
            type="button"
            class="new-project-template ${_template === t.id ? "selected" : ""}"
            @click=${() => selectTemplate(t.id)}
            title=${t.tagline}
          >
            <div class="new-project-template-blank">${t.glyph}</div>
            <div class="new-project-template-body">
              <div class="new-project-template-name">${t.name}</div>
              <div class="new-project-template-tag">${t.tagline}</div>
            </div>
          </button>
        `,
      )}
    </div>
  `;

  const starterSourceTpl = () =>
    _starters.length > 0
      ? html`
          <div class="new-project-templates">
            ${_starters.map(
              (s) => html`
                <button
                  type="button"
                  class="new-project-template ${_starter === s.id ? "selected" : ""}"
                  @click=${() => selectStarter(s.id)}
                  title=${s.description}
                >
                  <img class="new-project-template-thumb" src=${s.thumbnail} alt="" />
                  <div class="new-project-template-body">
                    <div class="new-project-template-name">${s.name}</div>
                    <div class="new-project-template-tag">${s.tagline}</div>
                  </div>
                </button>
              `,
            )}
          </div>
        `
      : html`<div class="new-project-tab-intro">No starter sites are available.</div>`;

  const agentSourceTpl = () => {
    if (!hasOpenAiKey()) {
      return html`
        <div class="new-project-tab-intro">
          The agent uses your AI provider to build the site. Add an OpenAI-compatible API key to
          continue.
        </div>
        <div class="new-project-creds">${credsForm().render()}</div>
      `;
    }
    return html`
      <div class="new-project-tab-intro">
        Describe the site you want; the assistant builds it in the editor while you watch.
      </div>
      <label class="new-project-field">
        <span class="new-project-label">Prompt *</span>
        <sp-textfield
          multiline
          class="new-project-agent-prompt"
          placeholder="A landing page for a small coffee roastery with a menu and contact form…"
          .value=${_agentPrompt}
          @input=${(e: Event) => {
            _agentPrompt = (e.target as HTMLInputElement).value;
          }}
          style="width: 100%"
        ></sp-textfield>
      </label>
    `;
  };

  const sourceBodyTpl = () => {
    switch (_tab) {
      case "starter": {
        return starterSourceTpl();
      }
      case "import": {
        return renderImportSource(importCtx);
      }
      case "agent": {
        return agentSourceTpl();
      }
      default: {
        return templateSourceTpl();
      }
    }
  };

  // ─── Step 2: parameters ────────────────────────────────────────────────────

  const nameDirFieldsTpl = () => html`
    <label class="new-project-field">
      <span class="new-project-label">Project Name *</span>
      <sp-textfield
        class="new-project-name"
        placeholder="My Site"
        .value=${_form.name}
        ?invalid=${Boolean(_nameError)}
        @input=${onInput("name")}
        style="width: 100%"
      >
        ${_nameError
          ? html`<sp-help-text slot="negative-help-text">${_nameError}</sp-help-text>`
          : ""}
      </sp-textfield>
    </label>

    ${renderLocationFields({
      onSlugInput: onInput("directory"),
      rerender: renderModal,
      slug: _form.directory,
    })}
  `;

  const paramsBodyTpl = () => html`
    <div class="new-project-step-context">${sourceLabel()}</div>
    <div class="new-project-step-heading">New Project Parameters</div>
    ${nameDirFieldsTpl()}
    ${_tab === "import"
      ? renderImportStatus()
      : html`
          <label class="new-project-field">
            <span class="new-project-label">Description</span>
            <sp-textfield
              placeholder="A short description of the site"
              .value=${_form.description}
              @input=${onInput("description")}
              style="width: 100%"
            ></sp-textfield>
          </label>

          <label class="new-project-field">
            <span class="new-project-label">Production URL</span>
            <sp-textfield
              placeholder="https://example.com"
              .value=${_form.url}
              @input=${onInput("url")}
              style="width: 100%"
            ></sp-textfield>
          </label>

          <label class="new-project-field">
            <span class="new-project-label">Deployment Adapter</span>
            <sp-picker label="Adapter" .value=${_form.adapter} @change=${onAdapterChange}>
              <sp-menu-item value="static">Static</sp-menu-item>
              <sp-menu-item value="cloudflare-pages">Cloudflare Pages</sp-menu-item>
              <sp-menu-item value="node">Node</sp-menu-item>
              <sp-menu-item value="bun">Bun</sp-menu-item>
            </sp-picker>
          </label>

          ${renderDesignFields({ rerender: renderModal })}
        `}
  `;

  // ─── Footer ────────────────────────────────────────────────────────────────

  const footerTpl = () => {
    if (isImportRunning()) {
      return html`
        <sp-button variant="secondary" @click=${() => cancelImport(importCtx)}>
          Cancel Import
        </sp-button>
      `;
    }
    if (_step === "source") {
      const gated = (_tab === "import" || _tab === "agent") && !hasOpenAiKey();
      return html`
        <sp-button variant="secondary" @click=${closeNewProjectModal}>Cancel</sp-button>
        ${gated ? "" : html`<sp-button variant="accent" @click=${goNext}>Next</sp-button>`}
      `;
    }
    const primary =
      _tab === "import"
        ? html`
            <sp-button variant="accent" @click=${() => startImport(importCtx)}>
              ${importButtonLabel()}
            </sp-button>
          `
        : _tab === "agent"
          ? html`
              <sp-button variant="accent" ?disabled=${_creating} @click=${onAgentSubmit}>
                ${_creating ? "Creating…" : "Create & Start Agent"}
              </sp-button>
            `
          : html`
              <sp-button variant="accent" ?disabled=${_creating} @click=${onSubmit}>
                ${_creating ? "Creating…" : "Create Project"}
              </sp-button>
            `;
    return html`
      <sp-button variant="secondary" ?disabled=${_creating} @click=${goBack}>Back</sp-button>
      ${primary}
    `;
  };

  const bodyTpl = () => {
    if (isImportRunning()) {
      return renderImportProgress();
    }
    return _step === "source" ? sourceBodyTpl() : paramsBodyTpl();
  };

  const tpl = html`
    <sp-underlay open @close=${closeNewProjectModal}></sp-underlay>
    <div
      class="new-project-modal"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          closeNewProjectModal();
        }
      }}
    >
      <div class="new-project-modal-header">
        <h2 class="new-project-modal-title">Start new project from:</h2>
        <sp-action-button quiet size="s" @click=${closeNewProjectModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      ${_step === "source" && !isImportRunning()
        ? html`
            <div class="new-project-tabs">
              <sp-tabs selected=${_tab} quiet @change=${onTabChange}>
                <sp-tab value="template" label="Template"></sp-tab>
                <sp-tab value="starter" label="Starter Site"></sp-tab>
                ${platform.importSite ? html`<sp-tab value="import" label="Import"></sp-tab>` : ""}
                <sp-tab value="agent" label="Agent"></sp-tab>
              </sp-tabs>
            </div>
          `
        : ""}
      <div class="new-project-modal-body">${bodyTpl()}</div>
      ${_tab !== "import" && _error
        ? html`<div class="new-project-error new-project-error--global">
            ${_error}
            ${_errorInstallUrl
              ? html`<a href=${_errorInstallUrl} target="_blank" rel="noreferrer">
                  Install the Jx Suite GitHub App →
                </a>`
              : ""}
          </div>`
        : ""}
      <div class="new-project-modal-footer">${footerTpl()}</div>
    </div>
  `;

  if (!_handle) {
    _handle = openModal(tpl);
  } else {
    _handle.update(tpl);
  }
}

let _dirDerived = true;
