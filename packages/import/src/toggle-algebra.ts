/**
 * Read a widget's open/closed logic out of its attribute VALUES, without knowing the framework.
 *
 * An imported accordion arrives as inert text. The site drove it with a client framework, the
 * capture strips scripts, and what survives is markup carrying directives nothing will ever
 * execute: on the reference corpus, 174 `x-show` / `@click` / `x-collapse` attributes against 17
 * surviving roots and no runtime, with 178 elements left permanently `hidden` over real content.
 *
 * The obvious detector is a signal list — `aria-expanded`, `aria-controls`, `role="tabpanel"`. It
 * does not work. The corpus's accordions carry NO ARIA at all: their only markers are class names
 * and framework directives, so a ranked ARIA list scores them zero. And enumerating the directives
 * instead just moves the problem, because the next site brings a different vocabulary.
 *
 * So this reads the ALGEBRA rather than the vocabulary. Three shapes appear in the value of any
 * attribute, whatever it is called:
 *
 * - **DECLARE** — an object literal of `ident: literal` pairs. The widget's state, named.
 * - **ASSIGN** — `ident = (ident === K ? <closed> : K)`, or `ident = !ident`. A toggle.
 * - **COMPARE** — `ident === K`, or a bare `ident`. A visibility predicate.
 *
 * A widget is recognised when those three agree with each other and with the repeated structure:
 * one ident, declared once, whose assignment keys are in bijection with the rows that compare
 * against them. That is true of Alpine, Vue, Petite-Vue and Livewire alike, and it never names any
 * of them.
 *
 * **It fails closed, and its limits are real.** Bootstrap, jQuery, Webflow and Squarespace bind in
 * JavaScript against selectors or opaque ids, and contribute nothing here — those need the ARIA
 * rules, which they ship correctly. When the algebra does not close, nothing is rewritten.
 */

/** A JavaScript identifier, which is what every one of these shapes is built around. */
const IDENT = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;

/** The literals a row key may be. A key is compared and assigned, so it has to be primitive. */
const KEY = String.raw`-?\d+|'[^']*'|"[^"]*"`;

/** The values that mean "nothing is open" on the closing side of a toggle. */
const CLOSED = String.raw`null|undefined|-1|''|""|false`;

const DECLARE_RE = /^\s*\{\s*(.+?)\s*\}\s*$/s;
const DECLARE_PAIR_RE = new RegExp(String.raw`^\s*(${IDENT})\s*:\s*(.+?)\s*$`);

/** `ident = (ident === K ? null : K)` — exclusive toggle, parentheses optional. */
const ASSIGN_KEYED_RE = new RegExp(
  String.raw`^\s*(${IDENT})\s*=\s*\(?\s*\1\s*===\s*(${KEY})\s*\?\s*(?:${CLOSED})\s*:\s*(${KEY})\s*\)?\s*;?\s*$`,
);

/** `ident = !ident` — a plain boolean disclosure. */
const ASSIGN_BOOL_RE = new RegExp(String.raw`^\s*(${IDENT})\s*=\s*!\s*\1\s*;?\s*$`);

/** `ident === K` — the predicate a row's body is shown under. */
const COMPARE_KEYED_RE = new RegExp(String.raw`^\s*(${IDENT})\s*===\s*(${KEY})\s*$`);

/** A bare `ident`, the boolean form of the same predicate. */
const COMPARE_BOOL_RE = new RegExp(String.raw`^\s*(${IDENT})\s*$`);

/**
 * The one key a boolean widget has, so keyed and boolean forms share a shape.
 *
 * `#` cannot begin a bare numeric key, so this cannot collide with a real one.
 */
export const BOOLEAN_KEY = "#boolean";

export type ToggleRole =
  | { kind: "declare"; idents: Map<string, string> }
  | { kind: "assign"; ident: string; key: string }
  | { kind: "compare"; ident: string; key: string };

/** Normalize a key literal so `0`, `'0'` and `"0"` are the same row. */
function normalizeKey(raw: string): string {
  const quoted = raw.match(/^['"](.*)['"]$/);
  return quoted ? quoted[1]! : raw.trim();
}

/**
 * Classify one attribute value, or null when it is not part of a toggle.
 *
 * Order matters: DECLARE first, because `{ open: null }` matches nothing else; then the keyed
 * forms, because a bare identifier is the loosest shape here.
 *
 * `knownIdents` is what makes the bare form safe, and it is not optional in spirit. A lone
 * identifier is a valid predicate for a boolean widget (`x-show="show_more"`) and is ALSO what
 * `id="x"`, `class="hero"` and `target="_blank"` look like. Read context-free it matches half the
 * attributes on a page. So a bare identifier is only a predicate when it names state something
 * already declared — which is the closure requirement the whole algebra rests on, applied at the
 * one place it would otherwise leak.
 *
 * @param {string} value - The raw attribute value
 * @param {ReadonlySet<string>} [knownIdents] - Idents a DECLARE in scope has introduced
 * @returns {ToggleRole | null}
 */
export function classifyToggleValue(
  value: string,
  knownIdents?: ReadonlySet<string>,
): ToggleRole | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const declare = value.match(DECLARE_RE);
  if (declare) {
    const idents = new Map<string, string>();
    for (const part of declare[1]!.split(",")) {
      const pair = part.match(DECLARE_PAIR_RE);
      if (!pair) {
        return null;
      }
      idents.set(pair[1]!, pair[2]!);
    }
    return idents.size > 0 ? { idents, kind: "declare" } : null;
  }

  const keyedAssign = value.match(ASSIGN_KEYED_RE);
  if (keyedAssign && normalizeKey(keyedAssign[2]!) === normalizeKey(keyedAssign[3]!)) {
    return { ident: keyedAssign[1]!, key: normalizeKey(keyedAssign[2]!), kind: "assign" };
  }

  const boolAssign = value.match(ASSIGN_BOOL_RE);
  if (boolAssign) {
    return { ident: boolAssign[1]!, key: BOOLEAN_KEY, kind: "assign" };
  }

  const keyedCompare = value.match(COMPARE_KEYED_RE);
  if (keyedCompare) {
    return { ident: keyedCompare[1]!, key: normalizeKey(keyedCompare[2]!), kind: "compare" };
  }

  const boolCompare = value.match(COMPARE_BOOL_RE);
  if (boolCompare && knownIdents?.has(boolCompare[1]!)) {
    return { ident: boolCompare[1]!, key: BOOLEAN_KEY, kind: "compare" };
  }

  return null;
}

/**
 * The strongest role among an element's attribute values.
 *
 * An element carries several directives at once — the corpus's accordion body has `x-show`,
 * `x-collapse.duration.250ms` and `hidden` together — and only one of them is the predicate. A
 * declaration outranks a toggle, which outranks a predicate, because that is the order in which
 * they identify the node: a root, then a control, then a panel.
 *
 * @param {Record<string, unknown> | undefined} attributes
 * @param {ReadonlySet<string>} [knownIdents] - Idents a DECLARE in scope has introduced
 * @returns {ToggleRole | null}
 */
export function roleOfElement(
  attributes: Record<string, unknown> | undefined,
  knownIdents?: ReadonlySet<string>,
): ToggleRole | null {
  if (!attributes) {
    return null;
  }
  const rank = { assign: 1, compare: 2, declare: 0 };
  let best: ToggleRole | null = null;
  for (const value of Object.values(attributes)) {
    if (typeof value !== "string") {
      continue;
    }
    const role = classifyToggleValue(value, knownIdents);
    if (role && (best === null || rank[role.kind] < rank[best.kind])) {
      best = role;
    }
  }
  return best;
}
