/// <reference lib="dom" />
/**
 * Chooses the default PAL adapter when no platform was pre-registered on `window.__jxPlatform`.
 *
 * The cloud shell (the platform repo's `web/edit-init.ts`) publishes a `window.__jxCloud` signal
 * _instead of_ constructing the adapter itself, so the cloud adapter — and its collab WebSocket
 * client, which owns the shared `Y.Doc` — is created HERE, inside the studio bundle, sharing
 * studio's single `yjs` instance. Creating it in the shell bundle loads a SECOND `yjs`, which
 * breaks collab's cross-module `instanceof` checks (the Y↔JxDocOp conversion silently stops
 * reconciling). The dev server sends no signal and falls back to the dev-server adapter; desktop
 * pre-registers its own adapter on `__jxPlatform`, so this resolver never runs there.
 */
import type { StudioPlatform } from "../types";
import type { CloudProject } from "./cloud";
import { createCloudPlatform } from "./cloud";
import { createDevServerPlatform } from "./devserver";

/** Cloud shell handshake: presence signals cloud; `project` is null for the /studio hub. */
export interface CloudSignal {
  project: CloudProject | null;
}

/** Returns the cloud adapter when the shell signalled cloud, else the dev-server adapter. */
export function resolveDefaultPlatform(): StudioPlatform {
  const cloud = (globalThis as unknown as { __jxCloud?: CloudSignal }).__jxCloud;
  return cloud ? createCloudPlatform(cloud.project) : createDevServerPlatform();
}
