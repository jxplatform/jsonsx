/// <reference lib="dom" />
/**
 * Preferences-dialog.ts — ⌘, the application-preferences surface Studio did not have.
 *
 * Plan §9.3 draws the line this file finally makes real. **Project Settings** configures a project
 * and belongs to the project (breakpoints, definitions, deploy); **Preferences** configures the
 * application and follows you between them. Studio shipped only the first, behind a gear in the
 * rail — the slot every other editor spends on the second — and so had nowhere at all to put the
 * chrome theme, the assistant's provider key, the keyboard, or the three credentials it holds.
 *
 * Four sections, and each one closes a hole that was named in the plan:
 *
 * - **Appearance** — the chrome theme. `shell.theme` and `view.setTheme` already existed; nothing
 *   rendered them, so the only way to change the theme was to run a command by hand.
 * - **Assistant** — the provider key. It used to live in `Assistant: Settings…`, a dialog reachable
 *   only from inside the assistant panel, which meant a key had to be configured from the surface
 *   that was broken for want of one. That dialog is deleted; this is where it went.
 * - **Accounts** — GitHub, the AI provider and Cloudflare, listed with a Disconnect each. Before
 *   this, `clearGithubToken()` had zero callers: signing out of GitHub was not expressible.
 * - **Keyboard** — read-only, and GENERATED from `commands/reference.ts`'s `shortcutReference()`, the
 *   same projection `docs/studio/interface/shortcuts.md` is built from. The registry is the one
 *   place a chord is declared, so the sheet cannot drift from the app or from the docs. Per §13.5
 *   there is deliberately no screenshot of it — photographing generated content is a bug.
 *
 * Modality: an `sp-dialog-wrapper` through {@link showDialog}, which is focus-managed and dismissed
 * by Escape — not `openModal`'s `inset:40px` blackout. Preferences does not suspend the app.
 */

import { html, nothing, render as litRender } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { CHROME_THEMES, setChromeTheme, shell } from "../shell";
import { showDialog } from "../ui/layers";
import { createAiCredentialsForm } from "../ui/ai-credentials-form";
import { createManagedConnect } from "../ui/ai-managed-connect";
import { activeRegistry } from "../commands/active-registry";
import { shortcutReference, SCOPE_LABELS } from "../commands/reference";
import { formatChord, isMacPlatform } from "../commands/keymap";
import { listAccounts, notifyCredentialsChanged, revokeAccount } from "./preferences-accounts";
import { overlayRegion } from "../ui/regions";

import type { TemplateResult } from "lit-html";
import type { ChromeTheme } from "../shell";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/** One section of the sheet. The `id` is what `app.preferences { section }` accepts. */
export interface PreferencesSection {
  id: string;
  title: string;
  /** The one-line answer to "what is in here", shown under the heading. */
  blurb: string;
}

/**
 * The sections, in sheet order.
 *
 * §9.3 lists six for the finished surface (Editor behaviour and Updates/About are the other two).
 * Four are built; a section is added here when it has something to configure, never before — an
 * empty pane is the "declared but unbuilt" state the rail already refuses to render.
 */
export const PREFERENCES_SECTIONS: readonly PreferencesSection[] = [
  { id: "appearance", title: "Appearance", blurb: "How the Studio chrome looks." },
  {
    id: "assistant",
    title: "Assistant",
    blurb: "The AI provider the assistant talks to. Stored on this machine.",
  },
  {
    id: "accounts",
    title: "Accounts",
    blurb: "Every credential Studio holds, and how to make it forget one.",
  },
  {
    id: "keyboard",
    title: "Keyboard",
    blurb: "Generated from the command registry — the app's own record of every chord.",
  },
];

/** The section the sheet opens on when none is named. */
export const DEFAULT_PREFERENCES_SECTION = PREFERENCES_SECTIONS[0]!.id;

/** Whether a string names a section. */
export function isPreferencesSection(id: unknown): boolean {
  return PREFERENCES_SECTIONS.some((section) => section.id === id);
}

// ─── Open state ───────────────────────────────────────────────────────────────

let _section = DEFAULT_PREFERENCES_SECTION;

/** Repaint the open sheet, if one is up. */
let _rerender: (() => void) | null = null;

/** Dismiss the open sheet, if one is up. */
let _close: (() => void) | null = null;

/** Whether Preferences is on screen. */
export function isPreferencesOpen(): boolean {
  return _close !== null;
}

