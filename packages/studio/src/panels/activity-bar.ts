/// <reference lib="dom" />
/**
 * Activity bar — the rail, rendered FROM the panel registry.
 *
 * There is no list of panels in this file. `railGroups()` returns every rail-able record grouped by
 * level and filtered by its own `when`, and the rail draws whatever that says: two groups with a
 * divider between them, PROJECT above and DOCUMENT below (plan §3.2 ②). Adding a panel is a
 * `registerPanel()` call in the module that owns it, and it appears here; there is nothing to
 * update in step.
 *
 * **A rail button is not the same thing as a Navigator panel.** The grouping is by LEVEL, and the
 * dock a record names is where its body is drawn — Problems is `dock: "bottom"` (plan §7.2), so its
 * button reveals the Bottom dock's first tab while sitting in the rail's PROJECT group with its
 * badge. {@link toggleRailPanel} is the one place that branch is written down.
 *
 * The predecessor was an eight-item array literal — `{icon, label, value}` — whose `label` reached
 * the screen only as a `title` attribute. Thirteen icons in this shell had no name but a hover
 * tooltip, which is the accessibility failure §2 principle 6 names outright: **every rail button
 * now carries an 11px text label under its icon**, and the rail is 56px wide to hold it.
 */

import { html, render as litRender, nothing } from "lit-html";
import { activityBar } from "../store";
import { effect, effectScope } from "../reactivity";
import { shell, toggleActivityTab, toggleBottomTab } from "../shell";
import { refreshGitStatus } from "./git-panel";
import { panelContext, railGroups } from "./panel-registry";
import { registerNavigatorPanels } from "./navigator-panels";
import type { PanelRecord } from "./panel-registry";
import type { CommandContext } from "../commands/context";
import type { EffectScope } from "@vue/reactivity";
import { activeRegistry } from "../commands/active-registry";
import type { TemplateResult } from "lit-html";

let _scope: EffectScope | null = null;

export function mount() {
  // The rail is a rendering of the registry, so the registry has to exist before the first paint.
  // Idempotent, and the Navigator dock calls it too — whichever mounts first wins.
  registerNavigatorPanels();
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

/**
 * Whether a rail button is showing what it names — its dock open, on its tab.
 *
 * The rail spans two docks (plan §7.2 puts Problems in the Bottom dock and its badge on the rail),
 * so "selected" is a question about the panel's OWN host, not about `shell.leftTab`. Reading only
 * the Navigator here is what would draw Problems as unselected while it is on screen.
 *
 * @param {PanelRecord} panel
 */
export function isRailPanelShowing(panel: PanelRecord): boolean {
  if (panel.dock === "bottom") {
    return !shell.docks.bottom.collapsed && shell.bottomTab === panel.id;
  }
  return !shell.docks.left.collapsed && shell.leftTab === panel.id;
}

/**
 * Reveal (or collapse) what a rail button names, in whichever dock draws it.
 *
 * The branch is HERE and not on the record: a panel record says where its body is drawn, and which
 * shell setter that implies is the rail's business. Both branches keep the same toggle-to-collapse
 * gesture — re-picking the panel that is already showing closes its dock — so ⌘4's button behaves
 * like ⌘1's even though one writes `shell.bottomTab` and the other `shell.leftTab`.
 *
 * @param {PanelRecord} panel
 */
export function toggleRailPanel(panel: PanelRecord): void {
  if (panel.dock === "bottom") {
    toggleBottomTab(panel.id);
    return;
  }
  toggleActivityTab(panel.id);
}

/**
 * One rail button.
 *
 * The label is REAL TEXT, not a `title` attribute — so it is the accessible name, it is readable
 * without a pointer, and it survives a screenshot. `aria-pressed` states the toggle-focus semantics
 * honestly: re-picking the open panel collapses its dock (see {@link toggleRailPanel}), which is a
 * two-state control, not a one-way selection.
 *
 * `title` survives as a TOOLTIP only. Because the button has text content, that text is its
 * accessible name and the attribute adds no second announcement (the reason the old `sp-tab` could
 * not carry both) — it exists to restore the full string for "Source Control", which 56px ellipses.
 * An icon whose only name is a tooltip is what principle 6 bans; a tooltip beside a label is not.
 */
function railButton(panel: PanelRecord, ctx: CommandContext): TemplateResult {
  const badge = panel.badge?.(ctx) ?? null;
  const selected = isRailPanelShowing(panel);
  return html`
    <button
      type="button"
      class="rail-item${selected ? " selected" : ""}"
      data-panel=${panel.id}
      aria-pressed=${selected}
      title=${panel.title}
      @click=${() => {
        // No repaint call: the rail, the Navigator and the Bottom dock all track `shell`, so
        // Selecting a panel is one state write.
        toggleRailPanel(panel);
      }}
    >
      <span class="rail-icon">${tabIcon(panel.icon, "m")}</span>
      <span class="rail-label">${panel.title}</span>
      ${badge ? html`<span class="activity-badge">${badge}</span>` : nothing}
    </button>
  `;
}

/**
 * The rail foot: **Preferences**, and only Preferences (plan §3.2 ②).
 *
 * It was two hand-authored buttons calling two module functions directly — the exact shape §2
 * principle 1 bans, and the reason the gear opened PROJECT configuration from an application-level
 * slot. Preferences is the application's own settings and follows the author between projects, so
 * it is the one that earns the pinned position; project configuration is `settings.open`, which
 * lives in the ⬢ menu and the palette because it is scoped to a project; and About is `help.about`,
 * reachable by name.
 *
 * Rendered FROM the record, so the label and the chord in its tooltip cannot drift from ⌘,.
 */
function railFooterTpl(): TemplateResult {
  const registry = activeRegistry();
  const command = registry?.get("app.preferences");
  if (!registry || !command || !registry.isVisible("app.preferences")) {
    return html`${nothing}`;
  }
  const chord = registry.keymap.formatBinding("app.preferences");
  return html`
    <button
      type="button"
      class="rail-item"
      data-command="app.preferences"
      title=${chord ? `${command.title} (${chord})` : command.title}
      @click=${() => {
        void registry.run("app.preferences");
      }}
    >
      <span class="rail-icon"><sp-icon-settings size="m"></sp-icon-settings></span>
      <span class="rail-label">Preferences</span>
    </button>
  `;
}

export function renderActivityBar() {
  const ctx = panelContext();
  const groups = railGroups(ctx);
  const tpl = html`
    <nav class="rail-groups" aria-label="Navigator panels">
      ${groups.map(
        (group, index) => html`
          ${index === 0 ? nothing : html`<div class="rail-divider" role="separator"></div>`}
          <div class="rail-group" role="group" aria-label=${group.label}>
            ${group.panels.map((panel) => railButton(panel, ctx))}
          </div>
        `,
      )}
    </nav>
    <div class="rail-footer">${railFooterTpl()}</div>
  `;
  litRender(tpl, activityBar);
}
