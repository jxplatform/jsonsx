/**
 * Prerender-runtime-state.test.ts — build-time template evaluation vs. values that only exist after
 * hydration, plus the two cross-target emitters that back the element/client parity fixes.
 *
 * The prerender pass used to evaluate a `${state.x}` read against whatever placeholder the
 * build-time scope happened to hold for `x`. For a bodyless `$src` Function that placeholder is a
 * real JS function, so the emitted HTML got text like `() => {}`; for a `Request` there is no value
 * at all, so it got `undefined`. Either way the resolved text _replaced_ the template in the
 * output, which destroyed the client-side binding rather than merely getting it wrong (issue
 * #112).
 */

import { describe, expect, test } from "bun:test";
import {
  buildInitialScope,
  emitRequestFetch,
  evaluateStaticTemplate,
  srcImportBinding,
} from "../src/shared";
import type { JxStateDefinition } from "@jxsuite/schema/types";

/** @param {Record<string, unknown>} defs */
const scopeOf = (defs: Record<string, unknown>) =>
  buildInitialScope(defs as Record<string, JxStateDefinition>);

// ── Runtime-only reads are refused, not baked (issue #112) ───────────────────

describe("evaluateStaticTemplate — runtime-only state", () => {
  test("refuses a bodyless $src Function interpolated as a value", () => {
    const scope = scopeOf({
      followups: { $export: "followupsDue", $prototype: "Function", $src: "./lib.js" },
    });

    // The scope really does hold a callable placeholder — that is what used to get stringified.
    expect(typeof scope.followups).toBe("function");
    expect(evaluateStaticTemplate("followups due: ${state.followups}", scope)).toBeNull();
  });

  test("refuses an inline-body Function interpolated as a value", () => {
    const scope = scopeOf({ handler: { $prototype: "Function", body: "state.n++" }, n: 0 });

    // This one baked the function's entire source text into the page.
    const result = evaluateStaticTemplate("h: ${state.handler}", scope);
    expect(result).toBeNull();
  });

  test("refuses a Request read, which has no build-time value at all", () => {
    const scope = scopeOf({ leads: { $prototype: "Request", url: "/api/leads" } });

    expect(evaluateStaticTemplate("count: ${state.leads}", scope)).toBeNull();
    expect(evaluateStaticTemplate("${state.leads}", scope)).toBeNull();
  });

  test("refuses a member read through a runtime-only value", () => {
    const scope = scopeOf({ biz: { $prototype: "Function", $src: "./lib.js" } });

    // `.name` would otherwise resolve to Function.prototype.name and bake an empty string.
    expect(evaluateStaticTemplate("name: ${state.biz.name}", scope)).toBeNull();
  });

  test("still resolves ordinary values", () => {
    const scope = scopeOf({ nums: [1, 2, 3], who: "Acme" });

    expect(evaluateStaticTemplate("hello ${state.who}", scope)).toBe("hello Acme");
    expect(evaluateStaticTemplate("n: ${state.nums.length}", scope)).toBe("n: 3");
  });

  test("still calls a named formula at build time", () => {
    // The distinction that matters: a *called* value is a build-time callable (spec.md §19.4c) and
    // Must keep evaluating. Only an interpolated-as-a-value read is refused.
    const scope = scopeOf({
      lineTotal: {
        $expression: {
          operator: "*",
          target: { $ref: "$args/price" },
          value: { $ref: "$args/qty" },
        },
        parameters: [{ name: "price" }, { default: 1, name: "qty" }],
      },
    });

    expect(typeof scope.lineTotal).toBe("function");
    expect(evaluateStaticTemplate("total: ${state.lineTotal(3, 4)}", scope)).toBe("total: 12");
    expect(evaluateStaticTemplate("${state.lineTotal(5)}", scope)).toBe(5);
    // …but the same formula read bare is still a function, so it is refused.
    expect(evaluateStaticTemplate("bare: ${state.lineTotal}", scope)).toBeNull();
  });

  test("a template-valued state entry that reads runtime-only state is runtime-only too", () => {
    const scope = scopeOf({
      derived: "derived=${state.followups}",
      followups: { $prototype: "Function", $src: "./lib.js" },
    });

    // Otherwise the failed evaluation (`null`) gets baked one step removed from the original read.
    expect(evaluateStaticTemplate("D: ${state.derived}", scope)).toBeNull();
  });

  test("a template-valued state entry over plain values still resolves through a chain", () => {
    const scope = scopeOf({ greeting: "hi ${state.who}", who: "Ann" });

    expect(evaluateStaticTemplate("G: ${state.greeting}", scope)).toBe("G: hi Ann");
  });

  test("a nested scope inherits its parent's runtime-only marks", () => {
    const parent = scopeOf({ leads: { $prototype: "Request", url: "/api/leads" } });
    const child = buildInitialScope({ own: 1 } as Record<string, JxStateDefinition>, parent);

    expect(evaluateStaticTemplate("c: ${state.leads}", child)).toBeNull();
    expect(evaluateStaticTemplate("o: ${state.own}", child)).toBe("o: 1");
  });

  test("tolerates a missing scope", () => {
    // ResolveStaticValue reaches evaluateStaticTemplate through a non-null assertion, so the guard
    // Has to survive a null scope rather than throwing while probing it for marks.
    expect(evaluateStaticTemplate("${state.x}", null as never)).toBeNull();
  });

  test("the runtime-only marker stays out of enumeration", () => {
    const scope = scopeOf({ leads: { $prototype: "Request", url: "/api/x" }, n: 1 });

    expect(Object.keys(scope)).not.toContain("leads");
    expect(Object.keys(scope)).toEqual(["n"]);
  });
});

