/// <reference lib="dom" />
/**
 * The three verbs over `project.json` `extensions[]`, and the operations behind them.
 *
 * **They are command records because the array has two writers.** The person flips a switch and the
 * assistant calls a tool, and `specs/studio-ui-guidelines.md` §12.4 is about exactly that: "the
 * agent counts as a surface", and a family over one piece of state declares ONE availability rule.
 * The tools in `services/ai-extension-tools.ts` execute by running these records rather than
 * reimplementing the writes, so the two gates cannot drift into the shape that table catalogues,
 * where the loose member is always the one that writes.
 *
 * **`enablement` is `ctx.project.open` and nothing else, on all three.** A precondition that
 * depends on an ARGUMENT cannot live there — `enablement` cannot see one — so "is this a real
 * extension?", "can this backend run it?" and "is it still enabled?" are refused inside `run` with
 * a `RangeError` naming the value, the shape §12.4 prescribes and `pane.derive` already uses.
 *
 * **The in-flight latch lives here, not in the section**, because the assistant can run these too:
 * a latch the renderer owned would let a tool call and a click install concurrently.
 */

import {
  argsSchema,
  derivedEnumProperty,
  stringArg,
  stringProperty,
} from "../commands/command-args";
import { beginActivity } from "../panels/activity-panel";
import { buildRows, enabledSpecifiers } from "./extension-rows";
import { getPlatform } from "../platform";
import { notify } from "../services/notify";
import { notifySettingsDocument } from "./section-registry";
import { updateSiteConfig } from "../site-context";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/** The package an extension operation is running for, or null. */
let _inFlight: string | null = null;

/**
 * What an extension operation is currently running for, if anything.
 *
 * Read by every surface that offers one, so a second install cannot start while the first is
 * writing `package.json` and `project.json`.
 *
 * @returns {string | null}
 */
export function extensionOpInFlight(): string | null {
  return _inFlight;
}

/** Names that could be turned on right now — the palette's and the agent's choice list. */
function enableable(): string[] {
  return buildRows()
    .filter((row) => !row.enabled && row.unavailable === undefined)
    .map((row) => row.name);
}

/**
 * Install the package if it is missing, then add it to `project.json`.
 *
 * **The order is the point.** A `project.json` naming a package that is not installed is a hard
 * registry failure at the next build, so config-first opens a window in which the whole project is
 * broken, and on an install failure it never closes. Install-first can only ever leave an unused
 * dependency, which is inert.
 *
 * So a failed install DOES NOT write the config: writing anyway would manufacture the very state
 * this section exists to remove. A failed config write does not roll the install back either — that
 * is the same asymmetry as turning an extension off, and an automatic uninstall triggered by an
 * unrelated failure is a destructive act nobody asked for.
 *
 * Nothing here refreshes the extension surfaces: `commitProjectConfig` compares the `extensions`
 * key and does it already, and it is awaited before `updateSiteConfig` resolves.
 *
 * @param {string} specifier
 * @returns {Promise<void>}
 */
