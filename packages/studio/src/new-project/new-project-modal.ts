/// <reference lib="dom" />
/**
 * New Project modal — a two-step wizard.
 *
 * **Step 1 · Choose a starting point.** Starters lead: the first thing offered is a complete site
 * you can look at. The gallery ends with one **Start from scratch** card — the minimal scaffold —
 * because a first-run choice between four breakpoint presets described by media-query direction is
 * a choice nobody can make. Two further sources sit on their own tabs: an **Import** of an existing
 * site, and an **Agent** prompt.
 *
 * **Step 2 · Name your project.** Name and location, nothing else. A project's URL, deployment
 * adapter and design tokens are settings, not creation-time decisions, so they live in the
 * project's own settings surface where they can be changed more than once.
 *
 * Import and Agent need working AI, so both are gated until credentials exist — a key stored in
 * this browser, or a backend that holds its own (managed cloud platforms, env-keyed dev servers).
 * While gated they offer the same two paths as the assistant sidebar: connect Cloudflare for
 * Workers AI, or bring a key.
 *
 * @docs studio/projects/create
 */

import { html } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { openModal } from "../ui/layers";
import { getPlatform } from "../platform";
import { installUrlOf } from "../platform-errors";
import { hasAiCredentials } from "../services/ai-models";
import { setPendingAgentPrompt } from "../services/agent-seed";
import { initProjectRepo } from "../files/files";
import { createAiCredentialsForm } from "../ui/ai-credentials-form";
import { createManagedConnect } from "../ui/ai-managed-connect";
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

type NewProjectTab = "starter" | "import" | "agent";
type WizardStep = "source" | "params";

let _handle: ReturnType<typeof openModal> | null = null;

let _form = { directory: "", name: "" };

let _tab: NewProjectTab = "starter";
let _step: WizardStep = "source";
/** The step-1 choice on the Starters tab: a starter id, or `""` for "Start from scratch". */
let _starter = "";
/** Set once the user picks a card, so an arriving starter list stops overriding their choice. */
let _starterTouched = false;
let _agentPrompt = "";

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

/** Starter templates offered in the gallery (empty until loaded / on platforms without starters). */
let _starters: StarterInfo[] = [];

let _resolve: ((result: { root: string; config: ProjectConfig } | null) => void) | null = null;

// One credentials form shared by the Import and Agent gates; lazy so the modal module can load
// Before a platform is registered (the form fetches models through the platform on edit).
let _credsForm: ReturnType<typeof createAiCredentialsForm> | null = null;

function rerenderIfOpen() {
  if (_handle) {
    renderModal();
  }
}

function credsForm() {
  _credsForm ??= createAiCredentialsForm({
    onSaved: rerenderIfOpen,
    requestRender: rerenderIfOpen,
  });
  return _credsForm;
}

/**
 * The keyless "Connect Cloudflare" option shown beside the key form on managed platforms — the same
 * controller the assistant sidebar uses. Lazy for the same reason as the form above.
 */
let _managedConnect: ReturnType<typeof createManagedConnect> | null = null;

function managedConnect() {
  _managedConnect ??= createManagedConnect({ requestRender: rerenderIfOpen });
  return _managedConnect;
}

/**
 * The Import and Agent tabs need working AI, which a managed platform can supply without any local
 * key. Probe on every gated render so the Cloudflare option appears as soon as the backend
 * answers.
 */
function aiGateOpen(): boolean {
  if (hasAiCredentials()) {
    return true;
  }
  managedConnect().ensureProbe();
  return false;
}

/**
 * Open the New Project modal. Returns a promise that resolves with the created project info (or
 * null if cancelled).
 *
 * @param {{ tab?: NewProjectTab }} [options] Which source tab to open on; defaults to Starters.
 * @returns {Promise<{ root: string; config: object } | null>}
 */