/** The section currently showing. Exposed for tests and for the `app.preferences` round-trip. */
export function preferencesSection(): string {
  return _section;
}

function repaint(): void {
  _rerender?.();
}

/** Save/revoke both change what other surfaces show, so they announce as well as repaint. */
function credentialsChanged(): void {
  notifyCredentialsChanged();
  repaint();
}

/** The shared credentials form — draft state lives inside the form's closure. */
const credsForm = createAiCredentialsForm({
  intro: html`
    Any OpenAI-compatible key works. Stored locally on this machine; sent only to the Studio proxy
    (never to a third party except your chosen endpoint).
  `,
  // Both buttons keep the sheet open: Preferences is a place, not a wizard step, and the previous
  // Dialog's habit of vanishing on Save is what made "did that take?" unanswerable.
  onCancel: repaint,
  onSaved: credentialsChanged,
  requestRender: repaint,
});

/** Shared with the New Project modal's gates — see ui/ai-managed-connect.ts. */
const managedConnect = createManagedConnect({ requestRender: credentialsChanged });

// ─── Sections ─────────────────────────────────────────────────────────────────

function appearanceTpl(): TemplateResult {
  return html`
    <div class="prefs-field">
      <span class="prefs-field-label">Theme</span>
      <sp-action-group compact selects="single" size="s">
        ${CHROME_THEMES.map(
          (theme) => html`
            <sp-action-button
              value=${theme}
              ?selected=${shell.theme === theme}
              @click=${() => {
                setChromeTheme(theme as ChromeTheme);
                repaint();
              }}
            >
              ${theme === "dark" ? "Dark" : "Light"}
            </sp-action-button>
          `,
        )}
      </sp-action-group>
    </div>
  `;
}

function assistantTpl(): TemplateResult {
  managedConnect.ensureProbe();
  return html`<div class="prefs-assistant">${managedConnect.render()} ${credsForm.render()}</div>`;
}

function accountsTpl(): TemplateResult {
  return html`
    <div class="prefs-accounts">
      ${listAccounts().map(
        (account) => html`
          <div class="prefs-account" data-account=${account.id}>
            <div class="prefs-account-text">
              <span class="prefs-account-label">${account.label}</span>
              <span class="prefs-account-detail">${account.detail}</span>
            </div>
            ${
              account.connected
                ? html`
                    <sp-button
                      size="s"
                      variant="negative"
                      treatment="outline"
                      @click=${() => {
                        revokeAccount(account.id);
                        repaint();
                      }}
                    >
                      Disconnect
                    </sp-button>
                  `
                : nothing
            }
          </div>
        `,
      )}
    </div>
  `;
}

/**
 * The keyboard sheet — every live binding, grouped by the scope it is live in.
 *
 * Read-only by design in this phase: §9.3's "rebindable" needs a persisted override map and a
 * conflict resolver, and shipping the LIST first is what makes the app teach its own keyboard
 * (§8.5) at a cost of one projection call. The rows come from the running registry, so a command
 * registered by an extension appears here without this file knowing it exists.
 */
function keyboardTpl(): TemplateResult {
  const registry = activeRegistry();
  const commands: readonly AnyCommand[] = registry ? [...registry.list()] : [];
  const rows = shortcutReference(commands);
  if (rows.length === 0) {
    return html`<p class="prefs-empty">No commands are registered in this window.</p>`;
  }
  const mac = isMacPlatform();
  const scopes = [...new Set(rows.map((row) => row.scope))];
  return html`
    <div class="prefs-keys">
      ${scopes.map(
        (scope) => html`
          <h4 class="prefs-keys-scope">${SCOPE_LABELS[scope]}</h4>
          ${rows
            .filter((row) => row.scope === scope)
            .map(
              (row) => html`
                <div class="prefs-key">
                  <kbd class="prefs-key-chord">${formatChord(row.chord, mac)}</kbd>
                  <span class="prefs-key-title">${row.title}</span>
                </div>
              `,
            )}
        `,
      )}
    </div>
  `;
}

function sectionBodyTpl(): TemplateResult {
  if (_section === "assistant") {
    return assistantTpl();
  }
  if (_section === "accounts") {
    return accountsTpl();
  }
  if (_section === "keyboard") {
    return keyboardTpl();
  }
  return appearanceTpl();
}

