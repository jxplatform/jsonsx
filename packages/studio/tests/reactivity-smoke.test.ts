import "./with-dom.js";
import { reactive, effect, effectScope, computed } from "../src/reactivity";
import { test, expect } from "bun:test";

test("reactive + effect basic tracking", () => {
  const obj = reactive({ count: 0 });
  let observed = 0;
  effect(() => {
    observed = obj.count;
  });
  expect(observed).toBe(0);
  obj.count = 5;
  expect(observed).toBe(5);
});

test("effectScope disposes effects", () => {
  const obj = reactive({ x: 1 });
  let runs = 0;
  const scope = effectScope();
  scope.run(() => {
    effect(() => {
      runs++;
      void obj.x;
    });
  });
  expect(runs).toBe(1);
  obj.x = 2;
  expect(runs).toBe(2);
  scope.stop();
  obj.x = 3;
  expect(runs).toBe(2);
});

test("computed derives from reactive", () => {
  const state = reactive({ a: 1, b: 2 });
  const sum = computed(() => state.a + state.b);
  expect(sum.value).toBe(3);
  state.a = 10;
  expect(sum.value).toBe(12);
});
