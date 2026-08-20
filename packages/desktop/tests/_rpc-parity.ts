/**
 * Schema↔handler parity support.
 *
 * `rpc-schema.ts` declares the bun-side request map as a TypeScript _type_, so the method names
 * exist only at compile time — nothing stops a request from being declared, called by a platform,
 * and never registered in a launcher's handler map. That failure is silent at runtime (the studio
 * sees a rejected or never-answered call and degrades to "no results"), which is exactly how
 * `searchFiles` shipped unhandled and made ⌘P Quick Access look like an empty project.
 *
 * So the names are read back out of the source here, and both launchers' maps are checked against
 * them: window-manager.ts (electrobun, one map per window) and chromium/index.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_FILE = join(import.meta.dir, "../src/rpc-schema.ts");

/**
 * Drop comments so a brace or a `name: {` inside prose cannot fool the scanner. A single left-to-
 * right pass, not two regex passes: the schema's own `// … /__studio/data/* …` line comment reads
 * as a block-comment opener to a regex, which silently swallowed half the request map. Newlines
 * inside block comments are preserved so line-oriented matching still lines up.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < src.length) {
    const ch = src[i]!;
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = "";
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          out += "\n";
        }
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every request name declared on `StudioRPC["bun"]`, in declaration order. */
export function declaredRpcRequests(): string[] {
  const src = stripComments(readFileSync(SCHEMA_FILE, "utf8"));
  const iface = src.indexOf("export interface StudioRPC");
  const open = iface === -1 ? -1 : src.indexOf("requests: {", iface);
  if (open === -1) {
    throw new Error("rpc-schema.ts: could not find the StudioRPC `requests` map");
  }

  const names: string[] = [];
  let depth = 1; // Already inside `requests: {`
  for (const line of src.slice(src.indexOf("\n", open) + 1).split("\n")) {
    if (depth === 1) {
      const match = /^\s*([A-Za-z_$][\w$]*)\??:\s*\{\s*$/.exec(line);
      if (match) {
        names.push(match[1]!);
      }
    }
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (depth <= 0) {
      break;
    }
  }
  return names;
}

/**
 * Requests the chromium launcher deliberately does NOT answer over RPC, each mapped to where it is
 * answered instead. The electrobun window-manager map has no exemptions — it must handle all of
 * them. Adding an entry here is a claim that must stay true: the parity test fails both when an
 * exempt request turns up in the map and when it disappears from the schema.
 */
export const CHROMIUM_RPC_EXEMPT: Record<string, string> = {
  aiChatUrl:
    "chromium/platform.ts aiChatUrl() returns the local /__studio__/ai/chat path directly, with the project server's token",
  getCanvasUrl: "chromium/platform.ts builds `canvasUrl` from location.search; no round trip",
  importSiteUrl: "chromium/platform.ts importSite() posts to /__studio__/import-site directly",
  /*
   * The two families below are NOT gaps — they are things this build would have to lie about.
   *
   * The updater: this build is installed and replaced by whatever packaged it (`nix build`, a
   * distro package). It has no feed to check, so it answers the one question the About screen
   * actually renders — the channel — through `appInfo`, and reports no update status rather than an
   * "Up to date" it never verified.
   *
   * The window controls: Studio draws client-side decorations only when the launcher exposes them,
   * which electrobun does because its BrowserWindow is frameless. A Chromium `--app` window is
   * decorated by the desktop environment, and a second set of buttons inside the page would
   * minimize and close nothing.
   */
  updaterApplyUpdate: "no self-updater outside electrobun; the system package manager owns updates",
  updaterCheckForUpdate:
    "no self-updater outside electrobun; the system package manager owns updates",
  updaterDownloadUpdate:
    "no self-updater outside electrobun; the system package manager owns updates",
  updaterGetLocalInfo:
    "no self-updater outside electrobun; `appInfo` answers the About screen instead",
  updaterGetStatus: "no self-updater outside electrobun; there is no feed to have a status from",
  windowClose: "the desktop environment decorates the --app window; no client-side window controls",
  windowGetFrame:
    "the desktop environment decorates the --app window; no client-side window controls",
  windowMaximize:
    "the desktop environment decorates the --app window; no client-side window controls",
  windowMinimize:
    "the desktop environment decorates the --app window; no client-side window controls",
  windowSetFrame:
    "the desktop environment decorates the --app window; no client-side window controls",
};

/**
 * Compare a launcher's registered method names against the declared schema.
 *
 * @param registered — the launcher's handler-map keys
 * @param exempt — declared requests this launcher answers elsewhere (see CHROMIUM_RPC_EXEMPT)
 */
export function rpcParity(registered: string[], exempt: Record<string, string> = {}) {
  const declared = declaredRpcRequests();
  // A parse regression would silently make every assertion below vacuous.
  if (declared.length < 50) {
    throw new Error(`rpc-schema.ts: parsed only ${declared.length} requests; scanner is broken`);
  }
  const declaredSet = new Set(declared);
  const registeredSet = new Set(registered);
  return {
    declared,
    /** Declared, not exempt, and no handler — the bug class this guard exists for. */
    unhandled: declared.filter((name) => !registeredSet.has(name) && !(name in exempt)),
    /** Registered but never declared — a handler the typed schema cannot reach. */
    undeclared: registered.filter((name) => !declaredSet.has(name)),
    /** Exempt yet handled anyway — the exemption's justification has gone stale. */
    staleExempt: Object.keys(exempt).filter((name) => registeredSet.has(name)),
    /** Exempt but no longer in the schema — the exemption should be deleted. */
    orphanExempt: Object.keys(exempt).filter((name) => !declaredSet.has(name)),
  };
}
