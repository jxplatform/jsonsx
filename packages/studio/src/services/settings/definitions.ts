/**
 * The settings registry — every application setting Studio holds, declared once.
 *
 * Before this table the answer to "which settings roam, and what is each one's default" lived in
 * four places: a `PERSISTED_SETTINGS_KEYS` array, a private `const` per key in each `*-settings.ts`,
 * a bespoke getter/setter pair beside it, and whatever the getter's `||` happened to fall back to.
 * Adding a roaming setting meant editing all four and hoping; the key strings themselves were
 * duplicated between the array and the module that owned them.
 *
 * Two properties of this table are load-bearing rather than tidy:
 *
 * 1.  **Scope is declared, not inferred.** {@link USER_SETTINGS} is DERIVED from it, so a setting
 *     roams because it says `scope: "user"` — not because someone remembered to add its key to a
 *     second list. `device` is the honest name for the rest: panel geometry and a palette's MRU
 *     describe *this window*, and a user with two windows open wants them to differ.
 * 2.  **A default is not a value.** The default is what a *reader* sees when nothing is stored; it
 *     is never itself stored. `getModel()` used to mask unset as `"gpt-4o"` with `||`, a form
 *     prefilled from it, and Save wrote the mask back — which is how an install whose owner had
 *     configured an entirely different provider was left holding `jx.ai.model: "gpt-4o"` and
 *     nothing else. {@link readSetting} and {@link readStoredSetting} in `kernel.ts` are two
 *     functions for exactly this reason.
 *
 * @license MIT
 */

/**
 * Where a setting lives.
 *
 * `user` follows the author — every window, every project, and (where the platform has a backend
 * store) every browser profile the launcher hands out. `device` stays where it was written.
 */
export type SettingScope = "user" | "device";

/** One setting, as the registry declares it. */
export interface SettingDefinition {
  /** The storage key, in both localStorage and the backend map. */
  key: string;
  scope: SettingScope;
  /** What a reader sees when nothing is stored. Never written — see the module docblock. */
  default: string;
  /**
   * Whether the value is a credential.
   *
   * Nothing in the kernel treats a secret differently; the flag is what lets a surface refuse to
   * print one, a diagnostic dump refuse to include one, and the Accounts list report _that_ one is
   * held rather than what it is (`specs/studio.md` §15 rule 1).
   */
  secret?: boolean;
  /**
   * Canonicalise an incoming value before it is stored. Total: it is handed raw user input.
   *
   * Applied on write only. A value already on disk is returned as it was found, so a normalizer
   * that tightens later cannot silently rewrite what someone else stored.
   */
  normalize?: (raw: string) => string;
}

/** Trim, and drop trailing slashes — an endpoint is a base, not a path. */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Trim. Credentials are pasted, and a paste carries whitespace. */
function trimmed(raw: string): string {
  return raw.trim();
}

/**
 * Every setting, keyed by the name the rest of the app refers to it by.
 *
 * Declared `as const satisfies` so each entry keeps its literal `key` for callers while still being
 * checked against {@link SettingDefinition}.
 */
export const SETTINGS = {
  aiBaseUrl: {
    default: "",
    key: "jx.ai.baseUrl",
    normalize: normalizeBaseUrl,
    scope: "user",
  },
  /**
   * The provider key. Stays in the settings store rather than moving to the launcher's credential
   * store: the webview is its legitimate consumer — it sends the key itself as `X-Api-Key` — so
   * withholding it and then transmitting it would be the same trust boundary with more parts. See
   * `specs/desktop.md` §3.6, which draws that line.
   */
  aiOpenAiKey: {
    default: "",
    key: "jx.ai.openaiKey",
    normalize: trimmed,
    scope: "user",
    secret: true,
  },
  /**
   * `"gpt-4o"` is what a sender falls back to, NOT a stored choice. A surface that writes back must
   * read through `readStoredSetting`, or it persists a model the user never picked.
   */
  aiModel: {
    default: "gpt-4o",
    key: "jx.ai.model",
    normalize: trimmed,
    scope: "user",
  },
  /**
   * The author's rebindings, as a JSON object of `command id → chords`.
   *
   * Roams, so a keyboard learned once is the keyboard everywhere. `normalize` is why the field
   * exists on {@link SettingDefinition}: an empty override map is the absence of an override, and
   * storing `"{}"` would make every window think a layer had been authored.
   */
  keybindings: {
    default: "",
    key: "jx.keybindings",
    normalize: (raw) => (raw.trim() === "{}" ? "" : raw.trim()),
    scope: "user",
  },
  /**
   * The chrome theme.
   *
   * Read at module evaluation, before the first paint — `shell.ts` says a mismatch with the theme
   * `index.html` hard-codes flashes the shell. That is the reason the kernel keeps a synchronous
   * cache rather than awaiting the backend.
   */
  theme: {
    default: "",
    key: "jx-studio-theme",
    normalize: trimmed,
    scope: "user",
  },
  cfAccountId: {
    default: "",
    key: "jx.cf.accountId",
    normalize: trimmed,
    scope: "user",
  },
  cfToken: {
    default: "",
    key: "jx.cf.token",
    normalize: trimmed,
    scope: "user",
    secret: true,
  },
} as const satisfies Record<string, SettingDefinition>;

/** The registry's own names — `SETTINGS.aiModel`, not `"jx.ai.model"`. */
export type SettingName = keyof typeof SETTINGS;

/** Every declared setting, in declaration order. */
export const ALL_SETTINGS: readonly SettingDefinition[] = Object.values(SETTINGS);

/**
 * The settings that roam, derived from {@link SETTINGS}.
 *
 * This replaces the hand-maintained `PERSISTED_SETTINGS_KEYS`. A setting joins it by declaring
 * `scope: "user"` and by no other means, so the list cannot fall behind the table it describes.
 */
export const USER_SETTINGS: readonly SettingDefinition[] = ALL_SETTINGS.filter(
  (definition) => definition.scope === "user",
);

/** The roaming keys as strings — what a backend map is keyed by. */
export const USER_SETTING_KEYS: readonly string[] = USER_SETTINGS.map(
  (definition) => definition.key,
);
