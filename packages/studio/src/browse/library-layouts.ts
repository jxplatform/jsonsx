/// <reference lib="dom" />
/**
 * The Library's five layouts.
 *
 * All five draw the SAME rows — one scan, one filter — so switching layout is a repaint, never a
 * re-read. What differs is the geometry, and the geometry is data ({@link LAYOUT_METRICS}) rather
 * than five hand-rolled scroll containers: the pane hands each layout a window computed from the
 * metric, so virtualization is a property of the Library rather than of whichever layout someone
 * remembered to virtualize.
 *
 * **Two of them are grouped, and grouped lists are bounded differently.** Table, Cards and Media
 * are flat and uniform, so they window. Calendar and Board are grouped, and a window over a grouped
 * list either breaks the groups or needs variable-height measurement; both draw text only (no live
 * preview, so an item costs a `<div>`), and each caps what it draws and SAYS what it left out. A
 * layout that silently truncated would be the same class of lie as "No files found".
 */

import { html, nothing } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { ref } from "lit-html/directives/ref.js";
import { isImage } from "../files/media-upload";
import { loopbackAssetSrc } from "../canvas/canvas-origin";
import { localeLabel } from "@jxsuite/schema/locale";
import { groupByCategory, groupByDate } from "./library-model";
import type { LibraryFile, LibraryLayout } from "./library-model";
import type { GridColumn, GridCellValue } from "../grid/grid-source";
import type { TemplateResult } from "lit-html";

/** The geometry a layout scrolls at. `itemWidth` of 0 means one item per row. */
export interface LayoutMetric {
  /** Height of one row of items, in CSS pixels — the unit the window counts in. */
  rowHeight: number;
  /** Nominal item width; 0 for a full-width row. */
  itemWidth: number;
  /** Whether the layout windows at all. Grouped layouts cap instead. */
  windowed: boolean;
}

/**
 * Per-layout geometry.
 *
 * These are nominal sizes that must match `styles/`'s Library rules. They are approximate on
 * purpose: the window's job is to keep the rendered count proportional to the viewport, and being
 * one row out costs one row of overscan, not correctness.
 */
export const LAYOUT_METRICS: Readonly<Record<LibraryLayout, LayoutMetric>> = {
  board: { itemWidth: 0, rowHeight: 0, windowed: false },
  calendar: { itemWidth: 0, rowHeight: 0, windowed: false },
  cards: { itemWidth: 200, rowHeight: 194, windowed: true },
  media: { itemWidth: 132, rowHeight: 132, windowed: true },
  table: { itemWidth: 0, rowHeight: 32, windowed: true },
};

/** Days the Calendar draws before it stops and states the remainder. */
export const CALENDAR_DAY_LIMIT = 60;

/** Items a Board column draws before it stops and states the remainder. */
export const BOARD_COLUMN_LIMIT = 25;

/** Items per row at a given container width, for the layouts that flow. */
export function columnsAt(layout: LibraryLayout, width: number): number {
  const metric = LAYOUT_METRICS[layout];
  if (metric.itemWidth <= 0 || width <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(width / metric.itemWidth));
}

// ─── What a layout is handed ─────────────────────────────────────────────────

export interface LayoutContext {
  /** The source's columns — the Table layout's headers and cell order come from the GridSource. */
  columns: readonly GridColumn[];
  openFile: (path: string) => void;
  contextMenu: (event: MouseEvent, file: LibraryFile) => void;
  /**
   * Register a card's preview slot for lazy mounting. Called from a lit `ref`, so it receives
   * `undefined` on unmount and must tolerate it.
   */
  mountPreview: (element: Element | undefined, file: LibraryFile) => void;
}

// ─── Cell text ───────────────────────────────────────────────────────────────

