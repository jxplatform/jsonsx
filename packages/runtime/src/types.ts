/// <reference lib="dom" />
import type { JxPath } from "@jxsuite/schema/types";
export type { JxPath };

export interface JxRenderOptions {
  _path?: JxPath;
  onNodeCreated?: (el: HTMLElement | Text, path: JxPath, def: Record<string, unknown>) => void;
}

export interface DynamicClass {
  new (config?: Record<string, unknown>): Record<string, unknown>;
  [key: string]: unknown;
  prototype: Record<string, unknown>;
}
