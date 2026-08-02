/// <reference lib="dom" />
/** Activity bar — tab icons for switching left panel views. */

import { html, render as litRender, nothing } from "lit-html";
import { activityBar } from "../store";
import { effect, effectScope } from "../reactivity";
import { shell, toggleActivityTab } from "../shell";
import { openSettingsModal } from "../settings/settings-modal";
import { openAboutModal } from "../about/about-modal";
import { refreshGitStatus } from "./git-panel";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

let _scope: EffectScope | null = null;

export function mount() {
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      // Source control is PROJECT state, so the badge is fetched and drawn without reference to
      // Any tab. Sourcing it from `activeTab` is what made it vanish when the last tab closed.
      // The badge needs a status once. A refresh that already failed must not re-arm this: the
      // Effect re-runs on the very state the failure writes, so retrying here spins.
      const { error, loading, status } = shell.git;
      if (!status && !loading && !error) {
        void refreshGitStatus();
      }
      renderActivityBar();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
}

const gitBranchIcon = (s: string) => html`
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
 * @param {string} tag
 * @param {string} [size]
 */
export function tabIcon(tag: string, size?: string) {
  const m: Record<string, (s: string) => TemplateResult> = {
    "sp-icon-artboard": (s: string) =>
      html`<sp-icon-artboard slot="icon" size=${s}></sp-icon-artboard>`,
    "sp-icon-box": (s: string) => html`<sp-icon-box slot="icon" size=${s}></sp-icon-box>`,
    "sp-icon-brackets": (s: string) =>
      html`<sp-icon-brackets slot="icon" size=${s}></sp-icon-brackets>`,
    "sp-icon-brush": (s: string) => html`<sp-icon-brush slot="icon" size=${s}></sp-icon-brush>`,
    "sp-icon-chat": (s: string) => html`<sp-icon-chat slot="icon" size=${s}></sp-icon-chat>`,
    "sp-icon-data": (s: string) => html`<sp-icon-data slot="icon" size=${s}></sp-icon-data>`,
    "sp-icon-event": (s: string) => html`<sp-icon-event slot="icon" size=${s}></sp-icon-event>`,
    "sp-icon-file-single-web-page": (s: string) =>
      html`<sp-icon-file-single-web-page slot="icon" size=${s}></sp-icon-file-single-web-page>`,
    "sp-icon-folder": (s: string) => html`<sp-icon-folder slot="icon" size=${s}></sp-icon-folder>`,
    "sp-icon-git-branch": gitBranchIcon,
    "sp-icon-layers": (s: string) => html`<sp-icon-layers slot="icon" size=${s}></sp-icon-layers>`,
    "sp-icon-properties": (s: string) =>
      html`<sp-icon-properties slot="icon" size=${s}></sp-icon-properties>`,
    "sp-icon-view-all-tags": (s: string) =>
      html`<sp-icon-view-all-tags slot="icon" size=${s}></sp-icon-view-all-tags>`,
    "sp-icon-view-grid": (s: string) =>
      html`<sp-icon-view-grid slot="icon" size=${s}></sp-icon-view-grid>`,
  };
  const fn = m[tag];
  return fn ? fn(size || "s") : nothing;
}

export function renderActivityBar() {
  const { leftTab } = shell;
  const gitFileCount = shell.git.status?.files?.length || 0;
  const tabs = [
    { icon: "sp-icon-folder", label: "Files", value: "files" },
    { icon: "sp-icon-layers", label: "Layers", value: "layers" },
    { icon: "sp-icon-box", label: "Imports", value: "imports" },
    { icon: "sp-icon-view-grid", label: "Elements", value: "blocks" },
    { icon: "sp-icon-brackets", label: "State", value: "state" },
    { icon: "sp-icon-data", label: "Data", value: "data" },
    { icon: "sp-icon-view-all-tags", label: "Document", value: "head" },
    { icon: "sp-icon-git-branch", label: "Source Control", value: "git" },
  ];
  const tpl = html`
    <sp-tabs
      selected=${shell.docks.left.collapsed ? "" : leftTab}
      direction="vertical"
      quiet
      @change=${(e: Event) => {
        // No repaint call: the rail and the left panel both track `shell` through the effects
        // They already run, so selecting a tab is one state write.
        toggleActivityTab((e.target as HTMLElement & { selected: string }).selected);
      }}
    >
      ${tabs.map(
        // `title` alone, deliberately: sp-tab renders its icon into an unnamed slot and keeps its
        // Text label hidden, so the title attribute IS the accessible name as well as the tooltip.
        // Adding aria-label with the same string just made every rail tab announce itself twice.
        (t) => html`
          <sp-tab value=${t.value} title=${t.label}>
            ${tabIcon(t.icon, "m")}
            ${
              t.value === "git" && gitFileCount > 0
                ? html`<span class="activity-badge">${gitFileCount}</span>`
                : nothing
            }
          </sp-tab>
        `,
      )}
    </sp-tabs>
    <div
      style="margin-top:auto;padding:8px 0;display:flex;flex-direction:column;align-items:center;gap:4px"
    >
      <sp-action-button
        quiet
        size="m"
        title="About"
        aria-label="About"
        @click=${() => openAboutModal()}
      >
        <sp-icon-info slot="icon"></sp-icon-info>
      </sp-action-button>
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
  litRender(tpl, activityBar);
}
