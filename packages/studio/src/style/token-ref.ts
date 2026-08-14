/**
 * Token references — reading `var(--token)` as a binding, and rendering it as a chip.
 *
 * A style value that is exactly `var(--something)` is not a value, it is a reference to one. Raw
 * text says so only to a reader who already knows CSS: `var(--color-brand)` is eleven characters of
 * syntax around a name, and the thing the author actually wants to know — _which_ token, and what
 * it currently resolves to — is the part that is not shown. So a bound value renders as a **chip**
 * (plan §9.4), in the same vocabulary as the provenance chips shipped in P5: the token's friendly
 * name, and for a colour, its resolved swatch.
 *
 * The resolver follows a chain of references, because an alias token (`--color-accent:
 * var(--color-brand)`) is the normal way a palette is built and a chip that stopped at the first
 * hop would report `var(--color-brand)` as a colour.
 */

import { html } from "lit-html";
import { tokenLabel } from "./project-styles";

import type { JxStyle } from "@jxsuite/schema/types";
import type { TemplateResult } from "lit-html";

/** A value that is EXACTLY one `var()` reference — not `calc(var(--a) * 2)`, which is a value. */
const TOKEN_REF_RE = /^var\(\s*(--[\w-]+)\s*\)$/;

/** How many hops the resolver follows before it decides the chain is a cycle. */
const MAX_HOPS = 10;

/**
 * The token a value references, or null when the value is not a bare reference.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function tokenRefName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return TOKEN_REF_RE.exec(value)?.[1] ?? null;
}

/**
 * The reference form of a token name — the value written into a style field that follows it.
 *
 * @param {string} name
 * @returns {string}
 */
export function toTokenRef(name: string): string {
  return `var(${name})`;
}

/**
 * Follow a value's references to the concrete value at the end of the chain.
 *
 * Returns undefined when the chain leaves the style block (a token defined by a stylesheet the
 * editor cannot see) or loops back on itself. A caller shows the raw text in both cases: an
 * unresolvable reference is still a reference, and inventing a value for it would be worse than
 * saying nothing.
 *
 * @param {JxStyle | null | undefined} style
 * @param {string | number | null | undefined} value
 * @returns {string | number | undefined}
 */
export function resolveTokenValue(
  style: JxStyle | null | undefined,
  value: string | number | null | undefined,
): string | number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  let current: string | number = value;
  const seen = new Set<string>();
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const ref = tokenRefName(current);
    if (!ref) {
      return current;
    }
    if (seen.has(ref)) {
      return undefined;
    }
    seen.add(ref);
    const next = style?.[ref];
    if (typeof next !== "string" && typeof next !== "number") {
      return undefined;
    }
    current = next;
  }
  return undefined;
}

/**
 * Render a bound value as a chip: the referenced token's name, and — for a colour — the swatch it
 * resolves to. The `title` carries the full reference and its resolution, because the chip is
 * deliberately short and a reader who needs the literal must still be able to get it.
 *
 * The chip is not a control. Following it somewhere would be a second navigation contract on a
 * surface that already lists every token a scroll away, and a chip that looks clickable and is not
 * is the defect §6.2 removed from the collapsed-section dot.
 *
 * @param {string} name — the referenced token
 * @param {string | number | undefined} resolved — {@link resolveTokenValue} of the reference
 * @param {{ swatch?: boolean }} [opts] — `swatch` renders the resolved value as a colour chip
 * @returns {TemplateResult}
 */
export function renderTokenChip(
  name: string,
  resolved: string | number | undefined,
  opts: { swatch?: boolean } = {},
): TemplateResult {
  const shown = resolved === undefined ? "unresolved" : String(resolved);
  return html`
    <span class="style-token-chip" title="${toTokenRef(name)} → ${shown}">
      ${
        opts.swatch && resolved !== undefined
          ? html`<span
              class="style-token-chip-swatch"
              style="background:${String(resolved)}"
            ></span>`
          : ""
      }
      <span class="style-token-chip-label">${tokenLabel(name)}</span>
    </span>
  `;
}