// ── srcImportBinding (issue #106, shared by both targets) ────────────────────

describe("srcImportBinding", () => {
  test("returns the bare key when $export is absent, empty, or equal", () => {
    expect(srcImportBinding("fn", {})).toBe("fn");
    expect(srcImportBinding("fn", { $export: "" })).toBe("fn");
    expect(srcImportBinding("fn", { $export: "fn" })).toBe("fn");
    expect(srcImportBinding("fn", null)).toBe("fn");
  });

  test("aliases when $export names a different export", () => {
    expect(srcImportBinding("filtered", { $export: "filterLeads" })).toBe(
      "filterLeads as filtered",
    );
  });

  test("makes a default export reachable", () => {
    expect(srcImportBinding("run", { $export: "default" })).toBe("default as run");
  });

  test("ignores a non-string $export", () => {
    expect(srcImportBinding("fn", { $export: 42 })).toBe("fn");
  });
});

// ── emitRequestFetch (issue #109, shared by both targets) ───────────────────

describe("emitRequestFetch", () => {
  test("defaults to the client target's module-scope shape", () => {
    const out = emitRequestFetch("leads", { $prototype: "Request", url: "/api/leads" });

    expect(out).toContain("effect(() => {");
    expect(out).toContain('const url = "/api/leads";');
    expect(out).toContain("state.leads = d;");
    expect(out).not.toContain("this.state");
    expect(out).not.toContain(".push(");
  });

  test("rebases template reads onto a custom statePrefix without touching literal text", () => {
    const out = emitRequestFetch(
      "d",
      { $prototype: "Request", url: "/api/state.json?q=${state.q}&r=${substate.z}" },
      { statePrefix: "this.state" },
    );

    expect(out).toContain("const url = `/api/state.json?q=${this.state.q}&r=${substate.z}`;");
    // A blanket replace corrupted the path segment and any identifier ending in `state`.
    expect(out).not.toContain("/api/this.state.json");
    expect(out).not.toContain("subthis.state.z");
  });

  test("leaves an already-prefixed read alone", () => {
    const out = emitRequestFetch(
      "d",
      { $prototype: "Request", url: "/api/${this.state.id}" },
      { statePrefix: "this.state" },
    );

    expect(out).toContain("const url = `/api/${this.state.id}`;");
    expect(out).not.toContain("this.this.state");
  });

  test("collects the runner when asked, so the caller can stop it", () => {
    const out = emitRequestFetch(
      "d",
      { $prototype: "Request", url: "/api/d" },
      {
        collect: "this.#requests",
      },
    );

    expect(out).toContain("this.#requests.push(effect(() => {");
    expect(out.trimEnd().endsWith("}));")).toBe(true);
  });

  test("emits only a note for a manual Request", () => {
    const out = emitRequestFetch("d", { $prototype: "Request", manual: true, url: "/api/d" });

    expect(out).toContain("manual Request");
    expect(out).not.toContain("fetch(");
  });

  test("indents every emitted line", () => {
    const out = emitRequestFetch("d", { $prototype: "Request", url: "/api/d" }, { indent: "    " });

    for (const line of out.split("\n")) {
      expect(line.startsWith("    ")).toBe(true);
    }
  });
});
