/**
 * Turn a control that says it expands something into a real `<details>`.
 *
 * This is the reading that needs no framework knowledge at all: a site that ships correct
 * accessibility markup has already told us which control opens which panel, in `aria-expanded` plus
 * `aria-controls`, and that contract is identical across Bootstrap, jQuery, Webflow and
 * hand-written markup. Where `toggle-algebra.ts` recognises the Alpine and Vue family by the shape
 * of their expressions, this recognises everything that ships WAI-ARIA, which is most of the rest.
 *
 * The panel is concealed and the script that would reveal it is gone, so the content is on disk and
 * unreachable — the single largest body of trapped text on the reference corpus.
 *
 * **A disclosure is not an overlay, and the difference is the flow.** `apply-popovers.ts` claims a
 * concealed panel that is positioned, because being lifted out of the flow is what makes a thing
 * draw ON TOP. A concealed panel still IN the flow is content that belongs where it sits and simply
 * is not shown yet, which is exactly what `<details>` means. The two passes are disjoint by that
 * test rather than by ordering luck.
 *
 * The rewrite MOVES both subtrees and conserves the leaf census, on the same terms as
 * `apply-accordions.ts`: a stale widget is a far smaller defect than deleted content, so a rewrite
 * that would lose a text run or an image is abandoned whole.
 */

import type { JxElement } from "@jxsuite/schema/types";
import { countLeaves } from "./apply-accordions.ts";

/** Attributes that made the old control a control, and mean nothing once `<summary>` is one. */
const CONTROL_ATTRIBUTES = ["aria-expanded", "aria-controls", "role", "tabindex"];

/** A panel lifted out of the flow is an overlay, and belongs to the popover pass instead. */
const POSITIONED = new Set(["absolute", "fixed"]);

function attributesOf(node: JxElement): Record<string, unknown> | undefined {
  return node.attributes as Record<string, unknown> | undefined;
}

function childrenOf(node: JxElement): (JxElement | string)[] {
  return Array.isArray(node.children) ? (node.children as (JxElement | string)[]) : [];
}

function elementChildren(node: JxElement): JxElement[] {
  return childrenOf(node).filter((child) => typeof child !== "string") as JxElement[];
}

/** Whether this control declares that it expands a named panel. */
export function isDisclosureInvoker(node: JxElement): boolean {
  const attributes = attributesOf(node);
  if (!attributes) {
    return false;
  }
  const controls = attributes["aria-controls"];
  return (
    attributes["aria-expanded"] !== undefined && typeof controls === "string" && controls.length > 0
  );
}

/**
 * Whether this panel is closed content in the flow, rather than an overlay or ordinary content.
 *
 * The corpus's panels carry no style at all: they are hidden by the `hidden` ATTRIBUTE, which is
 * why a detector looking only at computed style would miss every one of them.
 */
export function isDisclosurePanel(node: JxElement): boolean {
  const style = node.style as Record<string, unknown> | undefined;
  if (POSITIONED.has(String(style?.["position"] ?? ""))) {
    return false;
  }
  const attributes = attributesOf(node);
  return attributes?.["hidden"] !== undefined || style?.["display"] === "none";
}

/** Every element carrying an `id`, so `aria-controls` can be resolved. */
function indexById(root: JxElement): Map<string, JxElement> {
  const index = new Map<string, JxElement>();
  const visit = (node: JxElement): void => {
    const id = attributesOf(node)?.["id"];
    if (typeof id === "string" && !index.has(id)) {
      index.set(id, node);
    }
    for (const child of elementChildren(node)) {
      visit(child);
    }
  };
  visit(root);
  return index;
}

/**
 * What an element actually holds, whether that is children or a collapsed `textContent`.
 *
 * `htmlToJx` folds a lone text child into `textContent` and emits no `children` array at all, so a
 * control whose label is bare text — which is most of them — looks empty to a children-only reader.
 * Unwrapping one through `childrenOf` alone silently drops the label, and the leaf census then
 * abandons the whole rewrite. Correct, but the wrong outcome.
 */
function contentOf(node: JxElement): (JxElement | string)[] {
  const children = childrenOf(node);
  if (children.length > 0) {
    return children;
  }
  return typeof node.textContent === "string" && node.textContent.length > 0
    ? [node.textContent]
    : [];
}

/**
 * Replace the invoker element with its own children, wherever it sits inside `node`.
 *
 * `<summary>` IS the control once the rewrite lands, so leaving the old one inside it would nest an
 * interactive element in another. Unwrapping rather than deleting keeps the label text, which is
 * the only part of the control a reader ever saw. Safe here because these controls carry no `href`:
 * a real link would lose its destination and is refused before this point.
 */
