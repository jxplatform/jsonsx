import { homedir } from "node:os";

let Utils: any = null;

export async function init() {
  try {
    Utils = (await import("electrobun/bun")).Utils;
  } catch {}
}

export async function openFileDialog(): Promise<string | null> {
  if (!Utils) return null;
  const paths = await Utils.openFileDialog({
    startingFolder: homedir(),
    allowedFileTypes: "json",
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
  });
  if (!paths || paths.length === 0 || (paths.length === 1 && !paths[0])) return null;
  return paths[0].trim() || null;
}