export function openNewProjectModal(options?: { tab?: NewProjectTab }): Promise<{
  root: string;
  config: ProjectConfig;
} | null> {
  if (_handle) {
    return Promise.resolve(null);
  }
  _form = { directory: "", name: "" };
  _tab = options?.tab ?? "starter";
  _step = "source";
  _starter = "";
  _starterTouched = false;
  _agentPrompt = "";
  _error = "";
  _nameError = "";
  _errorInstallUrl = "";
  _creating = false;
  _starters = [];
  _dirDerived = true;
  resetImportTab();
  resetLocationFields();

  // Load the destination options (repo-mode owners) and starter templates in the background,
  // Re-rendering when they arrive. A platform without starters shows the scratch card alone.
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
        // Starters lead: the gallery opens with a real site selected, not an empty scaffold.
        if (!_starterTouched) {
          _starter = starters[0]?.id ?? "";
        }
        if (_handle) {
          renderModal();
        }
      })
      .catch(() => {
        /* Non-fatal: the gallery keeps the scratch card. */
      });
  }

  return new Promise((resolve) => {
    _resolve = resolve;
    renderModal();
  });
}

/**
 * Dismiss the wizard. Available from every step, and from the underlay and Escape — a running
 * import is aborted on the way out rather than trapping the user behind it.
 */
