/**
 * Grid tab openers — create (or activate) the tab + controller pair for a grid surface.
 *
 * CSV files open as REAL file tabs (id = path) whose default canvas mode is "grid" with a Monaco
 * "source" alternate; collection/pages/connector grids (later phases) open as virtual tabs with
 * `grid://` ids. All openers dedupe by tab id.
 */
import { html } from "lit-html";
import { activateTab, openTab, workspace } from "../workspace/workspace";
import { formatForPath, loadFormats } from "../format/format-host";
import { openModal } from "../ui/layers";
import { dataSurfaceAvailable, fetchConnections } from "../services/data-service";
import { createGridController } from "./grid-controller";
import { createCsvFileSource } from "./sources/csv-file-source";
import {
  collectionDirs,
  createCollectionSource,
  createPagesSource,
} from "./sources/content-source";
import { createConnectorSource } from "./sources/connector-source";
import { makeGridTabId } from "./grid-source";
import type { GridSource } from "./grid-source";
import type { Tab } from "../tabs/tab";

/** Placeholder document for grid tabs — the grid never reads it; save routes to the controller. */
const GRID_STUB_DOCUMENT = { children: [], tagName: "div" };

/** Open (or activate) a `.csv` file as a grid tab. */
export async function openCsvGridTab(path: string): Promise<Tab> {
  const existing = workspace.tabs.get(path);
  if (existing) {
    activateTab(path);
    return existing;
  }

  // Best effort: the format name labels the tab's source mode; the grid works without it.
  try {
    await loadFormats();
  } catch {
    // Format registry unavailable (e.g. no dev server) — grid mode still works.
  }

  const source = createCsvFileSource(path);
  const tab = openTab({
    capabilities: { modes: ["grid", "source"] },
    document: structuredClone(GRID_STUB_DOCUMENT),
    documentPath: path,
    id: path,
    sourceFormat: formatForPath(path)?.name ?? null,
  });
  const controller = createGridController(tab, source);
  void controller.load();
  return tab;
}

/**
 * Open a virtual grid tab for a source (collections now; more kinds later). Callers dedupe by the
 * same `makeGridTabId` id before constructing the source.
 */
function openVirtualGridTab(source: GridSource): Tab {
  const tab = openTab({
    capabilities: { modes: ["grid"] },
    document: structuredClone(GRID_STUB_DOCUMENT),
    documentPath: null,
    id: source.id,
  });
  const controller = createGridController(tab, source);
  void controller.load();
  return tab;
}

/** Open (or activate) the grid tab for a content collection. */
export function openCollectionGrid(typeName: string): Tab {
  const id = makeGridTabId({ kind: "collection", name: typeName });
  const existing = workspace.tabs.get(id);
  if (existing) {
    activateTab(id);
    return existing;
  }
  return openVirtualGridTab(createCollectionSource(typeName));
}

/** Open (or activate) the pages metadata grid. */
export function openPagesGrid(): Tab {
  const id = makeGridTabId({ kind: "pages" });
  const existing = workspace.tabs.get(id);
  if (existing) {
    activateTab(id);
    return existing;
  }
  return openVirtualGridTab(createPagesSource());
}

/** Open (or activate) the grid tab for a connector table. */
export function openConnectorGrid(connection: string | undefined, table: string): Tab {
  const id = makeGridTabId({ connection: connection ?? "default", kind: "data", table });
  const existing = workspace.tabs.get(id);
  if (existing) {
    activateTab(id);
    return existing;
  }
  return openVirtualGridTab(createConnectorSource(connection, table));
}

/**
 * Source picker — one dialog listing every grid-able source: pages, content collections, and (when
 * the platform serves the data surface) each connection's tables.
 */
export async function openGridSourcePicker(): Promise<void> {
  const collections = collectionDirs();
  let connections: { name: string; tables: string[] }[] = [];
  if (dataSurfaceAvailable()) {
    const response = await fetchConnections().catch(() => null);
    connections = response?.connections ?? [];
  }

  const handle = openModal(
    html`<sp-dialog-wrapper
      open
      dismissable
      underlay
      headline="Open Grid"
      @close=${() => handle.close()}
    >
      <sp-menu class="jx-grid-picker">
        <sp-menu-group>
          <span slot="header">Project</span>
          <sp-menu-item
            @click=${() => {
              handle.close();
              openPagesGrid();
            }}
            >Pages</sp-menu-item
          >
          ${collections.map(
            ({ name }) =>
              html`<sp-menu-item
                @click=${() => {
                  handle.close();
                  openCollectionGrid(name);
                }}
                >Collection: ${name}</sp-menu-item
              >`,
          )}
        </sp-menu-group>
        ${connections.map(
          (conn) =>
            html`<sp-menu-group>
              <span slot="header">Data · ${conn.name}</span>
              ${conn.tables.length === 0
                ? html`<sp-menu-item disabled>No tables — push a schema first</sp-menu-item>`
                : conn.tables.map(
                    (table) =>
                      html`<sp-menu-item
                        @click=${() => {
                          handle.close();
                          openConnectorGrid(conn.name, table);
                        }}
                        >${table}</sp-menu-item
                      >`,
                  )}
            </sp-menu-group>`,
        )}
      </sp-menu>
    </sp-dialog-wrapper>`,
  );
}
