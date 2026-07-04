/// <reference lib="dom" />
/**
 * New Project modal — guides the user through creating a new Jx project. Fields mirror the CLI
 * scaffolder: name, description, url, adapter.
 */

import { html } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { openModal } from "../ui/layers";
import { getPlatform } from "../platform";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type { StarterInfo } from "../types";

let _handle: ReturnType<typeof openModal> | null = null;

/**
 * @type {{
 *   name: string;
 *   description: string;
 *   url: string;
 *   adapter: string;
 *   directory: string;
 *   starter: string;
 * }}
 */
let _form = {
  adapter: "static",
  description: "",
  directory: "",
  name: "",
  starter: "blank",
  url: "",
};

let _error = "";

let _creating = false;

/** Starter templates offered in the picker (empty until loaded / on platforms without starters). */
let _starters: StarterInfo[] = [];

/** @type {((result: { root: string; config: object } | null) => void) | null} */
let _resolve: ((result: { root: string; config: ProjectConfig } | null) => void) | null = null;

/**
 * Open the New Project modal. Returns a promise that resolves with the created project info (or
 * null if cancelled).
 *
 * @returns {Promise<{ root: string; config: object } | null>}
 */
export function openNewProjectModal(): Promise<{
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
    starter: "blank",
    url: "",
  };
  _error = "";
  _creating = false;
  _starters = [];

  // Load starter templates in the background; re-render when they arrive. Platforms without
  // Starters simply leave the picker showing only "Blank".
  const platform = getPlatform();
  if (platform.listStarters) {
    void platform
      .listStarters()
      .then((starters) => {
        _starters = starters;
        if (_handle) {
          renderModal();
        }
      })
      .catch(() => {
        /* Non-fatal: the picker falls back to Blank-only. */
      });
  }

  return new Promise((resolve) => {
    _resolve = resolve;
    renderModal();
  });
}

export function closeNewProjectModal() {
  if (!_handle) {
    return;
  }
  _handle.close();
  _handle = null;
  if (_resolve) {
    _resolve(null);
    _resolve = null;
  }
}

function renderModal() {
  const onInput =
    (field: "name" | "description" | "url" | "adapter" | "directory") => (e: Event) => {
      _form[field] = (e.target as HTMLInputElement).value;
      if (field === "name" && !_form.directory) {
        // Auto-derive directory slug from name while user hasn't manually typed one
        _dirDerived = true;
      }
      if (_dirDerived && field === "name") {
        _form.directory = _form.name
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-")
          .replaceAll(/^-|-$/g, "");
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

  const selectStarter = (id: string) => {
    _form.starter = id;
    // Offer the starter's own tagline as a description default, without clobbering user input.
    const meta = _starters.find((s) => s.id === id);
    if (meta && !_form.description.trim()) {
      _form.description = meta.tagline;
    }
    renderModal();
  };

  const onSubmit = async () => {
    if (!_form.name.trim()) {
      _error = "Project name is required";
      renderModal();
      return;
    }
    if (!_form.directory.trim()) {
      _form.directory = _form.name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-|-$/g, "");
    }

    _creating = true;
    _error = "";
    renderModal();

    try {
      const platform = getPlatform();
      const result = await platform.createProject(_form);
      _creating = false;
      if (_handle) {
        _handle.close();
        _handle = null;
      }
      if (_resolve) {
        _resolve(result);
        _resolve = null;
      }
    } catch (error) {
      _creating = false;
      _error = errorMessage(error);
      renderModal();
    }
  };

  const tpl = html`
    <sp-underlay open @close=${closeNewProjectModal}></sp-underlay>
    <div
      class="new-project-modal ${_starters.length > 0 ? "new-project-modal-wide" : ""}"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          closeNewProjectModal();
        }
      }}
    >
      <div class="new-project-modal-header">
        <h2 class="new-project-modal-title">New Project</h2>
        <sp-action-button quiet size="s" @click=${closeNewProjectModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div class="new-project-modal-body">
        ${_starters.length > 0
          ? html`
              <div class="new-project-field">
                <span class="new-project-label">Template</span>
                <div class="new-project-templates">
                  <button
                    type="button"
                    class="new-project-template ${_form.starter === "blank" ? "selected" : ""}"
                    @click=${() => selectStarter("blank")}
                    title="Start from a blank project"
                  >
                    <div class="new-project-template-blank">+</div>
                    <div class="new-project-template-body">
                      <div class="new-project-template-name">Blank</div>
                      <div class="new-project-template-tag">Start from scratch</div>
                    </div>
                  </button>
                  ${_starters.map(
                    (s) => html`
                      <button
                        type="button"
                        class="new-project-template ${_form.starter === s.id ? "selected" : ""}"
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
              </div>
            `
          : ""}
        <label class="new-project-field">
          <span class="new-project-label">Project Name *</span>
          <sp-textfield
            placeholder="My Site"
            .value=${_form.name}
            @input=${onInput("name")}
            style="width: 100%"
          ></sp-textfield>
        </label>

        <label class="new-project-field">
          <span class="new-project-label">Directory</span>
          <sp-textfield
            placeholder="my-site"
            .value=${_form.directory}
            @input=${onInput("directory")}
            style="width: 100%"
          ></sp-textfield>
        </label>

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

        ${_error ? html`<div class="new-project-error">${_error}</div>` : ""}
      </div>
      <div class="new-project-modal-footer">
        <sp-button variant="secondary" @click=${closeNewProjectModal}>Cancel</sp-button>
        <sp-button variant="accent" ?disabled=${_creating} @click=${onSubmit}>
          ${_creating ? "Creating…" : "Create Project"}
        </sp-button>
      </div>
    </div>
  `;

  if (!_handle) {
    _handle = openModal(tpl);
  } else {
    _handle.update(tpl);
  }
}

let _dirDerived = true;
