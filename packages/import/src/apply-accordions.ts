/**
 * Turn a recognised framework accordion into native `<details name>`, preserving every node.
 *
 * The importer used to carry an accordion across as inert markup: the framework's directives
 * survived as text, nothing was left to execute them, and the closed rows kept the `hidden`
 * attribute and `display: none` the capture found them under. On the reference corpus that trapped
 * 178 elements of real content behind widgets that could never open again.
 *
 * `<details name="…">` is the whole answer for this shape. Same-named details are mutually
 * exclusive natively, which is what the source accordion's single scalar state meant, so the
 * behaviour is preserved rather than approximated. It needs no runtime, no component state and no
 * expressions — it prerenders, it is keyboard accessible, and there is nothing left to wire wrong.
 *
 * **The transform MOVES nodes; it never rebuilds them.** Every original element is reparented, not
 * recreated, and {@link countLeaves} checks the leaf census across the rewrite. A mismatch abandons
 * the whole widget and leaves the markup exactly as it was — losing a paragraph is far worse than
 * failing to modernise a widget, so the invariant is enforced rather than trusted.
 *
 * Bound to no framework: everything structural comes from `toggle-algebra.ts`, which reads the
 * open/closed logic out of attribute values without naming Alpine, Vue or anything else.
 */

import type { JxElement } from "@jxsuite/schema/types";
import { roleOfElement } from "./toggle-algebra.ts";
import type { ToggleRole } from "./toggle-algebra.ts";

/**
 * Attribute-name prefixes belonging to a client framework the clone does not ship.
 *
 * Left in place they are dead weight that nothing warns about: no attribute allowlist exists in the
 * schema, and the compiler emits any string attribute verbatim, so a stale `x-show` travels all the
 * way into the built site. `on*` is included only for STRING values, because a Jx handler is always
 * an object and so cannot be hit by this.
 */
const DEAD_DIRECTIVE_PREFIXES = ["x-", "@", ":", "v-", "wire:", "data-wp-", "hx-", "data-bs-"];

/** Attributes that conceal a node, and mean nothing once `<details>` owns the open state. */
const CONCEALING_ATTRIBUTES = new Set(["hidden", "inert", "aria-hidden"]);

/** Style declarations that were the widget's closed state rather than its design. */
const CONCEALING_STYLE = new Set(["display", "height", "maxHeight", "overflow", "visibility"]);

/** Names that must survive whatever else is stripped. */
const PROTECTED_ATTRIBUTES = new Set(["id", "role", "href", "src", "alt", "class", "title"]);

