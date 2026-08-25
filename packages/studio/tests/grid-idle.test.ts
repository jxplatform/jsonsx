/**
 * The grid's quiescence registry. No DOM and no Tabulator — which is the whole point of the module
 * existing separately from `grid-view.ts`, so this file imports neither.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { gridIdleBlockers, registerGridProbe } from "../src/grid/grid-idle";

/*
 * `liveGrids` is module state that outlives a test, and the registry deliberately exposes no reset:
 * a test-only export is a function unreachable from any entry point, which `reachability.test.ts`
 * fails on. Deregistration is the production API, so the tests use it.
 */
const cleanup: (() => void)[] = [];
const track = (probe: () => string | null) => {
  const off = registerGridProbe(probe);
  cleanup.push(off);
  return off;
};

afterEach(() => {
  for (const off of cleanup.splice(0)) {
    off();
  }
});

describe("gridIdleBlockers", () => {
  test("reports only the probes that are not settled", () => {
    track(() => null);
    track(() => "grid[a]: building");
    track(() => "grid[b]: selection range not laid out");

    expect(gridIdleBlockers()).toEqual([
      "grid[a]: building",
      "grid[b]: selection range not laid out",
    ]);
  });

  test("no grids at all is quiet, which is the state of every page without one", () => {
    expect(gridIdleBlockers()).toEqual([]);
  });

  test("deregistering removes a probe, so a torn-down grid cannot block idle forever", () => {
    const off = track(() => "grid[a]: building");
    expect(gridIdleBlockers()).toHaveLength(1);
    off();
    expect(gridIdleBlockers()).toEqual([]);
  });

  test("a probe that throws is settled, not fatal", () => {
    /*
     * The predicate runs inside `probeIdle()`'s frame loop. A probe that asked a destroyed Tabulator
     * for its ranges would throw, and an exception escaping here would look exactly like a
     * subsystem that never settles — a 10-second timeout instead of a picture.
     */
    track(() => {
      throw new Error("table destroyed");
    });
    track(() => "grid[b]: building");

    expect(gridIdleBlockers()).toEqual(["grid[b]: building"]);
  });

  test("the same probe registered twice is one probe, and one deregistration clears it", () => {
    const probe = () => "grid[a]: building";
    const off = track(probe);
    track(probe);
    expect(gridIdleBlockers()).toEqual(["grid[a]: building"]);
    off();
    expect(gridIdleBlockers()).toEqual([]);
  });
});
