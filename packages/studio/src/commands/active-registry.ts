/**
 * Active-registry.ts — the one registry this window's chrome renders from.
 *
 * `registry.ts` deliberately has no module-level singleton: the context a registry closes over is
 * one window's, the CI checks build their own, and every test wants a registry it can state
 * exactly. That is right, and it leaves one gap — the Command Bar and the Palette are mounted by
 * `studio.ts` BEFORE the bootstrap composes the registry (`toolbar.mount` runs at the top of the
 * file, `createCommandRegistry` near the bottom), so neither surface can be handed one at mount.
 *
 * This is the seam, in the same idiom as `platform.ts`'s `registerPlatform` / `getPlatform` and
 * `canvas/preview-navigate.ts`'s handler slot: the bootstrap sets it once, and the surfaces ask.
 *
 * The holder is a `shallowRef`, which is the load-bearing part. A surface that reads
 * {@link activeRegistry} inside its render effect TRACKS the holder, so the effect re-runs the
 * moment the bootstrap sets it — which is what lets the Command Bar paint an honest empty band at
 * mount and fill in without anyone remembering to call `render()` afterwards.
 */

import { shallowRef } from "../reactivity";
import type { CommandRegistry } from "./registry";

const _registry = shallowRef<CommandRegistry | null>(null);

/**
 * Publish this window's registry. Called once by the bootstrap, and by tests with their own.
 *
 * Passing `null` clears it, which is what an unmounting test does so the next one starts cold.
 */
export function setActiveRegistry(registry: CommandRegistry | null): void {
  _registry.value = registry;
}

/**
 * This window's registry, or `null` before the bootstrap has composed it.
 *
 * Returning `null` rather than throwing is deliberate: the surfaces render a skeleton in that
 * window, and a chrome that crashes because it painted one frame early would be a worse bug than
 * the one this seam exists to solve.
 */
export function activeRegistry(): CommandRegistry | null {
  return _registry.value;
}