function isDeadDirective(name: string, value: unknown): boolean {
  if (PROTECTED_ATTRIBUTES.has(name) || name.startsWith("aria-")) {
    return false;
  }
  if (name.startsWith("on") && typeof value === "string") {
    return true;
  }
  return DEAD_DIRECTIVE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A node's children as a plain array.
 *
 * `children` may also be a `$prototype: "Array"` repeater rather than a list, and a repeater has no
 * literal rows to read. Treating one as empty is right for this pass: a widget whose rows are
 * generated cannot have per-row toggle keys in its markup, so it could never close the algebra
 * anyway, and returning nothing makes it fall through untouched.
 */
function childrenOf(node: JxElement): (JxElement | string)[] {
  return Array.isArray(node.children) ? (node.children as (JxElement | string)[]) : [];
}

/**
 * The content census of a subtree: every text run and every media element it holds.
 *
 * This is what the rewrite is checked against. Counting nodes would not do — a rewrite legitimately
 * adds a `<details>` and a `<summary>` — but the LEAVES are exactly what a reader loses if the
 * transform goes wrong, so they must be conserved exactly.
 *
 * @param {JxElement | string} node
 * @returns {string[]} One entry per leaf, sorted, so ordering changes do not read as loss
 */
export function countLeaves(node: JxElement | string): string[] {
  const leaves: string[] = [];
  const visit = (current: JxElement | string): void => {
    if (typeof current === "string") {
      if (current.trim().length > 0) {
        leaves.push(`t:${current.trim()}`);
      }
      return;
    }
    if (typeof current.textContent === "string" && current.textContent.trim().length > 0) {
      leaves.push(`t:${current.textContent.trim()}`);
    }
    const source = (current.attributes as Record<string, unknown> | undefined)?.["src"];
    if (typeof source === "string") {
      leaves.push(`m:${source}`);
    }
    for (const child of childrenOf(current)) {
      visit(child);
    }
  };
  visit(node);
  return leaves.toSorted();
}

/** Remove dead framework directives and concealment from one node, in place. */
function cleanNode(node: JxElement, unconceal: boolean): void {
  const attributes = node.attributes as Record<string, unknown> | undefined;
  if (attributes) {
    for (const name of Object.keys(attributes)) {
      if (isDeadDirective(name, attributes[name])) {
        delete attributes[name];
      } else if (unconceal && CONCEALING_ATTRIBUTES.has(name)) {
        delete attributes[name];
      }
    }
  }
  if (unconceal && node.style) {
    const style = node.style as Record<string, unknown>;
    for (const property of Object.keys(style)) {
      if (CONCEALING_STYLE.has(property)) {
        delete style[property];
      }
    }
  }
}

/** Strip directives from a whole subtree; only the row's own body is unconcealed. */
function cleanSubtree(node: JxElement | string, unconceal: boolean): void {
  if (typeof node === "string") {
    return;
  }
  cleanNode(node, unconceal);
  for (const child of childrenOf(node)) {
    cleanSubtree(child, false);
  }
}

interface RowParts {
  row: JxElement;
  title: JxElement;
  body: JxElement;
  key: string;
}

/** The first descendant-or-self whose role matches, depth-first, narrowed to the kind asked for. */
function findRole<K extends ToggleRole["kind"]>(
  node: JxElement,
  idents: ReadonlySet<string>,
  want: K,
): { node: JxElement; role: Extract<ToggleRole, { kind: K }> } | null {
  const role = roleOfElement(node.attributes as Record<string, unknown> | undefined, idents);
  if (role?.kind === want) {
    return { node, role: role as Extract<ToggleRole, { kind: K }> };
  }
  for (const child of childrenOf(node)) {
    if (typeof child === "string") {
      continue;
    }
    const found = findRole(child, idents, want);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Read the rows out of a candidate root, or null when the algebra does not close.
 *
 * Closure is the safety property. Every row must contribute exactly one toggle and one predicate
 * over the SAME declared ident, and their keys must agree and be unique across the widget. Anything
 * looser — a stray predicate, two rows claiming one key, a toggle over an ident nobody declared —
 * means this is not the widget it looks like, and nothing is rewritten.
 */
export function readAccordionRows(root: JxElement, idents: ReadonlySet<string>): RowParts[] | null {
  const rows: RowParts[] = [];
  const seenKeys = new Set<string>();

  for (const child of childrenOf(root)) {
    if (typeof child === "string") {
      if (child.trim().length > 0) {
        return null;
      }
      continue;
    }
    const row = child as JxElement;
    const toggle = findRole(row, idents, "assign");
    const predicate = findRole(row, idents, "compare");
    if (!toggle || !predicate) {
      return null;
    }
    const { role: toggleRole } = toggle;
    const { role: predicateRole } = predicate;
    if (
      toggleRole.ident !== predicateRole.ident ||
      toggleRole.key !== predicateRole.key ||
      !idents.has(toggleRole.ident) ||
      seenKeys.has(toggleRole.key)
    ) {
      return null;
    }
    seenKeys.add(toggleRole.key);
    rows.push({ body: predicate.node, key: toggleRole.key, row, title: toggle.node });
  }

  return rows.length >= 2 ? rows : null;
}

/** A stable, readable `name` so one widget's rows are mutually exclusive and another's are not. */
function groupName(ident: string, index: number): string {
  const base = ident
    .replaceAll(/[^a-zA-Z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase();
  return `${base || "disclosure"}-${index}`;
}

/**
 * Rewrite one candidate root's rows into `<details name>`, or return false to leave it alone.
 *
 * The row element itself becomes the `<details>` — keeping its attributes, classes and styles — so
 * the site's own spacing and borders survive. Its title subtree moves inside a `<summary>` and its
 * body subtree follows, both intact.
 */
function rewriteRoot(
  root: JxElement,
  rows: readonly RowParts[],
  idents: ReadonlySet<string>,
  index: number,
): boolean {
  const before = countLeaves(root);
  const name = groupName([...idents][0] ?? "disclosure", index);
  const rewritten: JxElement[] = [];

  for (const { row, title, body } of rows) {
    cleanSubtree(row, false);
    cleanNode(body, true);

    const summary: JxElement = { children: [title] as JxElement[], tagName: "summary" };
    const others = childrenOf(row).filter(
      (child) => child !== title && child !== body,
    ) as JxElement[];

    rewritten.push({
      ...row,
      attributes: { ...(row.attributes as Record<string, string>), name },
      children: [summary, body, ...others] as JxElement[],
      tagName: "details",
    });
  }

  const candidate: JxElement = { ...root, children: rewritten };

  /* The invariant, enforced rather than trusted: if a single text run or image would go missing,
     abandon the widget entirely. A stale accordion is a much smaller defect than a deleted
     paragraph, so this failure mode is the safe one. */
  if (countLeaves(candidate).join(" ") !== before.join(" ")) {
    return false;
  }

  root.children = rewritten;
  cleanNode(root, false);
  return true;
}

export interface AccordionResult {
  /** How many widgets were converted. */
  converted: number;
  /** How many rows those widgets held. */
  rows: number;
}

/**
 * Convert every recognisable accordion in a page tree to native `<details name>`.
 *
 * Runs on the per-page tree BEFORE layout detection, because that step replaces the pages it
 * extracts a layout from — a pass placed after it would see a site's widgets in neither.
 *
 * @param {JxElement} root - The page tree, mutated in place
 * @returns {AccordionResult}
 */
export function applyAccordions(root: JxElement): AccordionResult {
  const result: AccordionResult = { converted: 0, rows: 0 };
  let index = 0;

  const visit = (node: JxElement): void => {
    const role = roleOfElement(node.attributes as Record<string, unknown> | undefined);
    if (role?.kind === "declare") {
      const idents = new Set(role.idents.keys());
      const rows = readAccordionRows(node, idents);
      if (rows && rewriteRoot(node, rows, idents, index)) {
        index += 1;
        result.converted += 1;
        result.rows += rows.length;
        return;
      }
    }
    for (const child of childrenOf(node)) {
      if (typeof child !== "string") {
        visit(child);
      }
    }
  };

  visit(root);
  return result;
}
