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
 * - **Keyboard** — GENERATED from `commands/reference.ts`'s `shortcutReference()`, the same
 *   projection `docs/studio/interface/shortcuts.md` is built from. The registry is the one place a
 *   chord is declared, so the sheet cannot drift from the app or from the docs. Per §13.5 there is
 *   deliberately no screenshot of it — photographing generated content is a bug. It is searchable
 *   two ways, because there are two questions ("what is the shortcut for X" and "what did I just
 *   press"), and rebindable — as a LAYER over the registry (`settings/preferences-keymap.ts`), so
 *   the sheet stays a projection and the app's own record of a default is never edited.
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
import { chordFromEvent } from "../commands/keymap";
import {
  ensureCfConnection,
  listAccounts,
  notifyCredentialsChanged,
  platformBrokersCf,
  refreshCfConnection,
  resetCfConnectionCache,
  revokeAccount,
} from "./preferences-accounts";
import { applyKeybindingOverrides, rebindCommand, resetKeybinding } from "./preferences-keymap";
import { overlayRegion } from "../ui/regions";

import type { TemplateResult } from "lit-html";
import type { ChromeTheme } from "../shell";
import type { ShortcutRow } from "../commands/reference";
import type { RebindResult } from "./preferences-keymap";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/*
 * The sections moved to `./preferences-sections`, a leaf with no imports, so the rail's gear menu
 * can enumerate `app.preferences`'s own `section` argument without pulling this module's graph
 * (ai-models, github-auth, cf-settings, the settings kernel) into the rail. Re-exported here so
 * every existing import site is unchanged.
 */
import {
  DEFAULT_PREFERENCES_SECTION,
  isPreferencesSection,
  PREFERENCES_SECTIONS,
} from "./preferences-sections";

export {
  DEFAULT_PREFERENCES_SECTION,
  isPreferencesSection,
  PREFERENCES_SECTIONS,
} from "./preferences-sections";
export type { PreferencesSection } from "./preferences-sections";

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

/**
 * Showing a section is a chance to find out it is stale.
 *
 * Only Accounts has anything to re-read: the brokered Cloudflare connection lives on the server, so
 * a grant that lapsed while Preferences was closed — or while the author was in Keyboard — would
 * otherwise be reported from a cache taken before it did.
 */
function sectionShown(): void {
  if (_section === "accounts" && platformBrokersCf()) {
    void refreshCfConnection().then(repaint);
  }
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

/**
 * The buttons on one row.
 *
 * A record that declares `actions` decides its own verbs; everything else keeps the original rule —
 * a connected credential offers Disconnect and a disconnected one offers nothing. The async ones
 * repaint when they settle, because a hosted Reconnect is a round trip through a Cloudflare popup
 * and the row must not still be reading "expired" when it comes back.
 */
function accountActionsTpl(account: ReturnType<typeof listAccounts>[number]) {
  if (account.actions) {
    return account.actions.map(
      (action) => html`
        <sp-button
          size="s"
          data-action=${action.id}
          variant=${action.variant ?? nothing}
          treatment=${action.variant === "negative" ? "outline" : nothing}
          @click=${() => {
            void Promise.resolve(action.run()).finally(repaint);
          }}
        >
          ${action.label}
        </sp-button>
      `,
    );
  }
  return account.connected
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
    : nothing;
}

function accountsTpl(): TemplateResult {
  // First paint asks the broker what it holds; the answer arrives as a credentials-changed repaint.
  ensureCfConnection();
  return html`
    <div class="prefs-accounts">
      ${listAccounts().map(
        (account) => html`
          <div class="prefs-account" data-account=${account.id}>
            <div class="prefs-account-text">
              <span class="prefs-account-label">${account.label}</span>
              <span class="prefs-account-detail">${account.detail}</span>
            </div>
            <div class="prefs-account-actions">${accountActionsTpl(account)}</div>
          </div>
        `,
      )}
    </div>
  `;
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

/**
 * What the sheet is showing, if not everything.
 *
 * Two kinds because there are two questions. `text` answers "what is the shortcut for Duplicate";
 * `chord` answers "what did I just press", which is the one a list cannot answer by being read — a
 * chord's printed form is not what a person searching for it would type.
 */
type KeyFilter = { kind: "text"; value: string } | { kind: "chord"; chord: string } | null;

/** The next chord goes to the search box, or onto a command. `null` while nothing is listening. */
type KeyCapture = { mode: "search" } | { mode: "rebind"; command: AnyCommand } | null;

/** Keydowns that are not a chord yet: a modifier held on its way to one. */
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "OS"]);

let _keyFilter: KeyFilter = null;
let _keyCapture: KeyCapture = null;
/** The last refusal, held until the author does something else. */
let _keyRefusal: (RebindResult & { ok: false }) | null = null;

/** Forget the Keyboard section's transient state. Opening the sheet should never resume a capture. */
function resetKeyboardState(): void {
  _keyFilter = null;
  _keyCapture = null;
  _keyRefusal = null;
}

/** Whether a row survives the current filter. `format` is injected so one platform decision holds. */
function keyRowMatches(row: ShortcutRow, format: (chord: string) => string): boolean {
  if (!_keyFilter) {
    return true;
  }
  if (_keyFilter.kind === "chord") {
    return row.chord === _keyFilter.chord;
  }
  const query = _keyFilter.value.toLowerCase();
  return (
    row.title.toLowerCase().includes(query) ||
    row.commandId.toLowerCase().includes(query) ||
    format(row.chord).toLowerCase().includes(query)
  );
}

/**
 * One keydown while the sheet is listening.
 *
 * `stopPropagation` is the load-bearing line: the dispatcher is a `document` listener and
 * Preferences deliberately does not suspend the app (§15), so without it, capturing ⌘S would SAVE
 * while the author was trying to bind it.
 */
function onKeyboardKeyDown(event: KeyboardEvent): void {
  if (!_keyCapture || MODIFIER_KEYS.has(event.key)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const capture = _keyCapture;
  _keyCapture = null;
  if (event.key === "Escape") {
    _keyRefusal = null;
    repaint();
    return;
  }
  const registry = activeRegistry();
  if (!registry) {
    repaint();
    return;
  }
  const chord = chordFromEvent(event, registry.keymap.mac);
  if (capture.mode === "search") {
    _keyFilter = { kind: "chord", chord };
    _keyRefusal = null;
  } else {
    const result = rebindCommand(registry, capture.command, chord);
    _keyRefusal = result.ok ? null : result;
  }
  repaint();
}

/** The refusal, and the one thing that can be done about it: go and look at the command holding it. */
function keyRefusalTpl(): TemplateResult | typeof nothing {
  if (!_keyRefusal) {
    return nothing;
  }
  const { conflict } = _keyRefusal;
  return html`
    <div class="prefs-field">
      <sp-help-text variant="negative">${_keyRefusal.reason}</sp-help-text>
      ${
        conflict
          ? html`
              <sp-button
                size="s"
                treatment="outline"
                @click=${() => {
                  _keyFilter = { kind: "text", value: conflict.title };
                  _keyRefusal = null;
                  repaint();
                }}
              >
                Show ${conflict.title}
              </sp-button>
            `
          : nothing
      }
    </div>
  `;
}

/**
 * One binding.
 *
 * The record is passed in rather than looked up: the rows and the commands come from the same
 * `registry.list()` call, so there is no window in which a row can name something the sheet cannot
 * resolve, and no assertion pretending so.
 */
function keyRowTpl(
  row: ShortcutRow,
  command: AnyCommand,
  registry: CommandRegistry,
): TemplateResult {
  const capturing = _keyCapture?.mode === "rebind" && _keyCapture.command.id === row.commandId;
  return html`
    <div class="prefs-key" data-command=${row.commandId}>
      <kbd class="prefs-key-chord">
        ${capturing ? "Press a shortcut…" : registry.keymap.format(row.chord)}
      </kbd>
      <span class="prefs-key-title">${row.title}${row.overridden ? " — changed" : ""}</span>
      <sp-action-button
        size="s"
        quiet
        ?selected=${capturing}
        aria-label=${capturing ? `Stop changing ${row.title}` : `Change the shortcut for ${row.title}`}
        @click=${() => {
          _keyCapture = capturing ? null : { mode: "rebind", command };
          _keyRefusal = null;
          repaint();
        }}
      >
        ${capturing ? "Cancel" : "Change"}
      </sp-action-button>
      ${
        row.overridden
          ? html`
              <sp-action-button
                size="s"
                quiet
                aria-label=${`Reset the shortcut for ${row.title}`}
                @click=${() => {
                  resetKeybinding(registry, row.commandId);
                  _keyRefusal = null;
                  repaint();
                }}
              >
                Reset
              </sp-action-button>
            `
          : nothing
      }
    </div>
  `;
}

/**
 * The keyboard sheet — every live binding, grouped by the scope it is live in.
 *
 * The rows come from the running registry through `shortcutReference`, so a command registered by
 * an extension appears here without this file knowing it exists, and the user's layer is passed to
 * the same projection rather than patched into its output.
 *
 * A command that declares two chords has two rows and rebinding either one leaves it with one — a
 * user who asked for ⌥⌘Y is not also asking to keep ⌘Y, and Reset brings both back.
 */
function keyboardTpl(): TemplateResult {
  const registry = activeRegistry();
  const commands: readonly AnyCommand[] = registry ? [...registry.list()] : [];
  const rows = registry ? shortcutReference(commands, registry.keymap.overrides()) : [];
  if (!registry || rows.length === 0) {
    return html`<p class="prefs-empty">No commands are registered in this window.</p>`;
  }
  const format = (chord: string) => registry.keymap.format(chord);
  const byId = new Map(commands.map((command) => [command.id, command]));
  const visible = rows.flatMap((row) => {
    const command = byId.get(row.commandId);
    return command && keyRowMatches(row, format) ? [{ command, row }] : [];
  });
  const scopes = [...new Set(visible.map(({ row }) => row.scope))];
  const capturingSearch = _keyCapture?.mode === "search";
  return html`
    <div class="prefs-keys" @keydown=${onKeyboardKeyDown}>
      <div class="prefs-field">
        <sp-search
          size="s"
          placeholder="Find a shortcut…"
          .value=${
            _keyFilter === null
              ? ""
              : _keyFilter.kind === "chord"
                ? format(_keyFilter.chord)
                : _keyFilter.value
          }
          @input=${(event: Event) => {
            const { value } = event.target as HTMLInputElement;
            _keyFilter = value ? { kind: "text", value } : null;
            _keyCapture = null;
            repaint();
          }}
          @submit=${(event: Event) => event.preventDefault()}
        ></sp-search>
        <sp-action-button
          size="s"
          ?selected=${capturingSearch}
          @click=${() => {
            _keyCapture = capturingSearch ? null : { mode: "search" };
            _keyRefusal = null;
            repaint();
          }}
        >
          ${capturingSearch ? "Press it now" : "Search by keystroke"}
        </sp-action-button>
      </div>
      ${keyRefusalTpl()}
      ${
        visible.length === 0
          ? html`<p class="prefs-empty">
              ${
                _keyFilter?.kind === "chord"
                  ? `Nothing is bound to ${format(_keyFilter.chord)}.`
                  : "No shortcut matches that."
              }
            </p>`
          : scopes.map(
              (scope) => html`
                <h4 class="prefs-keys-scope">${SCOPE_LABELS[scope]}</h4>
                ${visible
                  .filter(({ row }) => row.scope === scope)
                  .map(({ command, row }) => keyRowTpl(row, command, registry))}
              `,
            )
      }
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
  /* Opening is a fresh look, so nothing may be reported from the last one: a brokered Cloudflare
     grant can lapse between visits, and a row that repaints the previous answer first is stating
     something it has no reason to believe. */
  resetCfConnectionCache();
  _section = section !== undefined && isPreferencesSection(section) ? section : _section;
  if (_close) {
    repaint();
    sectionShown();
    return Promise.resolve(null);
  }
  _section =
    section !== undefined && isPreferencesSection(section) ? section : DEFAULT_PREFERENCES_SECTION;
  credsForm.startEdit();
  resetKeyboardState();
  sectionShown();
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
                        // Leaving a section abandons what it was in the middle of: an armed key
                        // Capture whose listener is no longer mounted would otherwise swallow the
                        // First chord pressed on the author's NEXT visit.
                        resetKeyboardState();
                        repaint();
                        sectionShown();
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
      menus: ["commandbar/overflow", "settings/menu", "palette"],
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

/**
 * Register the preferences verb, and apply the preferences that are already stored.
 *
 * The keyboard layer is applied HERE rather than at the end of the bootstrap because the keymap
 * holds the layer itself: every record registered after this call — including the ones the
 * bootstrap registers below it — is indexed against the author's overrides, so a rebinding survives
 * a reload without anything having to run last.
 */
export function registerPreferencesCommands(registry: CommandRegistry): void {
  registry.registerAll(preferencesCommands());
  applyKeybindingOverrides(registry);
}
