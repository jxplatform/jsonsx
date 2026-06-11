/// <reference lib="dom" />
import type { JxElement, JxPath } from "@jxsuite/schema/types";

export type { JxPath };

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
  onNodeCreated?: (el: HTMLElement | Text, path: JxPath, def: JxElement | string) => void;
}

export interface DynamicClass {
  new (config?: Record<string, unknown>): Record<string, unknown>;
  [key: string]: unknown;
  prototype: Record<string, unknown>;
}
