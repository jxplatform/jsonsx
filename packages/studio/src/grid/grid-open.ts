/**
 * Grid tab openers — create (or activate) the tab + controller pair for a grid surface.
 *
 * CSV files open as REAL file tabs (id = path) whose default canvas mode is "grid" with a Monaco
 * "source" alternate; collection/pages/connector grids (later phases) open as virtual tabs with
 * `grid://` ids. All openers dedupe by tab id.
 */
import { activateTab, openTab, workspace } from "../workspace/workspace";
import { formatForPath, loadFormats } from "../format/format-host";
import { createGridController } from "./grid-controller";
import { createCsvFileSource } from "./sources/csv-file-source";
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
