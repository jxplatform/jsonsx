/**
 * The seam the chrome renders through.
 *
 * `registry.ts` has no module-level singleton on purpose, and `studio.ts` mounts the Command Bar
 * and the Palette BEFORE it composes the registry — so the two surfaces need somewhere to ask. The
 * property that makes that work is reactivity: a surface reading the holder inside its render
 * effect must repaint when the bootstrap publishes, with no `render()` call beside it.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { activeRegistry, setActiveRegistry } from "../src/commands/active-registry";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext } from "../src/commands/context";
import { effect, effectScope } from "../src/reactivity";

beforeEach(() => {
  setActiveRegistry(null);
});

describe("the active registry", () => {
  test("is null before the bootstrap composes one", () => {
    expect(activeRegistry()).toBeNull();
  });

  test("publishing makes it readable, and clearing puts it back", () => {
    const registry = createCommandRegistry({ getContext: emptyContext });
    setActiveRegistry(registry);
    expect(activeRegistry()).toBe(registry);
    setActiveRegistry(null);
    expect(activeRegistry()).toBeNull();
  });

  test("an effect that read it re-runs when the bootstrap publishes", () => {
    // This is the whole reason the holder is a ref: the Command Bar paints an honest empty band at
    // Mount and fills in by itself the moment `initShortcuts` publishes.
    const seen: boolean[] = [];
    const scope = effectScope();
    scope.run(() => {
      effect(() => {
        seen.push(activeRegistry() !== null);
      });
    });
    expect(seen).toEqual([false]);

    setActiveRegistry(createCommandRegistry({ getContext: emptyContext }));
    expect(seen).toEqual([false, true]);

    scope.stop();
    setActiveRegistry(null);
    expect(seen).toEqual([false, true]);
  });
});
