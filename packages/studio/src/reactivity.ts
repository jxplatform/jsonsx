/**
 * Re-exports from @vue/reactivity. All studio code imports reactivity primitives from here (not
 * directly from the package) for grep-ability and potential future wrapping.
 *
 * Version is pinned to match @jxsuite/runtime — reactive proxies from one version don't track in
 * effects from another. See migrate-reactivity-workspace.md for rationale.
 *
 * Batching note: Vue's reactivity batches synchronous effect re-runs within a microtask. Use
 * queueMicrotask() or Promise.resolve().then() to wait for the flush if needed (@vue/reactivity
 * standalone doesn't ship nextTick).
 */
export {
  reactive,
  ref,
  computed,
  readonly,
  shallowReactive,
  shallowRef,
  effect,
  effectScope,
  getCurrentScope,
  onScopeDispose,
  pauseTracking,
  resetTracking,
  toRaw,
  isReactive,
  isRef,
} from "@vue/reactivity";

export type { EffectScope } from "@vue/reactivity";
