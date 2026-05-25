/** Activity bar — tab icons for switching left panel views. */

import { html, render as litRender, nothing } from "lit-html";
import { activityBar, renderOnly } from "../store.js";
import { effect, effectScope } from "../reactivity.js";
import { activeTab } from "../workspace/workspace.js";
import { view, applyPanelCollapse } from "../view.js";
import { openSettingsModal } from "../settings/settings-modal.js";
import { refreshGitStatus } from "./git-panel.js";

/** @type {import("@vue/reactivity").EffectScope | null} */
let _scope = null;

export function mount() {
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (!tab) return;
      const gs = tab.session.ui.gitStatus;
      if (!gs && !tab.session.ui.gitLoading) {
        refreshGitStatus();
      }
      renderActivityBar();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
}

const gitBranchIcon = (/** @type {any} */ s) => html`
  <svg
    slot="icon"
    xmlns="http://www.w3.org/2000/svg"
    width=${s === "m" ? 20 : 16}
    height=${s === "m" ? 20 : 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <line x1="6" y1="3" x2="6" y2="15"></line>
    <circle cx="18" cy="6" r="3"></circle>
    <circle cx="6" cy="18" r="3"></circle>
    <path d="M18 9a9 9 0 0 1-9 9"></path>
  </svg>
`;

/**
 * @param {any} tag
 * @param {any} size
 */
export function tabIcon(tag, size) {
  /** @type {Record<string, any>} */
  const m = {
    "sp-icon-folder": (/** @type {any} */ s) =>
      html`<sp-icon-folder slot="icon" size=${s}></sp-icon-folder>`,
    "sp-icon-layers": (/** @type {any} */ s) =>
      html`<sp-icon-layers slot="icon" size=${s}></sp-icon-layers>`,
    "sp-icon-view-grid": (/** @type {any} */ s) =>
      html`<sp-icon-view-grid slot="icon" size=${s}></sp-icon-view-grid>`,
    "sp-icon-brackets": (/** @type {any} */ s) =>
      html`<sp-icon-brackets slot="icon" size=${s}></sp-icon-brackets>`,
    "sp-icon-data": (/** @type {any} */ s) =>
      html`<sp-icon-data slot="icon" size=${s}></sp-icon-data>`,
    "sp-icon-properties": (/** @type {any} */ s) =>
      html`<sp-icon-properties slot="icon" size=${s}></sp-icon-properties>`,
    "sp-icon-event": (/** @type {any} */ s) =>
      html`<sp-icon-event slot="icon" size=${s}></sp-icon-event>`,
    "sp-icon-brush": (/** @type {any} */ s) =>
      html`<sp-icon-brush slot="icon" size=${s}></sp-icon-brush>`,
    "sp-icon-file-single-web-page": (/** @type {any} */ s) =>
      html`<sp-icon-file-single-web-page slot="icon" size=${s}></sp-icon-file-single-web-page>`,
    "sp-icon-view-all-tags": (/** @type {any} */ s) =>
      html`<sp-icon-view-all-tags slot="icon" size=${s}></sp-icon-view-all-tags>`,
    "sp-icon-artboard": (/** @type {any} */ s) =>
      html`<sp-icon-artboard slot="icon" size=${s}></sp-icon-artboard>`,
    "sp-icon-box": (/** @type {any} */ s) =>
      html`<sp-icon-box slot="icon" size=${s}></sp-icon-box>`,
    "sp-icon-git-branch": gitBranchIcon,
  };
  const fn = m[tag];
  return fn ? fn(size || "s") : nothing;
}

export function renderActivityBar() {
  const tab = activeTab.value;
  if (!tab) return;
  const leftTab = view.leftTab;
  const gitFileCount = /** @type {any} */ (tab?.session.ui.gitStatus)?.files?.length || 0;
  const tabs = [
    { value: "files", icon: "sp-icon-folder", label: "Files" },
    { value: "layers", icon: "sp-icon-layers", label: "Layers" },
    { value: "imports", icon: "sp-icon-box", label: "Imports" },
    { value: "blocks", icon: "sp-icon-view-grid", label: "Elements" },
    { value: "state", icon: "sp-icon-brackets", label: "State" },
    { value: "data", icon: "sp-icon-data", label: "Data" },
    { value: "head", icon: "sp-icon-view-all-tags", label: "Document" },
    { value: "git", icon: "sp-icon-git-branch", label: "Source Control" },
  ];
  const tpl = html`
    <sp-tabs
      selected=${view.leftPanelCollapsed ? "" : leftTab}
      direction="vertical"
      quiet
      @change=${(/** @type {any} */ e) => {
        const clicked = e.target.selected;
        if (clicked === view.leftTab && !view.leftPanelCollapsed) {
          view.leftPanelCollapsed = true;
          applyPanelCollapse();
          renderActivityBar();
        } else {
          view.leftTab = clicked;
          view.leftPanelCollapsed = false;
          applyPanelCollapse();
          renderOnly("leftPanel");
          renderActivityBar();
        }
      }}
    >
      ${tabs.map(
        (t) => html`
          <sp-tab value=${t.value} title=${t.label} aria-label=${t.label}>
            ${tabIcon(t.icon, "m")}
            ${t.value === "git" && gitFileCount > 0
              ? html`<span class="activity-badge">${gitFileCount}</span>`
              : nothing}
          </sp-tab>
        `,
      )}
    </sp-tabs>
    <div style="margin-top:auto;padding:8px 0;display:flex;justify-content:center">
      <sp-action-button
        quiet
        size="m"
        title="Settings"
        aria-label="Settings"
        @click=${() => openSettingsModal()}
      >
        <sp-icon-settings slot="icon"></sp-icon-settings>
      </sp-action-button>
    </div>
  `;
  litRender(tpl, /** @type {any} */ (activityBar));
}
