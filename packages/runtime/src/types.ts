/// <reference lib="dom" />
import type { JxElement, JxPath } from "@jxsuite/schema/types";

export type { JxPath } from "@jxsuite/schema/types";

/**
 * The live reactive scope: a prototype-chained object whose keys are user-defined state names.
 * Values are runtime JS values (signals, functions, JSON data) and must be narrowed at use — this
 * alias marks the dynamic boundary by name.
 */
export type JxScope = Record<string, unknown>;

/** An event handler stored in the scope: `(scope, event) => void`. */
export type JxEventHandler = (scope: JxScope, event: Event) => unknown;

export interface JxRenderOptions {
  _path?: JxPath;
  /**
   * Base URL the document's own references resolve against — `$ref`, `$elements`, `$head` and the
   * asset paths beneath them.
   *
   * Only {@link Jx} reads it, and only when it was handed a document OBJECT rather than a URL. A URL
   * carries its own base; an object does not, so the base defaulted to `location.href` — which is
   * right for a page served at the project root and wrong everywhere else. A host that composes a
   * document server-side and serves it at `/blog/hello/` needs to say that its references are still
   * root-relative, or every one of them resolves a directory too deep.
   */
  base?: string;
  /** The namespace the parent element established — SVG and MathML descendants inherit it. */
  _ns?: string | null;
  /**
   * Called for each created node. `state` is the local scope the node's children render with —
   * callers can capture it to re-render a subtree in isolation later.
   */
  onNodeCreated?: (
    el: HTMLElement | Text,
    path: JxPath,
    def: JxElement | string,
    state?: JxScope,
  ) => void;
}

export interface DynamicClass {
  new (config?: Record<string, unknown>): Record<string, unknown>;
  [key: string]: unknown;
  prototype: Record<string, unknown>;
}
