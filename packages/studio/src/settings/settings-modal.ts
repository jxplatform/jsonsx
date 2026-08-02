/// <reference lib="dom" />
/**
 * Settings modal — site-wide project settings (CSS variables, data shapes, content types, head,
 * general). Modeled after VS Code / Obsidian settings panels: left sidebar nav + right content
 * area. Sections come from a registry: built-ins register at module init, and extensions add
 * descriptor-contributed sections through `registerSettingsSection`.
 */

import { html } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";
import { renderDefsEditor } from "./defs-editor";
import { renderCssVarsEditor } from "./css-vars-editor";
import { renderHeadEditor } from "./head-editor";
import { renderGeneralSettings } from "./general-settings";
import { renderDependenciesEditor } from "./dependencies-editor";
import { openModal } from "../ui/layers";
import { optionalStringArg, stringProperty } from "../commands/command-args";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

// ─── Section registry ─────────────────────────────────────────────────────────

/** A settings-modal section: nav entry plus a renderer for the content area. */
export interface SettingsSection {
  key: string;
  label: string;
  /** Nav icon name (reserved for future nav treatments). */
  icon?: string | undefined;
  /** Sort position — lower orders render higher in the nav. */
  order: number;
  render: (container: HTMLElement) => void;
}

const sectionRegistry = new Map<string, SettingsSection>();

/**
 * Register (or replace) a settings section. Extensions use this hook to contribute
 * descriptor-driven sections; built-ins register below at module init.
 *
 * @param {SettingsSection} section
 */
export function registerSettingsSection(section: SettingsSection): void {
  sectionRegistry.set(section.key, section);
}

/**
 * Remove a registered section — used when a descriptor-contributed section's extension is disabled
 * (see ./extension-sections). Built-ins are never unregistered.
 *
 * @param {string} key
 */
export function unregisterSettingsSection(key: string): void {
  sectionRegistry.delete(key);
  if (_activeSection === key) {
    _activeSection = "general";
  }
}

/** Registered sections sorted by order (registration order breaks ties). */
function sortedSections(): SettingsSection[] {
  return [...sectionRegistry.values()].toSorted((a, b) => a.order - b.order);
}

// Built-in sections — orders preserve the historical display order
registerSettingsSection({
  icon: "sp-icon-properties",
  key: "general",
  label: "General",
  order: 10,
  render: renderGeneralSettings,
});
registerSettingsSection({
  icon: "sp-icon-file-single-web-page",
  key: "head",
  label: "Head",
  order: 20,
  render: renderHeadEditor,
});
registerSettingsSection({
  icon: "sp-icon-brush",
  key: "cssVars",
  label: "CSS Variables",
  order: 30,
  render: renderCssVarsEditor,
});
registerSettingsSection({
  icon: "sp-icon-data",
  key: "definitions",
  label: "Data Shapes",
  order: 40,
  render: renderDefsEditor,
});
// Content Types is no longer a built-in: @jxsuite/parser contributes it (order 50) through its
// Content class descriptor's $studio.settings block, registered via ./extension-sections.
registerSettingsSection({
  icon: "sp-icon-box",
  key: "dependencies",
  label: "Dependencies",
  order: 60,
  render: renderDependenciesEditor,
});

// ─── Modal state ──────────────────────────────────────────────────────────────

let _handle: ReturnType<typeof openModal> | null = null;

let _activeSection = "general";

let _contentEl: HTMLElement | null = null;

/**
 * Resolves once the descriptor-contributed sections for the CURRENT open have registered.
 *
 * Exported through {@link settingsSectionsReady} so `settings.open` can validate its `section`
 * argument against the whole registry rather than only the built-ins: `connections`, `data` and
 * `content` are contributed by extensions and are simply absent for the first frame after opening.
 */
let _sectionsReady: Promise<void> = Promise.resolve();

/**
 * Open Project Settings, or retarget the already-open modal.
 *
 * Retargeting is the change: the predecessor returned early whenever `_handle` existed, so
 * `openSettings` was open-once-then-inert and the only way to change section was to press a nav
 * button. An idempotent setter has to mean the same thing on the second call.
 */
export function openSettingsModal(section?: string) {
  _activeSection = section ?? _activeSection;
  if (_handle) {
    renderModal();
    renderActiveSection();
    return;
  }
  _activeSection = section ?? "general";
  renderModal();
  // Refresh descriptor-contributed sections (cached payloads make this cheap) and rerender the
  // Nav once they land. Lazy import breaks the settings-modal ↔ extension-sections module cycle.
  _sectionsReady = import("./extension-sections")
    .then(async ({ syncExtensionSettingsSections }) => {
      await syncExtensionSettingsSections();
      if (_handle) {
        renderModal();
        renderActiveSection();
      }
    })
    .catch(() => {
      // Contributed sections are optional — the built-ins render regardless.
    });
  void _sectionsReady;
}