// ─── The sheet ────────────────────────────────────────────────────────────────

/**
 * Open Preferences, optionally on a named section. Resolves when it is dismissed.
 *
 * Re-opening while it is already up SELECTS the section instead of stacking a second sheet — which
 * is what makes "Assistant: no provider connected → Preferences" land on the Assistant section from
 * inside the assistant, rather than on top of itself.
 *
 * @param section One of {@link PREFERENCES_SECTIONS}' ids. An unknown id falls back to Appearance.
 */
export function openPreferences(section?: string): Promise<null> {
  _section = section !== undefined && isPreferencesSection(section) ? section : _section;
  if (_close) {
    repaint();
    return Promise.resolve(null);
  }
  _section =
    section !== undefined && isPreferencesSection(section) ? section : DEFAULT_PREFERENCES_SECTION;
  credsForm.startEdit();
  return showDialog<null>(
    (done) => {
      let wrapperEl: HTMLElement | null = null;

      function finish() {
        _rerender = null;
        _close = null;
        done(null);
      }

      function build(): TemplateResult {
        const active = PREFERENCES_SECTIONS.find((candidate) => candidate.id === _section);
        return html`
          <sp-dialog-wrapper
            open
            underlay
            headline="Preferences"
            cancel-label="Close"
            size="l"
            @cancel=${finish}
            @close=${finish}
            ${ref((el?: Element) => {
              if (el) {
                wrapperEl = el as HTMLElement;
              }
            })}
          >
            <div class="prefs-sheet">
              <nav class="prefs-nav" aria-label="Preferences sections">
                ${PREFERENCES_SECTIONS.map(
                  (candidate) => html`
                    <button
                      type="button"
                      class="prefs-nav-item ${candidate.id === _section ? "active" : ""}"
                      aria-current=${candidate.id === _section ? "true" : "false"}
                      @click=${() => {
                        _section = candidate.id;
                        repaint();
                      }}
                    >
                      ${candidate.title}
                    </button>
                  `,
                )}
              </nav>
              <section class="prefs-body">
                <h3 class="prefs-title">${active?.title ?? ""}</h3>
                <p class="prefs-blurb">${active?.blurb ?? ""}</p>
                ${sectionBodyTpl()}
              </section>
            </div>
          </sp-dialog-wrapper>
        `;
      }

      _close = finish;
      _rerender = () => {
        // Resolved lazily: lit commits element refs before inserting the fragment, so the slot the
        // Sheet was rendered into is only reachable once the first render has landed.
        const host = wrapperEl?.parentElement;
        if (host) {
          litRender(build(), host);
        }
      };
      return build();
    },
    { region: overlayRegion("dialog", "preferences") },
  );
}

/** Close Preferences if it is open. Tests, and the shell teardown. */
export function closePreferences(): void {
  _close?.();
}

// ─── Command ──────────────────────────────────────────────────────────────────

/**
 * `app.preferences` — ⌘, everywhere, with no precondition.
 *
 * Application level, and deliberately not gated on an open project: the theme, the provider key and
 * the keyboard are all configurable from the welcome screen, which is exactly where a first-run
 * user is when they need them.
 */
export function preferencesCommands(): AnyCommand[] {
  return [
    {
      args: {
        additionalProperties: false,
        properties: {
          section: {
            type: "string",
            enum: PREFERENCES_SECTIONS.map((section) => section.id),
            description: "Which Preferences section to show. Defaults to Appearance.",
          },
        },
        required: [],
        type: "object",
      },
      category: "View",
      id: "app.preferences",
      level: "application",
      keybinding: "mod+,",
      menus: ["commandbar/overflow", "palette"],
      group: "7_settings",
      run: (_ctx, args) => {
        const section = (args as { section?: unknown } | undefined)?.section;
        if (section !== undefined && !isPreferencesSection(section)) {
          throw new RangeError(
            `command "app.preferences" argument "section": "${String(section)}" is not a ` +
              `Preferences section — declared: ` +
              `${PREFERENCES_SECTIONS.map((candidate) => candidate.id).join(", ")}`,
          );
        }
        void openPreferences(section as string | undefined);
      },
      title: "Preferences…",
    },
  ];
}

/** Register the preferences verb. Called from the bootstrap, beside the state it writes. */
export function registerPreferencesCommands(registry: CommandRegistry): void {
  registry.registerAll(preferencesCommands());
}
