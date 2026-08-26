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
 * **Every rail button opens the Navigator, and the grouping is by LEVEL.** It briefly spanned two
 * docks so Problems could keep a button while its body was drawn at the bottom; that cost a
 * per-dock branch here, in {@link isRailPanelShowing} and in `focusPanel`, and it pointed left at
 * something that opens below. Problems is `rail: false` now.
 *
 * The predecessor was an eight-item array literal — `{icon, label, value}` — whose `label` reached
 * the screen only as a `title` attribute. Thirteen icons in this shell had no name but a hover
 * tooltip, which is the accessibility failure §2 principle 6 names outright: **every rail button
 * now carries an 11px text label under its icon**, and the rail is 56px wide to hold it.
 */

import { html, render as litRender, nothing } from "lit-html";
import { activityBar } from "../store";
import { effect, effectScope } from "../reactivity";
import { requireNavigatorPanelId, shell, toggleActivityTab } from "../shell";
import { refreshGitStatus } from "./git-panel";
import { panelContext, railGroups } from "./panel-registry";
import { registerNavigatorPanels } from "./navigator-panels";
import type { PanelRecord } from "./panel-registry";
import type { CommandContext } from "../commands/context";
import type { EffectScope } from "@vue/reactivity";
import { activeRegistry } from "../commands/active-registry";
import {
  dismissSettingsMenu,
  isSettingsMenuOpen,
  openSettingsMenu,
  SETTINGS_MENU_PLACEMENT,
} from "./settings-menu";
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
  // Before the scope stops: an unmounted rail must not leave the menu's document-level capture
  // Keydown listener behind, answering for a gear that is no longer on screen.
  dismissSettingsMenu();
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
    "sp-icon-box": (s: string) => html`<sp-icon-box slot="icon" size=${s}></sp-icon-box>`,
    "sp-icon-data": (s: string) => html`<sp-icon-data slot="icon" size=${s}></sp-icon-data>`,
    "sp-icon-folder": (s: string) => html`<sp-icon-folder slot="icon" size=${s}></sp-icon-folder>`,
    "sp-icon-git-branch": gitBranchIcon,
    "sp-icon-layers": (s: string) => html`<sp-icon-layers slot="icon" size=${s}></sp-icon-layers>`,
    "sp-icon-search": (s: string) => html`<sp-icon-search slot="icon" size=${s}></sp-icon-search>`,
    "sp-icon-view-all-tags": (s: string) =>
      html`<sp-icon-view-all-tags slot="icon" size=${s}></sp-icon-view-all-tags>`,
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
  return !shell.docks.left.collapsed && shell.leftTab === panel.id;
}

/**
 * Reveal (or collapse) what a rail button names.
 *
 * There is no per-dock branch, because every rail button opens the Navigator. There WAS one — the
 * rail spanned two docks so that Problems could keep a button while its body was drawn in the
 * Bottom dock — and it cost a branch here, a branch in {@link isRailPanelShowing} and a third in
 * `focusPanel`, all to make one button behave like the other seven. A control on the left that
 * opens something at the bottom is also a lie about where it will take you. Problems is `rail:
 * false` now and is addressed by `view.setBottomTab`, like the three tabs beside it.
 *
 * @param {PanelRecord} panel
 */
export function toggleRailPanel(panel: PanelRecord): void {
  // `PanelRecord.id` is a `string` because the same registry hosts the Bottom dock's panels; the
  // Rail only ever draws Navigator ones, and `requireNavigatorPanelId` is the shared lock that says
  // So out loud rather than letting an undeclared id reach `shell.leftTab` (which is how the
  // Outline's empty state spent three phases opening a panel that did not exist).
  toggleActivityTab(requireNavigatorPanelId(panel.id, "the Navigator rail"));
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
 * The rail foot: the ⚙ **Settings** menu.
 *
 * It was two hand-authored buttons calling two module functions directly — the exact shape §2
 * principle 1 bans — and then, for a release, one button that ran `app.preferences` and nothing
 * else. That was the right shape for a pinned SLOT: a slot holds one thing, so it held the
 * application's settings, and project configuration went to the ⬢ menu and the palette because a
 * slot at application level could not honestly offer it.
 *
 * **This reverses that, and the reason it is not a regression is that the gear is no longer a
 * slot.** A menu may host two levels — `commandbar/overflow` has admitted application, project and
 * document since the matrix was written — because a menu prints each row's own name, chord and gate
 * beside it, so nothing about a row's level has to be inferred from where the control sits. The
 * levels are still separated: `settings/menu` is a matrix row admitting exactly application and
 * project, and the menu draws a divider where the level changes. Its one-click meaning is gone
 * deliberately: ⌘, still opens Preferences from anywhere, and the menu's first row prints that
 * chord.
 *
 * Rendered FROM the placement, so a record joins the gear by declaring `settings/menu` and there is
 * nothing here to update in step. With no project open the two project rows hide themselves and the
 * menu is Preferences alone — which is the correct answer on the welcome screen, and the reason the
 * button's own visibility asks the placement rather than one id.
 */
function railFooterTpl(): TemplateResult {
  const registry = activeRegistry();
  if (!registry || registry.forPlacement(SETTINGS_MENU_PLACEMENT).length === 0) {
    return html`${nothing}`;
  }
  const open = isSettingsMenuOpen();
  return html`
    <button
      type="button"
      class="rail-item${open ? " rail-item--menu-open" : ""}"
      data-rail-menu="settings"
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      title="Settings"
      @click=${(event: MouseEvent) => {
        openSettingsMenu(event.currentTarget as HTMLElement, { rerender: renderActivityBar });
      }}
      @keydown=${(event: KeyboardEvent) => {
        // The menu-button convention: either arrow opens, and the menu takes the keyboard from
        // There. Enter and Space are the button's own activation and already reach `@click`.
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          openSettingsMenu(event.currentTarget as HTMLElement, { rerender: renderActivityBar });
        }
      }}
    >
      <span class="rail-icon"><sp-icon-settings size="m"></sp-icon-settings></span>
      <span class="rail-label">Settings</span>
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