export async function enableExtension(specifier: string): Promise<void> {
  if (_inFlight !== null) {
    throw new Error(`Another extension operation is running (${_inFlight}).`);
  }
  const row = buildRows().find((r) => r.specifier === specifier || r.name === specifier);
  if (row === undefined) {
    throw new RangeError(
      `command "project.enableExtension" argument "package": "${specifier}" is not an extension ` +
        `this backend offers and is not installed — offered: ${enableable().join(", ") || "none"}`,
    );
  }
  if (row.unavailable !== undefined) {
    throw new RangeError(
      `command "project.enableExtension" argument "package": "${specifier}" cannot be enabled on ` +
        `this backend — ${row.unavailable}`,
    );
  }
  if (row.enabled) {
    return;
  }

  _inFlight = row.name;
  notifySettingsDocument();
  try {
    if (!row.installed && !row.bundled) {
      /*
       * `beginActivity`, not `showProgressModal`. §13.3 reserves blocking for an operation that
       * cannot proceed while the author edits, and this one can — the only real hazard is a second
       * concurrent write, which the latch closes for a fraction of the cost of freezing the app.
       * `ui/progress-modal.ts` also enumerates its four call sites as a closed set, and a fifth
       * would make a written invariant false.
       */
      const activity = beginActivity({
        source: "Extensions",
        status: "Running bun…",
        title: `Install ${row.name}`,
      });
      try {
        await getPlatform().addPackage(row.name);
      } catch (error) {
        activity.fail(
          `Could not install ${row.name} — ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      /*
       * The activity ends HERE, before the config write, and that boundary is load-bearing:
       * `ActivityHandle.fail` raises its own Problem and `commitProjectConfig` raises another keyed
       * `save:project.json`, so an activity spanning both would post two Problems for one failure
       * with different keys — undeduplicable, and exactly what §13.3 rule 3 forbids. It is also
       * honest: the install did succeed.
       */
      activity.done();
    }
    await updateSiteConfig({ extensions: [...enabledSpecifiers(), row.specifier] });
  } finally {
    _inFlight = null;
    notifySettingsDocument();
  }
}

/**
 * Remove an extension from `project.json`, leaving its package installed.
 *
 * Turning something off is always safe, so this refuses nothing but a no-op — including on a
 * backend that reports the extension as unrunnable, which is the case where being able to remove it
 * matters most.
 *
 * @param {string} specifier
 * @returns {Promise<void>}
 */
export async function disableExtension(specifier: string): Promise<void> {
  if (_inFlight !== null) {
    throw new Error(`Another extension operation is running (${_inFlight}).`);
  }
  const current = enabledSpecifiers();
  if (!current.includes(specifier)) {
    return;
  }
  _inFlight = specifier;
  notifySettingsDocument();
  try {
    await updateSiteConfig({ extensions: current.filter((entry) => entry !== specifier) });
  } finally {
    _inFlight = null;
    notifySettingsDocument();
  }
}

/**
 * Uninstall an extension's package.
 *
 * Refuses while `project.json` still names it, because removing the package under a live
 * `extensions` entry produces precisely the enabled-but-missing state that fails the next build.
 * §12.4's rule: the strict member's refusal is evidence the write is unsafe, so the loose member
 * must not do it anyway.
 *
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function removeExtensionPackage(name: string): Promise<void> {
  if (enabledSpecifiers().includes(name)) {
    throw new RangeError(
      `command "packages.remove" argument "package": "${name}" is still enabled in project.json ` +
        `"extensions" — disable it first, or the next build will fail on a missing package.`,
    );
  }
  if (_inFlight !== null) {
    throw new Error(`Another extension operation is running (${_inFlight}).`);
  }
  _inFlight = name;
  notifySettingsDocument();
  try {
    await getPlatform().removePackage(name);
    // A toast, unlike enable/disable: this one leaves no Activity entry behind, and it is
    // Destructive and not undoable, so silence would be the wrong report.
    notify.success(`Removed ${name}.`);
  } finally {
    _inFlight = null;
    notifySettingsDocument();
  }
}

/** The three records, for `appCommandSet()` and the bootstrap registry. */
export function extensionCommands(): AnyCommand[] {
  return [
    {
      args: argsSchema({
        package: derivedEnumProperty(
          enableable,
          'The extension package to turn on, e.g. "@jxsuite/parser". A package that is not ' +
            "installed is installed first.",
        ),
      }),
      category: "Project",
      group: "7_settings_extensions",
      id: "project.enableExtension",
      level: "project",
      menus: ["palette"],
      requires: "an open project",
      enablement: (ctx) => ctx.project.open,
      /*
       * `none`, not `project`. The `project.json` half IS a transaction and ⌘Z takes it back, but
       * the install is not — a record claiming `project` would promise an undo that leaves the
       * package on disk.
       */
      undo: "none",
      aiTool: {
        description:
          "Turn on a Jx extension for this project: install its npm package if it is missing and " +
          'add it to project.json "extensions". Enable an extension BEFORE writing the ' +
          "project.json section it owns, because a section belonging to a disabled extension is a " +
          "schema error. Installing is not undoable.",
        name: "enable_extension",
      },
      run: async (_ctx, args) =>
        enableExtension(stringArg("project.enableExtension", args, "package")),
      title: "Enable Extension",
    },
    {
      args: argsSchema({
        package: derivedEnumProperty(
          enabledSpecifiers,
          "The extension to turn off. Its npm package stays installed.",
        ),
      }),
      category: "Project",
      group: "7_settings_extensions",
      id: "project.disableExtension",
      level: "project",
      menus: ["palette"],
      requires: "an open project",
      enablement: (ctx) => ctx.project.open,
      undo: "project",
      aiTool: {
        description:
          'Remove an extension from project.json "extensions". Its npm package stays installed, ' +
          "and the settings sections it contributed disappear. Remove any project.json sections " +
          "it owns first, or the configuration will not validate.",
        name: "disable_extension",
      },
      run: async (_ctx, args) =>
        disableExtension(stringArg("project.disableExtension", args, "package")),
      title: "Disable Extension",
    },
    {
      args: argsSchema({
        package: stringProperty("The npm package to uninstall from this project."),
      }),
      category: "Project",
      destructive: true,
      group: "9_danger",
      id: "packages.remove",
      level: "project",
      menus: ["palette"],
      requires: "an open project",
      enablement: (ctx) => ctx.project.open,
      undo: "none",
      /*
       * Deliberately no `aiTool`. §12.4 binds an agent tool that WRITES what a command writes to
       * the command's rule; it does not require every command to have one. The model has no read
       * that tells it whether a dependency is load-bearing elsewhere in the project, so it cannot
       * form the judgement this verb needs, and the act is destructive and not undoable.
       */
      run: async (_ctx, args) =>
        removeExtensionPackage(stringArg("packages.remove", args, "package")),
      title: "Remove Package",
    },
  ];
}

/**
 * Register the three records.
 *
 * @param {CommandRegistry} registry
 */
export function registerExtensionCommands(registry: CommandRegistry): void {
  registry.registerAll(extensionCommands());
}
