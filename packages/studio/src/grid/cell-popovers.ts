/**
 * Popover cell editors — media paths and relationship pickers.
 *
 * These kinds bypass Tabulator's in-cell editor session entirely: their pickers render Spectrum
 * overlays OUTSIDE the cell, which Tabulator's range module treats as an outside interaction and
 * blur-cancels. Instead, a dblclick on the cell opens an anchored layer popover that writes
 * straight through the edit buffer via `commit`.
 */
import { html, nothing } from "lit-html";
import { renderPopover } from "../ui/layers";
import { renderMediaPicker } from "../ui/media-picker";
import { listCollectionEntryIds } from "./sources/content-source";
import { cellToText } from "./schema-columns";
import type { GridCellValue, GridColumn } from "./grid-source";

/** Whether this column edits through an anchored popover instead of an in-cell editor. */
export function hasPopoverEditor(column: GridColumn): boolean {
  return column.kind === "image" || column.kind === "reference";
}

/** Target content-type name of a relationship column (`#/content/<name>` on the schema). */
export function referenceTargetType(column: GridColumn): string | null {
  const ref = (column.schema as { $ref?: string } | undefined)?.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/content/")) {
    return null;
  }
  return ref.slice("#/content/".length);
}

export interface CellPopoverArgs {
  /** Viewport rect of the cell the popover anchors to. */
  anchor: { left: number; bottom: number };
  column: GridColumn;
  value: GridCellValue;
  /** Write the new value through the edit buffer (called on every pick/commit). */
  commit: (value: GridCellValue) => void;
}

function popoverShell(
  column: GridColumn,
  anchor: CellPopoverArgs["anchor"],
  body: unknown,
  dismiss: () => void,
) {
  const left = Math.max(4, Math.min(anchor.left, window.innerWidth - 340));
  const top = Math.max(4, Math.min(anchor.bottom + 2, window.innerHeight - 200));
  return html`<sp-popover
    open
    class="jx-grid-cell-popover"
    style="position:fixed;z-index:10000;left:${left}px;top:${top}px"
  >
    <div class="jx-grid-cell-popover-body">
      <div class="jx-grid-cell-popover-title">${column.title}</div>
      ${body}
      <div class="jx-grid-cell-popover-actions">
        <sp-button size="s" variant="secondary" @click=${dismiss}>Done</sp-button>
      </div>
    </div>
  </sp-popover>`;
}

/**
 * Open the popover editor for an image or reference cell. Resolves target-entry ids up front for
 * relationship columns so the picker renders complete.
 */
export async function openCellValuePopover(args: CellPopoverArgs): Promise<void> {
  const { anchor, column, commit, value } = args;
  const current = cellToText(value);

  let body;
  if (column.kind === "reference") {
    const targetType = referenceTargetType(column);
    const ids = targetType ? await listCollectionEntryIds(targetType) : [];
    body = html`
      ${targetType
        ? html`<div class="jx-grid-cell-popover-hint">Entries of “${targetType}”</div>`
        : nothing}
      <select
        class="jx-grid-select"
        @change=${(e: Event) => {
          const picked = (e.target as HTMLSelectElement).value;
          commit(picked === "" ? null : picked);
        }}
      >
        <option value="" ?selected=${current === ""}>—</option>
        ${ids.map((id) => html`<option value=${id} ?selected=${id === current}>${id}</option>`)}
      </select>
      <input
        class="jx-grid-input"
        placeholder="Custom id…"
        .value=${ids.includes(current) ? "" : current}
        @change=${(e: Event) => {
          const text = (e.target as HTMLInputElement).value.trim();
          commit(text === "" ? null : text);
        }}
      />
    `;
  } else {
    body = renderMediaPicker(column.field, current, (val) => {
      commit(val === "" ? null : val);
    });
  }

  const handle = renderPopover(
    popoverShell(column, anchor, body, () => handle.dismiss()),
    { dismissOnOutsideClick: true },
  );
}