export function closeNewProjectModal() {
  if (!_handle || _creating) {
    return;
  }
  if (isImportRunning()) {
    cancelImport(importCtxFor(renderModal));
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

/**
 * Every path out of the wizard that produced a project: initialise version control for it, then
 * hand it to the caller. A scaffold is not a repository, and Delete and Rename are one click away.
 */
async function finishCreated(result: { root: string; config: ProjectConfig }) {
  await initProjectRepo(result.root);
  finish(result);
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

/** The human label of the chosen source, shown as context on the Name step. */
function sourceLabel(): string {
  switch (_tab) {
    case "import": {
      return "Import";
    }
    case "agent": {
      return "Agent";
    }
    default: {
      return _starter
        ? `Starter site · ${_starters.find((s) => s.id === _starter)?.name ?? _starter}`
        : "Start from scratch";
    }
  }
}

/** The import tab's context object — rebuilt per render so it closes over current state. */
function importCtxFor(rerender: () => void): ImportTabCtx {
  return {
    aiGateOpen,
    credsForm: credsForm(),
    form: _form,
    managedConnect: managedConnect(),
    onDone: (result) => void finishCreated(result),
    rerender,
    resolveDestination: () => validateParams(),
  };
}

/**
 * Validate the Name step, returning the destination to create at (null when something is missing —
 * the reason is already rendered inline and the modal re-drawn). The slug is derived from the name
 * when left blank, but the destination itself is never guessed.
 */
function validateParams(): CreateProjectDestination | null {
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
}

function renderModal() {
  const platform = getPlatform();
  const importCtx = importCtxFor(renderModal);

  const onInput = (field: "name" | "directory") => (e: Event) => {
    _form[field] = (e.target as HTMLInputElement).value;
    if (field === "name") {
      _nameError = "";
      // Auto-derive the directory slug from the name while the user hasn't typed one.
      if (!_form.directory) {
        _dirDerived = true;
      }
      if (_dirDerived) {
        _form.directory = deriveSlug(_form.name);
      }
    } else {
      _dirDerived = false;
    }
    renderModal();
  };

  const selectStarter = (id: string) => {
    _starter = id;
    _starterTouched = true;
    _error = "";
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
    if (_tab === "import" && !validateImportSource(importCtx)) {
      return;
    }
    if (_tab === "agent" && !_agentPrompt.trim()) {
      _error = "Describe the site you want the agent to build";
      renderModal();
      return;
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

  /** Create the project from the chosen source, then run `after` with the result. */
  const create = async (
    source: { starter: string } | { template: string },
    after: (result: { root: string; config: ProjectConfig }) => void | Promise<void>,
  ) => {
    const destination = validateParams();
    if (!destination) {
      return;
    }

    _creating = true;
    _error = "";
    _nameError = "";
    renderModal();

    try {
      const result = await getPlatform().createProject({ ..._form, destination, ...source });
      await after(result);
    } catch (error) {
      _creating = false;
      captureError(error);
      renderModal();
    }
  };

  const onSubmit = () =>
    create(_starter ? { starter: _starter } : { template: "blank" }, finishCreated);

  const onAgentSubmit = () =>
    create({ template: "blank" }, async (result) => {
      // The window that opens the project consumes this and hands the prompt to the assistant.
      setPendingAgentPrompt(result.root, _agentPrompt.trim());
      await finishCreated(result);
    });

  // ─── Step 1: source selection ──────────────────────────────────────────────

  const starterSourceTpl = () => html`
    <div class="new-project-tab-intro">
      Every starter is a complete site copied in as plain files you own — open it, look at it, then
      make it yours.
    </div>
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
      <button
        type="button"
        class="new-project-template new-project-scratch ${_starter === "" ? "selected" : ""}"
        @click=${() => selectStarter("")}
      >
        <div class="new-project-template-blank">+</div>
        <div class="new-project-template-body">
          <div class="new-project-template-name">Start from scratch</div>
          <div class="new-project-template-tag">An empty site with one page</div>
        </div>
      </button>
    </div>
  `;

  const agentSourceTpl = () => {
    if (!aiGateOpen()) {
      return html`
        <div class="new-project-tab-intro">
          The agent uses your AI provider to build the site.
          ${
            managedConnect().canOffer()
              ? "Connect Cloudflare, or add an OpenAI-compatible API key, to continue."
              : "Add an OpenAI-compatible API key to continue."
          }
        </div>
        <div class="new-project-creds">${managedConnect().render()} ${credsForm().render()}</div>
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
      case "import": {
        return renderImportSource(importCtx);
      }
      case "agent": {
        return agentSourceTpl();
      }
      default: {
        return starterSourceTpl();
      }
    }
  };

  // ─── Step 2: name + location ───────────────────────────────────────────────

  const paramsBodyTpl = () => html`
    <div class="new-project-step-context">${sourceLabel()}</div>
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
        ${
          _nameError
            ? html`<sp-help-text slot="negative-help-text">${_nameError}</sp-help-text>`
            : ""
        }
      </sp-textfield>
    </label>

    ${renderLocationFields({
      onSlugInput: onInput("directory"),
      rerender: renderModal,
      slug: _form.directory,
    })}
    ${
      _tab === "import"
        ? renderImportStatus()
        : html`
            <div class="new-project-tab-intro">
              The site's address, deployment target and design tokens are project settings — set
              them from Settings once the project is open.
            </div>
          `
    }
  `;

  // ─── Footer ────────────────────────────────────────────────────────────────

  const footerTpl = () => {
    const cancel = html`
      <sp-button variant="secondary" ?disabled=${_creating} @click=${closeNewProjectModal}>
        Cancel
      </sp-button>
    `;
    if (isImportRunning()) {
      // One cancel, not two: the run's own Cancel is the step's Cancel, and dismissing the modal
      // (Escape, the underlay, the header ✕) aborts the run on the way out.
      return html`
        <sp-button variant="secondary" @click=${() => cancelImport(importCtx)}>
          Cancel Import
        </sp-button>
      `;
    }
    if (_step === "source") {
      const gated = (_tab === "import" || _tab === "agent") && !aiGateOpen();
      return html`
        ${cancel}
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
      ${cancel}
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
    <div class="new-project-modal">
      <div class="new-project-modal-header">
        <h2 class="new-project-modal-title">
          ${_step === "source" ? "Choose a starting point" : "Name your project"}
        </h2>
        <sp-action-button quiet size="s" @click=${closeNewProjectModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      ${
        _step === "source" && !isImportRunning()
          ? html`
              <div class="new-project-tabs">
                <sp-tabs selected=${_tab} quiet @change=${onTabChange}>
                  <sp-tab value="starter" label="Starters"></sp-tab>
                  ${platform.importSite ? html`<sp-tab value="import" label="Import"></sp-tab>` : ""}
                  <sp-tab value="agent" label="Agent"></sp-tab>
                </sp-tabs>
              </div>
            `
          : ""
      }
      <div class="new-project-modal-body">${bodyTpl()}</div>
      ${
        _tab !== "import" && _error
          ? html`<div class="new-project-error new-project-error--global">
              ${_error}
              ${
                _errorInstallUrl
                  ? html`<a href=${_errorInstallUrl} target="_blank" rel="noreferrer">
                      Install the Jx Suite GitHub App →
                    </a>`
                  : ""
              }
            </div>`
          : ""
      }
      <div class="new-project-modal-footer">${footerTpl()}</div>
    </div>
  `;

  if (!_handle) {
    _handle = openModal(tpl, { label: "New Project", onDismiss: closeNewProjectModal });
  } else {
    _handle.update(tpl);
  }
}

let _dirDerived = true;
