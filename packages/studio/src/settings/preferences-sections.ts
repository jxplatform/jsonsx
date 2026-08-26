/**
 * The Preferences sections — the values `app.preferences { section }` accepts.
 *
 * A LEAF: it imports nothing, and that is the whole reason it is a file. `preferences-dialog.ts`
 * reaches `ui/layers`, `ui/ai-credentials-form`, `ui/ai-managed-connect`, `preferences-accounts` (→
 * github-auth, cf-settings, ai-settings, ai-models) and `preferences-keymap` (→
 * services/settings/kernel) — a graph so wide that `tests/preferences-dialog.test.ts` mocks
 * `ai-models` merely to import the module at all. The rail's gear menu needs four labels from it
 * and nothing else, so it takes the labels rather than the graph.
 *
 * Same split, and the same stated reason, as `settings/section-registry.ts`: what is contributed to
 * is not the surface that renders it, and keeping the two apart is what lets either be replaced.
 *
 * `preferences-dialog.ts` re-exports every symbol here, so no existing import site moved.
 */

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