function unwrapInvoker(node: JxElement, invoker: JxElement): JxElement {
  const children = childrenOf(node);
  if (children.length === 0) {
    return node;
  }
  const rebuilt: (JxElement | string)[] = [];
  for (const child of children) {
    if (child === invoker) {
      rebuilt.push(...contentOf(child as JxElement));
    } else if (typeof child === "string") {
      rebuilt.push(child);
    } else {
      rebuilt.push(unwrapInvoker(child as JxElement, invoker));
    }
  }
  return { ...node, children: rebuilt as JxElement[] };
}

export interface DisclosureResult {
  /** How many control/panel pairs became a `<details>`. */
  converted: number;
  /** Controls left pointing at a panel another control had already claimed. */
  duplicateInvokers: number;
}

/**
 * Convert every ARIA-declared disclosure in a page tree into `<details>`.
 *
 * @param {JxElement} root - The page tree, mutated in place
 * @returns {DisclosureResult}
 */
export function applyDisclosures(root: JxElement): DisclosureResult {
  const result: DisclosureResult = { converted: 0, duplicateInvokers: 0 };
  const byId = indexById(root);
  const claimedPanels = new Set<JxElement>();

  /*
   * Walk parents rather than invokers. The rewrite replaces TWO of a parent's children with one
   * `<details>`, so the parent is the unit of work — and the corpus puts the panel BEFORE the
   * control it belongs to ("… hidden extra copy … Read more"), so neither is reliably first.
   */
  const visit = (parent: JxElement): void => {
    for (;;) {
      const children = childrenOf(parent);
      let applied = false;

      for (let index = 0; index < children.length && !applied; index += 1) {
        const branch = children[index];
        if (typeof branch === "string") {
          continue;
        }

        const invoker = findInvokerIn(branch as JxElement);
        if (!invoker) {
          continue;
        }
        const panelId = String(attributesOf(invoker)!["aria-controls"]);
        const panel = byId.get(panelId);
        if (!panel || !isDisclosurePanel(panel)) {
          continue;
        }
        if (claimedPanels.has(panel)) {
          /* A second control for a panel already inside a `<details>` is now a lie to a screen
             reader: it reports a collapsed state it no longer governs. Strip what made it a
             control and leave the text. */
          const attributes = attributesOf(invoker)!;
          for (const name of CONTROL_ATTRIBUTES) {
            delete attributes[name];
          }
          result.duplicateInvokers += 1;
          continue;
        }

        const panelIndex = children.indexOf(panel);
        if (panelIndex === -1 || panelIndex === index) {
          continue;
        }

        const before = countLeaves(parent);
        const panelAttributes = { ...attributesOf(panel) };
        delete panelAttributes["hidden"];
        delete panelAttributes["aria-hidden"];

        /* When the control IS the branch, there is no enclosing element to unwrap it out of, so
           its own attributes would ride onto the `<summary>`. Stripping them here covers both
           shapes: `<summary>` is the control now, and a leftover `aria-expanded` on it would report
           a state the element no longer owns. */
        const summaryBranch = unwrapInvoker(branch as JxElement, invoker);
        const summaryAttributes = { ...attributesOf(summaryBranch) };
        for (const name of CONTROL_ATTRIBUTES) {
          delete summaryAttributes[name];
        }
        const summary: JxElement = {
          ...summaryBranch,
          ...(Object.keys(summaryAttributes).length > 0
            ? { attributes: summaryAttributes as Record<string, string> }
            : {}),
          tagName: "summary",
        };
        if (Object.keys(summaryAttributes).length === 0) {
          delete summary.attributes;
        }
        const details: JxElement = {
          children: [summary, { ...panel, attributes: panelAttributes }] as JxElement[],
          tagName: "details",
        };

        /* Placed where the FIRST of the pair sat, so the disclosure keeps the position the reader
           already associated with it. `<details>` always renders its summary above its content, so
           a panel that came first moves below the label it was always labelled by. */
        const rebuilt = children.filter((child) => child !== branch && child !== panel) as (
          | JxElement
          | string
        )[];
        rebuilt.splice(Math.min(index, panelIndex), 0, details);

        const candidate: JxElement = { ...parent, children: rebuilt as JxElement[] };
        if (countLeaves(candidate).join(" ") !== before.join(" ")) {
          continue;
        }

        parent.children = rebuilt as JxElement[];
        claimedPanels.add(panel);
        result.converted += 1;
        applied = true;
      }

      if (!applied) {
        break;
      }
    }

    for (const child of elementChildren(parent)) {
      visit(child);
    }
  };

  visit(root);
  return result;
}

/**
 * The first disclosure control at or under `node`, but never one already inside a `<details>`.
 *
 * Without that second condition a converted disclosure's own summary would be offered back as a
 * candidate on the next pass over the same parent, and the loop would not terminate.
 */
function findInvokerIn(node: JxElement): JxElement | null {
  if (String(node.tagName ?? "").toLowerCase() === "details") {
    return null;
  }
  if (isDisclosureInvoker(node)) {
    return node;
  }
  for (const child of elementChildren(node)) {
    const found = findInvokerIn(child);
    if (found) {
      return found;
    }
  }
  return null;
}
