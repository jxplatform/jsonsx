/**
 * `replaceYStructure` — the diff-overflow escape hatch, and the one export here that needs yjs.
 *
 * The alignment and equality logic this file used to hold lives in {@link file://./diff-core.ts} and
 * is re-exported below, so every importer of `@jxsuite/collab/diff` is unchanged. It moved because
 * THIS file's `./schema.ts` import is a value import and `schema.ts` imports yjs, while `diff.ts`'s
 * own `import type * as Y` made it look otherwise: `diffDocs` and `deepEqual` are pure, and a
 * caller that wanted them — the studio's diff highlighting — had no way to take them without taking
 * a yjs-sized chunk with them.
 */

import type { JxMutableNode } from "@jxsuite/schema/types";
import { metaMap, structureMap, toYChildren } from "./schema.ts";
import type * as Y from "yjs";

export * from "./diff-core.ts";

/**
 * Hard-replace the structure tree with `document` (the diff-overflow escape hatch) and bump the
 * in-doc canonicalRev so stale mirror writes computed against the old tree are discarded.
 */
export function replaceYStructure(doc: Y.Doc, document: JxMutableNode, origin: unknown): void {
  doc.transact(() => {
    const structure = structureMap(doc);
    const next = document as Record<string, unknown>;
    // Detached copy: keys are deleted while iterating.
    const existingKeys = [...structure.keys()];
    for (const key of existingKeys) {
      if (!(key in next) || next[key] === undefined) {
        structure.delete(key);
      }
    }
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) {
        continue;
      }
      if (key === "children" && Array.isArray(value)) {
        structure.set(key, toYChildren(value));
      } else {
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON normalization is the point
        structure.set(key, JSON.parse(JSON.stringify(value)));
      }
    }
    const meta = metaMap(doc);
    meta.set("canonicalRev", Number(meta.get("canonicalRev") ?? 0) + 1);
  }, origin);
}
