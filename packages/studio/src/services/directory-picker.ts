/// <reference lib="dom" />
/**
 * Browser-side folder picking for the New Project modal's **Browse…** button.
 *
 * `showDirectoryPicker()` is the only native folder chooser a web page gets, but it hands back a
 * `FileSystemDirectoryHandle` that exposes `.name` and nothing else — never a filesystem path
 * (specs/desktop.md §8.2). Opening a project works around that by searching for the `project.json`
 * the user pointed at, which is no help when choosing a _destination_: that folder is empty by
 * definition, and often does not exist as a project at all.
 *
 * So the handle is made to identify itself. Using the readwrite grant the picker just issued, we
 * drop a hidden {@link LOCATION_ID_FILE} holding a freshly generated id and ask the backend which
 * directory holds that exact id. A fixed filename with the identity in its _contents_ is what makes
 * the match unambiguous: two folders may share a basename, and a stale file from a crashed session
 * may still be lying around, but only one file anywhere holds this id. The backend deletes the file
 * as soon as it matches, and this module removes it too, so neither a lost tab nor a failed lookup
 * leaves anything behind in the user's new project folder.
 *
 * Only the plain dev-server browser session needs this. Every packaged build has a real native
 * dialog that returns a path directly and keeps it — electrobun's `Utils.openFileDialog`, and the
 * NixOS chromium build's XDG desktop portal.
 *
 * @docs studio/projects/create
 */

import { LOCATION_ID_FILE } from "@jxsuite/protocol/routes";

/** Re-exported so a caller wiring up `locate` need not also reach into the protocol package. */
export { LOCATION_ID_FILE } from "@jxsuite/protocol/routes";

/** The subset of the File System Access API this module uses. */
interface WritableHandle {
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

interface DirectoryHandle {
  name: string;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<WritableHandle>;
  removeEntry: (name: string, opts?: { recursive?: boolean }) => Promise<void>;
}

type ShowDirectoryPicker = (opts?: {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: string;
}) => Promise<DirectoryHandle>;

/** Whether this browser can open a native folder chooser at all. */
export function canPickDirectory(): boolean {
  return (
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
  );
}

/** A location id: URL-safe, unguessable enough that a concurrent pick cannot collide. */
function newLocationId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Open the browser's native folder chooser and resolve the chosen folder's absolute path.
 *
 * Resolves `null` when the user cancels, when the API is unavailable, or when the backend cannot
 * place the folder (e.g. it lives outside the home directory the backend scans) — all three are "no
 * destination chosen", which the caller already handles by leaving the Location field alone.
 *
 * MUST be called synchronously from a user gesture; `showDirectoryPicker()` is invoked before this
 * function awaits anything so a click handler that calls it directly keeps the gesture.
 *
 * @param locate Ask the backend which directory holds `id`, given the handle's `name`.
 */
export async function pickDirectoryPath(
  locate: (query: { name: string; id: string }) => Promise<string | null>,
): Promise<string | null> {
  const show = (globalThis as { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker;
  if (typeof show !== "function") {
    return null;
  }

  let handle: DirectoryHandle;
  try {
    // `id` makes Chrome reopen at the last folder chosen for this purpose across sessions.
    handle = await show({ id: "jx-new-project-location", mode: "readwrite", startIn: "documents" });
  } catch {
    // AbortError on cancel; a SecurityError if the gesture was lost. Neither is worth surfacing.
    return null;
  }

  const id = newLocationId();
  try {
    const file = await handle.getFileHandle(LOCATION_ID_FILE, { create: true });
    const writable = await file.createWritable();
    await writable.write(id);
    await writable.close();
  } catch {
    // Read-only grant or a folder we cannot write: not a usable project destination anyway.
    return null;
  }
  try {
    return await locate({ id, name: handle.name });
  } catch {
    return null;
  } finally {
    // The backend removes the file the moment it matches; this covers every path where it did not
    // (no match, a network failure, a backend that never ran the lookup).
    await handle.removeEntry(LOCATION_ID_FILE).catch(() => {
      /* Already gone — the backend beat us to it. */
    });
  }
}
