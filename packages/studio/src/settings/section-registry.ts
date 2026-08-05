/**
 * The Project Settings section registry, and which of its sections the document is showing.
 *
 * `registerSettingsSection` is a **preserved public contract** (specs/extensions.md §9.1): an
 * extension's `project` class declares a `$studio.settings` block and `settings/extension-sections`
 * turns it into one of these records. P6 moved Project Settings out of a modal and into a document
 * in the pane; the registry did not move with it, because a section is a contribution to
 * CONFIGURATION, not to a dialog. Splitting it out is what lets the host be replaced without the
 * contribution point being touched.
 *
 * **This module holds no renderer and imports nothing.** That is load-bearing rather than tidy:
 * `panels/settings-pane.ts` is reached from `canvas/canvas-render.ts`, so anything this module
 * imports becomes part of the canvas's import graph. The section RENDERERS are registered by
 * `settings/settings-document.ts`, which the app loads when it registers its commands.
 *
 * **What is requested and what is displayed are two variables, and unregistering touches neither.**
 * The modal had one, and its `unregisterSettingsSection` reset it to `"general"` — which is half of
 * the deep-link race P6 exists to close. The contribution sync unregisters stale keys before it
 * registers fresh ones, so a section merely being REFRESHED took the caller's requested section
 * down with it, silently, after the awaited readiness promise had already resolved. Here a request
 * outlives its section going away and is satisfied the moment the key comes back.
 */

/** A Project Settings section: an inner-nav entry plus a renderer for the content area. */
export interface SettingsSection {
  key: string;
  label: string;
  /** Nav icon name (reserved for future nav treatments). */
  icon?: string | undefined;
  /** Sort position — lower orders render higher in the inner nav. */
  order: number;
  render: (container: HTMLElement) => void;
}

/** Where a settings document lands when nobody named a section. */
export const DEFAULT_SETTINGS_SECTION = "overview";

const sections = new Map<string, SettingsSection>();

const listeners = new Set<() => void>();

/**
 * Tell every subscriber something changed.
 *
 * A `Set` tolerates deletion during its own iteration, so a listener that unsubscribes itself (the
 * pane host, on unmount) is safe without copying.
 */
function announce(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Redraw the settings document — for a change this module cannot see, such as a command selecting
 * an entry inside the section that is already on screen.
 */
export function notifySettingsDocument(): void {
  announce();
}

/**
 * Subscribe to everything that changes what the settings document draws: the section set (an
 * extension registering or going away) and the chosen section. Returns the unsubscribe.
 *
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onSettingsDocumentChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register (or replace) a settings section.
 *
 * @param {SettingsSection} section
 */
export function registerSettingsSection(section: SettingsSection): void {
  sections.set(section.key, section);
  announce();
}

/**
 * Remove a registered section — used when a descriptor-contributed section's extension is disabled
 * (see ./extension-sections). Built-ins are never unregistered.
 *
 * @param {string} key
 */
export function unregisterSettingsSection(key: string): void {
  if (sections.delete(key)) {
    announce();
  }
}

/** Registered sections sorted by order (registration order breaks ties). */
export function sortedSettingsSections(): SettingsSection[] {
  return [...sections.values()].toSorted((a, b) => a.order - b.order);
}

/** Every registered section key, built-ins and contributions alike, in display order. */
export function settingsSectionKeys(): string[] {
  return sortedSettingsSections().map((section) => section.key);
}

/**
 * One section by key, or `undefined`.
 *
 * @param {string} key
 * @returns {SettingsSection | undefined}
 */
export function settingsSection(key: string): SettingsSection | undefined {
  return sections.get(key);
}

// ─── Which section is on screen ───────────────────────────────────────────────

/** The section the last caller ASKED for, kept until it is satisfied. */
let _requested: string | null = null;

/** The section the document is drawing. Only a nav click and a satisfied request move it. */
let _displayed = DEFAULT_SETTINGS_SECTION;

/**
 * The section key the document should render right now.
 *
 * A pending request wins as soon as its section exists. Otherwise the displayed one, and — when
 * that has been unregistered too — the first section there is, so the content area is never blank
 * because of bookkeeping.
 *
 * @returns {string}
 */
export function settingsDocumentSection(): string {
  if (_requested !== null && sections.has(_requested)) {
    _displayed = _requested;
    _requested = null;
    return _displayed;
  }
  if (sections.has(_displayed)) {
    return _displayed;
  }
  return settingsSectionKeys()[0] ?? _displayed;
}

/**
 * Show a section. A nav click satisfies itself immediately; a deep link to a section that has not
 * registered yet is remembered until it does.
 *
 * @param {string} key
 */
export function setSettingsSection(key: string): void {
  if (sections.has(key)) {
    _displayed = key;
    _requested = null;
  } else {
    _requested = key;
  }
  announce();
}

/** Forget the chosen section — the project-close and test hook. */
export function resetSettingsDocumentState(): void {
  _requested = null;
  _displayed = DEFAULT_SETTINGS_SECTION;
}
