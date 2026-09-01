/**
 * Popover correctness over the document an author is editing.
 *
 * A second document report beside the accessibility one, and separate from it on purpose: an
 * `A11yFinding` is typed to a WCAG criterion, and none of these are WCAG failures. A popover whose
 * base rule sets `display` is not inaccessible, it is BROKEN — laid out on every page whether or
 * not anyone opened it — and forcing that into a criterion field would be a lie in the report's own
 * vocabulary. `popover-unnamed` is the one finding that genuinely IS a WCAG matter, and it belongs
 * to `a11y-report.ts` rather than here.
 *
 * The rules themselves live in `@jxsuite/schema/overlays`, not in this file. Three surfaces judge
 * the same documents — this report, `jx build`, and the starter conformance test — and three copies
 * of "what is wrong with a popover" is three chances for them to disagree with each other in front
 * of an author.
 *
 * **Every finding that can be repaired carries the command that repairs it** (ATAG 2.0 B.3.2), and
 * the ones that cannot carry none. "Point this invoker at the right panel" has no mechanical answer
 * — which panel is the author's decision — so that finding is a sentence, not a button. A button
 * that does not do what it says is worse than no button.
 *
 * @docs studio/interface/problems-and-progress
 */

import { activeTab } from "../workspace/workspace";
import { clearProblems, notify } from "./notify";
import {
  findPopoverDefects,
  popoverDisplayRepair,
  POPOVER_DEFAULT_MODE,
} from "@jxsuite/schema/overlays";
import {
  mutateUpdateAttribute,
  mutateUpdateNestedStyle,
  mutateUpdateNestedStylePath,
  mutateUpdateStyle,
  transactDoc,
} from "../tabs/transact";
import { getNodeAtPath } from "../state";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { JxElement, JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../state";
import type { PopoverFix } from "@jxsuite/schema/overlays";

/** The `source` every record here files under, so a re-run clears exactly its own. */
export const POPOVER_PROBLEM_SOURCE = "Popover";

/** The command that repairs each fix kind. A finding with no fix carries no action. */
const REPAIR_COMMAND: Record<PopoverFix, string> = {
  display: "document.repairPopoverDisplay",
  "open-display": "document.repairPopoverDisplay",
  invoker: "document.repairPopoverInvoker",
  mode: "document.repairPopoverMode",
};

/**
 * File every popover defect in `doc` as a Problem, replacing whatever this source filed before.
 *
 * @param doc The document to check.
 * @param path The document's project-relative path, for the Problem's file column.
 * @returns How many findings were filed.
 */
export function reportPopoverProblems(doc: JxElement, path?: string): number {
  clearProblems((record) => record.source === POPOVER_PROBLEM_SOURCE);
  const defects = findPopoverDefects(doc);
  for (const defect of defects) {
    const action = defect.fix === undefined ? undefined : REPAIR_COMMAND[defect.fix];
    notify(defect.severity, defect.message, {
      detail: defect.detail,
      /* Keyed by RULE AND PATH, not by rule alone: a header with two popovers can carry the same
         defect twice, and a key that collapsed them would report one and silently drop the other. */
      key: `popover.${defect.rule}.${defect.path.join("/")}`,
      source: POPOVER_PROBLEM_SOURCE,
      tier: "problem",
      ...(action === undefined ? {} : { action, actionArgs: { path: defect.path } }),
      ...(path === undefined ? {} : { path }),
    });
  }
  return defects.length;
}

/** Read the path argument a repair command was invoked with, or throw naming the command. */
function repairPath(id: string, args: Record<string, unknown> | undefined): JxPath {
  const path = args?.path;
  if (!Array.isArray(path)) {
    throw new RangeError(`command "${id}" needs a "path" argument naming the popover`);
  }
  return path as JxPath;
}

/** The active tab, or a refusal naming the command that needed one. */
function repairTab(id: string) {
  const tab = activeTab.value;
  if (!tab) {
    throw new RangeError(`command "${id}" needs an open document`);
  }
  return tab;
}

/**
 * The three repairs, and the registrar that keeps them out of a second definition site.
 *
 * Each one is a single `transactDoc`, so the whole move is ONE undo entry: an author who does not
 * like the result presses undo once, not three times.
 *
 * @returns The command records.
 */
export function popoverCommands(): AnyCommand[] {
  return [
    {
      category: "Document",
      group: "2_document",
      id: "document.checkPopovers",
      level: "document",
      menus: ["palette"],
      requires: "an open document",
      run: () => {
        const tab = repairTab("document.checkPopovers");
        const filed = reportPopoverProblems(tab.doc.document, tab.documentPath ?? undefined);
        notify.success(
          filed === 0
            ? "No popover problems found in this document."
            : `${filed} popover problem(s) filed.`,
          { key: "popover.run", source: POPOVER_PROBLEM_SOURCE },
        );
      },
      title: "Check Popovers",
      when: (ctx) => ctx.document.open,
      aiTool: {
        description:
          "Check the open document for popover defects an author can fix — a base-rule `display` " +
          "that defeats the browser's own hiding of a closed popover, `popovertarget` on an " +
          "element that cannot invoke, a target naming no popover, a cut exit animation — and " +
          "file each as a Problem.",
        name: "check_popovers",
      },
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          path: { items: { type: ["string", "number"] }, type: "array" },
        },
        required: ["path"],
        type: "object",
      },
      category: "Document",
      group: "2_document",
      id: "document.repairPopoverDisplay",
      level: "document",
      menus: [],
      requires: "a popover whose base rule sets display",
      run: (_ctx, args) => {
        const id = "document.repairPopoverDisplay";
        const tab = repairTab(id);
        const path = repairPath(id, args);
        const node = getNodeAtPath(tab.doc.document, path) as JxMutableNode | undefined;
        const repair = popoverDisplayRepair(node?.style);
        if (!repair) {
          throw new RangeError(`command "${id}": nothing to move — this popover sets no display`);
        }
        transactDoc(tab, (t) => {
          for (const prop of repair.base) {
            mutateUpdateStyle(t, path, prop, "");
          }
          for (const at of repair.breakpoints) {
            mutateUpdateNestedStylePath(t, path, [at], "display", "");
          }
          /* `openDisplay` is null when `:popover-open` already declares one. The open state is the
             author's intent and the base rule is the accident, so the existing value is kept. */
          if (repair.openDisplay !== null) {
            mutateUpdateNestedStyle(t, path, ":popover-open", "display", repair.openDisplay);
          }
        });
        notify.success("Moved `display` into `:popover-open`.", {
          key: "popover.repaired.display",
          source: POPOVER_PROBLEM_SOURCE,
        });
      },
      title: "Move display into :popover-open",
      when: (ctx) => ctx.document.open,
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          path: { items: { type: ["string", "number"] }, type: "array" },
        },
        required: ["path"],
        type: "object",
      },
      category: "Document",
      group: "2_document",
      id: "document.repairPopoverInvoker",
      level: "document",
      menus: [],
      requires: "an element carrying popovertarget that cannot invoke",
      run: (_ctx, args) => {
        const id = "document.repairPopoverInvoker";
        const tab = repairTab(id);
        const path = repairPath(id, args);
        /* REMOVES rather than converting the element to a <button>. The two attributes do nothing
           where they are, so removing them changes no behaviour and tells the truth; turning a link
           into a button changes the page, and which of the two the author wants is not knowable
           from here. */
        transactDoc(tab, (t) => {
          mutateUpdateAttribute(t, path, "popovertarget");
          mutateUpdateAttribute(t, path, "popovertargetaction");
        });
        notify.success("Removed the attributes, which did nothing on this element.", {
          key: "popover.repaired.invoker",
          source: POPOVER_PROBLEM_SOURCE,
        });
      },
      title: "Remove the inert popover attributes",
      when: (ctx) => ctx.document.open,
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          path: { items: { type: ["string", "number"] }, type: "array" },
        },
        required: ["path"],
        type: "object",
      },
      category: "Document",
      group: "2_document",
      id: "document.repairPopoverMode",
      level: "document",
      menus: [],
      requires: "a popover whose mode is not one of the three keywords",
      run: (_ctx, args) => {
        const id = "document.repairPopoverMode";
        const tab = repairTab(id);
        const path = repairPath(id, args);
        transactDoc(tab, (t) => {
          mutateUpdateAttribute(t, path, "popover", POPOVER_DEFAULT_MODE);
        });
        notify.success(`Set \`popover\` to "${POPOVER_DEFAULT_MODE}".`, {
          key: "popover.repaired.mode",
          source: POPOVER_PROBLEM_SOURCE,
        });
      },
      title: "Set popover to auto",
      when: (ctx) => ctx.document.open,
    },
  ];
}

/**
 * Register them on a live registry.
 *
 * A registrar as well as a factory, for the reason `a11y-report.ts` gives: `appCommandSet()` and
 * the running app are two different code paths, and a record in one and not the other is a command
 * CI counts and the app cannot run.
 *
 * @param registry The registry to register into.
 */
export function registerPopoverCommands(registry: CommandRegistry): void {
  registry.registerAll(popoverCommands());
}
