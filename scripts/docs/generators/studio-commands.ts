// Generates the two registry-derived Studio reference pages:
//
//   Docs/studio/interface/commands.md   — every command record, by category
//   Docs/studio/interface/shortcuts.md  — every BINDING, by key scope
//
// Both are projections of one source: `appCommandSet()`, the bare-Bun-importable
// Command set the three CI checks already load. `src/commands/reference.ts` owns
// The row shapes and the tables; this file owns the frontmatter, the prose and
// The file identity. Plan §12 P3 lists these pages as generated and CI-diffed —
// The last place the app's keyboard and its documentation could disagree.

import { appCommandSet } from "../../../packages/studio/src/commands/app-commands.ts";
import {
  commandReference,
  commandsMarkdown,
  shortcutReference,
  shortcutsMarkdown,
} from "../../../packages/studio/src/commands/reference.ts";
import { BANNER } from "./shared.ts";

/**
 * Frontmatter for a generated page, with the association fields the plain
 * {@link import("./shared.ts").frontmatter} helper does not carry.
 */
function frontmatterWith(fields: {
  title: string;
  description: string;
  spec?: readonly string[];
  code?: readonly string[];
}): string {
  const lines = ["---", `title: "${fields.title}"`, `description: "${fields.description}"`];
  if (fields.spec && fields.spec.length > 0) {
    lines.push("spec:", ...fields.spec.map((entry) => `  - ${entry}`));
  }
  if (fields.code && fields.code.length > 0) {
    lines.push("code:", ...fields.code.map((entry) => `  - ${entry}`));
  }
  lines.push("generated: true", "---");
  return lines.join("\n");
}

/** The source files a reader should look at when a row here looks wrong. */
const CODE_REFS = [
  "packages/studio/src/commands/app-commands.ts",
  "packages/studio/src/commands/reference.ts",
  "packages/studio/src/commands/registry.ts",
  "packages/studio/src/commands/keymap.ts",
] as const;

/** Render the keyboard-shortcut sheet. */
export function generateShortcuts(): string {
  const rows = shortcutReference(appCommandSet());
  return `${[
    frontmatterWith({
      code: CODE_REFS,
      description:
        "Every keyboard shortcut in Jx Studio, grouped by where the key is live, with macOS and Windows/Linux spellings.",
      spec: ["studio.md#10"],
      title: "Keyboard shortcuts",
    }),
    BANNER,
    "",
    "# Keyboard shortcuts",
    "",
    "Every binding Studio registers, grouped by the scope the key is live in. macOS uses `⌘` where Windows and Linux use `Ctrl`; both spellings are printed side by side.",
    "",
    "A chord listed under a scope other than **Anywhere** only fires while that surface has focus — which is why `⌘D` duplicates an element on the canvas and does nothing while you are typing in a field.",
    "",
    "Every row is also a command: press :kbd[⌘K] and type the name to run it without the key. The full list is in **[Commands](/docs/studio/interface/commands)**.",
    "",
    shortcutsMarkdown(rows),
    "",
    "## Related",
    "",
    "- Every command, bound or not: **[Commands](/docs/studio/interface/commands)**",
    "- Running a command by name: **[Quick access](/docs/studio/interface/quick-access)**",
  ]
    .join("\n")
    .trimEnd()}\n`;
}

/** Render the command reference. */
export function generateCommands(): string {
  const rows = commandReference(appCommandSet());
  return `${[
    frontmatterWith({
      code: CODE_REFS,
      description:
        "Every command Jx Studio registers, by category, with its id, shortcut, level, and what it requires before it will run.",
      spec: ["studio.md#10"],
      title: "Commands",
    }),
    BANNER,
    "",
    "# Commands",
    "",
    "Everything Studio can do is a command, and every command is reachable by name: press :kbd[⌘K] and type. The same records drive the toolbar, the menus, the keyboard and the assistant, so this page cannot describe a button that does not exist.",
    "",
    "**Level** says what a command acts on — the application, the project, the open document, or the current selection. **Requires** is the sentence a greyed-out row shows you: it is the reason the command is not available yet, not an error after the fact.",
    "",
    commandsMarkdown(rows),
    "",
    "## Related",
    "",
    "- The keys these commands are bound to: **[Keyboard shortcuts](/docs/studio/interface/shortcuts)**",
    "- Running a command by name: **[Quick access](/docs/studio/interface/quick-access)**",
  ]
    .join("\n")
    .trimEnd()}\n`;
}
