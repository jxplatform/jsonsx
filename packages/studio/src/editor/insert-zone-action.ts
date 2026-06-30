/// <reference lib="dom" />
/**
 * Insert-zone-action.ts — the click handler for the cross-origin insertion "+" affordance.
 *
 * Extracted verbatim from the studio.ts bootstrap so it can carry its own unit test (the inline
 * arrow form added two uncovered anonymous functions to the hard-to-test bootstrap). Registered by
 * name via `setInsertZoneClickHandler(runInsertZoneAction)` in studio.ts.
 *
 * The cross-origin insertion "+" (drawn by the host from posted zones) runs the parent-realm
 * slash-menu → mutateInsertNode flow on click. The host captured the zone (parentPath + index); the
 * new node is selected at its inserted path. Salvaged from the orphaned insertion-helper.ts.
 */

import { showSlashMenu } from "./slash-menu";
import { defaultDef } from "../panels/shared";
import { mutateInsertNode, transactDoc } from "../tabs/transact";
import { activeTab } from "../workspace/workspace";
import type { InsertZone } from "../canvas/iframe-protocol";
import type { JxPath } from "../state";

export function runInsertZoneAction(btn: HTMLElement, zone: InsertZone): void {
  showSlashMenu(btn, "", {
    onSelect: (cmd) => {
      const def = defaultDef(cmd.tag);
      const insertPath = zone.insertParentPath as JxPath;
      const idx = zone.index;
      const newPath = [...insertPath, "children", idx];
      transactDoc(activeTab.value, (t) => {
        mutateInsertNode(t, insertPath, idx, def);
        t.session.selection = newPath;
      });
    },
    showFilter: true,
  });
}