/** Bytes as a short human string. `null` when the platform did not report a size. */
export function formatSize(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size)) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** An ISO timestamp as `YYYY-MM-DD`, or "" when there is none. Never invents "just now". */
export function formatModified(modified: string | undefined): string {
  if (!modified) {
    return "";
  }
  const parsed = new Date(modified);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

/** The text one table cell shows for a file. */
export function cellText(file: LibraryFile, field: string): string {
  switch (field) {
    case "category": {
      return file.category;
    }
    case "locale": {
      // The autonym, not the tag: the column exists so a reader can find their own language in it,
      // And `français` is what that reader scans for. The tag is still the filter's value.
      return file.locale ? localeLabel(file.locale) : "";
    }
    case "modified": {
      return formatModified(file.modified);
    }
    case "name": {
      return file.name;
    }
    case "path": {
      return file.path;
    }
    case "size": {
      return formatSize(file.size);
    }
    case "type": {
      return file.type;
    }
    default: {
      return "";
    }
  }
}

/** Row-shaped access for a caller holding grid cells rather than the typed record. */
export function cellTextOf(value: GridCellValue): string {
  return value === null || value === undefined ? "" : String(value);
}

// ─── Shared pieces ───────────────────────────────────────────────────────────

/** A file's thumbnail: the real image for media, a lazily-mounted live preview for a document. */
function previewTpl(file: LibraryFile, ctx: LayoutContext): TemplateResult {
  if (isImage(file.ext)) {
    return html`<img
      class="library-thumb"
      loading="lazy"
      src=${loopbackAssetSrc(`/${file.path}`)}
      alt=""
    />`;
  }
  const previewable =
    file.category === "Components" ||
    file.category === "Pages" ||
    file.category === "Layouts" ||
    file.category === "Content";
  if (!previewable) {
    return html`<sp-icon-document size="xl"></sp-icon-document>`;
  }
  return html`<div
    class="library-preview-slot"
    ${ref((element) => ctx.mountPreview(element, file))}
  ></div>`;
}

/** One clickable item, in whichever wrapper the layout wants. */
function itemAttrs(file: LibraryFile, ctx: LayoutContext) {
  return {
    contextmenu: (event: MouseEvent) => ctx.contextMenu(event, file),
    open: () => ctx.openFile(file.path),
  };
}

// ─── Table ───────────────────────────────────────────────────────────────────

/** The Table layout's header, from the source's own columns. */
export function tableHeadTpl(columns: readonly GridColumn[]): TemplateResult {
  return html`<div class="library-table-head" role="row">
    ${columns.map(
      (column) =>
        html`<div class="library-table-cell" role="columnheader" data-field=${column.field}>
          ${column.title}
        </div>`,
    )}
  </div>`;
}

/** The windowed slice of table rows. */
export function tableRowsTpl(
  files: readonly LibraryFile[],
  ctx: LayoutContext,
): TemplateResult | typeof nothing {
  if (files.length === 0) {
    return nothing;
  }
  return html`${repeat(
    files,
    (file) => file.path,
    (file) => {
      const attrs = itemAttrs(file, ctx);
      return html`<div
        class="library-table-row"
        role="row"
        data-path=${file.path}
        @click=${attrs.open}
        @contextmenu=${attrs.contextmenu}
      >
        ${ctx.columns.map(
          (column) =>
            html`<div class="library-table-cell" role="cell" data-field=${column.field}>
              ${cellText(file, column.field)}
            </div>`,
        )}
      </div>`;
    },
  )}`;
}

// ─── Cards and Media ─────────────────────────────────────────────────────────

/** Cards: a preview, a name, and the category beneath it. */
export function cardsTpl(files: readonly LibraryFile[], ctx: LayoutContext): TemplateResult {
  return html`${repeat(
    files,
    (file) => file.path,
    (file) => {
      const attrs = itemAttrs(file, ctx);
      return html`<div
        class="library-card"
        data-path=${file.path}
        @click=${attrs.open}
        @contextmenu=${attrs.contextmenu}
      >
        <div class="library-card-preview">${previewTpl(file, ctx)}</div>
        <div class="library-card-label" title=${file.path}>${file.name}</div>
        <div class="library-card-meta">${file.type}</div>
      </div>`;
    },
  )}`;
}

/** Media: tighter tiles, image-first, no live document renders at all. */
export function mediaTpl(files: readonly LibraryFile[], ctx: LayoutContext): TemplateResult {
  return html`${repeat(
    files,
    (file) => file.path,
    (file) => {
      const attrs = itemAttrs(file, ctx);
      return html`<div
        class="library-tile"
        data-path=${file.path}
        title=${file.path}
        @click=${attrs.open}
        @contextmenu=${attrs.contextmenu}
      >
        <div class="library-tile-preview">
          ${
            isImage(file.ext)
              ? html`<img
                  class="library-thumb"
                  loading="lazy"
                  src=${loopbackAssetSrc(`/${file.path}`)}
                  alt=""
                />`
              : html`<sp-icon-document size="l"></sp-icon-document>`
          }
        </div>
        <div class="library-tile-label">${file.name}</div>
      </div>`;
    },
  )}`;
}

// ─── Calendar ────────────────────────────────────────────────────────────────

/**
 * Calendar: one section per day, newest first, plus an explicit account of what it did not place.
 *
 * A file's day comes from a `YYYY-MM-DD` filename prefix or the filesystem's mtime — never from
 * "now". Files with neither are listed under "No date" rather than parked on today, because a
 * calendar that invents dates is worse than one that admits it cannot place a file.
 */
export function calendarTpl(files: readonly LibraryFile[], ctx: LayoutContext): TemplateResult {
  const { days, undated } = groupByDate(files);
  const shown = days.slice(0, CALENDAR_DAY_LIMIT);
  const hiddenDays = days.length - shown.length;
  return html`<div class="library-calendar">
    ${shown.map(
      (day) => html`<section class="library-day">
        <h3 class="library-day-date">${day.date}</h3>
        ${listTpl(day.files, ctx)}
      </section>`,
    )}
    ${
      hiddenDays > 0
        ? html`<p class="library-truncated">
            ${hiddenDays} older ${hiddenDays === 1 ? "day is" : "days are"} not shown — filter, or
            switch to Table.
          </p>`
        : nothing
    }
    ${
      undated.length > 0
        ? html`<section class="library-day library-day-undated">
            <h3 class="library-day-date">No date</h3>
            <p class="library-day-note">
              ${undated.length} file${undated.length === 1 ? "" : "s"} with no dated name and no
              modification time.
            </p>
            ${listTpl(undated.slice(0, BOARD_COLUMN_LIMIT), ctx)}
          </section>`
        : nothing
    }
  </div>`;
}

// ─── Board ───────────────────────────────────────────────────────────────────

/** Board: one column per category present, each capped and each stating its own total. */
export function boardTpl(files: readonly LibraryFile[], ctx: LayoutContext): TemplateResult {
  const groups = groupByCategory(files);
  return html`<div class="library-board">
    ${groups.map((group) => {
      const hidden = group.files.length - BOARD_COLUMN_LIMIT;
      return html`<section class="library-board-column">
        <h3 class="library-board-title">
          ${group.group} <span class="library-board-count">${group.files.length}</span>
        </h3>
        ${listTpl(group.files.slice(0, BOARD_COLUMN_LIMIT), ctx)}
        ${
          hidden > 0
            ? html`<p class="library-truncated">${hidden} more — switch to Table to see them.</p>`
            : nothing
        }
      </section>`;
    })}
  </div>`;
}

/** The plain name list both grouped layouts draw. Text only: a group must stay cheap. */
function listTpl(files: readonly LibraryFile[], ctx: LayoutContext): TemplateResult {
  return html`<ul class="library-list">
    ${repeat(
      files,
      (file) => file.path,
      (file) => {
        const attrs = itemAttrs(file, ctx);
        return html`<li
          class="library-list-item"
          data-path=${file.path}
          title=${file.path}
          @click=${attrs.open}
          @contextmenu=${attrs.contextmenu}
        >
          ${file.name}
        </li>`;
      },
    )}
  </ul>`;
}