/** Await the contributed-section sync started by the last {@link openSettingsModal}. */
export function settingsSectionsReady(): Promise<void> {
  return _sectionsReady;
}

/** Every registered section key, built-ins and contributions alike. */
export function settingsSectionKeys(): string[] {
  return sortedSections().map((s) => s.key);
}

/** Which section the modal is showing. `null` when it is closed. */
export function activeSettingsSection(): string | null {
  return _handle ? _activeSection : null;
}

export function closeSettingsModal() {
  if (!_handle) {
    return;
  }
  _handle.close();
  _handle = null;
  _contentEl = null;
}

function renderModal() {
  const onNavClick = (key: string) => {
    _activeSection = key;
    renderModal();
    renderActiveSection();
  };

  const tpl = html`
    <sp-underlay open @close=${closeSettingsModal}></sp-underlay>
    <div class="settings-modal" data-jx-region="overlay.dialog:settings">
      <div class="settings-modal-header">
        <h2 class="settings-modal-title">Settings</h2>
        <sp-action-button quiet size="s" @click=${closeSettingsModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div class="settings-modal-body">
        <nav class="settings-modal-nav">
          ${sortedSections().map(
            (s) => html`
              <button
                class=${classMap({
                  active: _activeSection === s.key,
                  "settings-nav-item": true,
                })}
                @click=${() => onNavClick(s.key)}
              >
                ${s.label}
              </button>
            `,
          )}
        </nav>
        <div
          class="settings-modal-content"
          ${ref((el: Element | undefined) => {
            _contentEl = (el as HTMLElement) || null;
            if (_contentEl) {
              requestAnimationFrame(() => renderActiveSection());
            }
          })}
        ></div>
      </div>
    </div>
  `;

  if (!_handle) {
    _handle = openModal(tpl, { label: "Settings", onDismiss: closeSettingsModal });
  } else {
    _handle.update(tpl);
  }
}

function renderActiveSection() {
  if (!_handle || !_contentEl) {
    return;
  }
  sectionRegistry.get(_activeSection)?.render(_contentEl);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Open Project Settings — optionally on a named section.
 *
 * **This one record replaces three manifest verbs**: `openSettings`, `openSettings {section}` and
 * `settings.setSection`. The third was refused outright by plan §13.3 because its press-shim
 * mirrored the section registry's LABELS in a hand-kept map, so a section could be renamed in the
 * app and the shot would keep pressing a button that no longer existed. Sections have KEYS; this
 * names the key.
 *
 * The validation is deliberately asynchronous. Extension-contributed sections (`connections`,
 * `data`, `content`) register a tick after the modal opens, so refusing synchronously would reject
 * three legitimate section ids; the command opens, awaits the sync it already kicked off, and only
 * then decides whether the caller named something real. A wrong key therefore fails the step
 * instead of rendering an empty content pane — which is exactly what `css-variables` (the key is
 * `cssVars`) has been doing.
 *
 * @returns {AnyCommand[]}
 */
export function settingsCommands(): AnyCommand[] {
  return [
    {
      args: {
        additionalProperties: false,
        properties: {
          section: stringProperty(
            "The settings section key to show. Defaults to General on a fresh open.",
          ),
        },
        required: [],
        type: "object",
      },
      category: "Project",
      id: "settings.open",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "7_settings",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description:
          "Open the project's Settings, optionally on a named section (general, head, cssVars, " +
          "definitions, dependencies, or a section an extension contributes).",
        name: "open_settings",
      },
      run: async (_commandCtx, args) => {
        const section = optionalStringArg("settings.open", args, "section");
        openSettingsModal(section);
        if (section === undefined) {
          return;
        }
        await settingsSectionsReady();
        const keys = settingsSectionKeys();
        if (!keys.includes(section)) {
          throw new RangeError(
            `command "settings.open" argument "section": "${section}" is not a registered ` +
              `settings section — registered: ${keys.join(", ")}`,
          );
        }
      },
      title: "Open Settings",
    },
  ];
}

/**
 * Register the settings verb.
 *
 * @param {CommandRegistry} registry
 */
export function registerSettingsCommands(registry: CommandRegistry): void {
  registry.registerAll(settingsCommands());
}
