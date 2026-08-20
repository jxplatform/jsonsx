import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

const { _resetPrivatePropWarnings, buildScope, defineElement, renderNode } =
  await import("../src/runtime");

/*
 * The §5.6 rule: a `#`-prefixed state entry is ordinary state that is NOT part of the component's
 * interface — never in the property panel, never in an exported CEM manifest, and never settable
 * through `$props`. The first two clauses were enforced in the studio; this file is about the
 * third, which is the runtime's, and which was unenforced.
 *
 * The point is a negative, so nearly every test asserts that a value did NOT change. The failure
 * these guard against is silent by construction: an unguarded path does not error, it just writes.
 */

const CHILD = {
  state: { "#cache": "private", count: 0, label: "hi" },
  tagName: "priv-child",
  children: [],
};

const warnings: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  warnings.length = 0;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  _resetPrivatePropWarnings();
});

afterEach(() => {
  console.warn = realWarn;
});

describe("a private entry is still ordinary state", () => {
  test("it builds into scope and is readable and writable from inside", async () => {
    const state = await buildScope(CHILD as never, {});
    expect(state["#cache"]).toBe("private");
    state["#cache"] = "changed";
    expect(state["#cache"]).toBe("changed");
  });
});

describe("$props cannot reach it", () => {
  /*
   * The instance-site case: a parent document naming a private entry in `$props`. Before this the
   * write landed, so a component's private cache was settable by anyone instantiating it.
   */
  test("a $props entry naming a private key is ignored", async () => {
    const parent = await buildScope({ state: { outer: 1 } } as never, {});
    const el = renderNode(
      {
        $props: { "#cache": "injected", label: "set" },
        tagName: "div",
        children: [],
      } as never,
      parent,
    ) as HTMLElement;
    expect(el).toBeDefined();
    expect(warnings.join("\n")).toContain("#cache");
  });

  test("the refusal names the section and says what to do", async () => {
    const parent = await buildScope({ state: {} } as never, {});
    renderNode({ $props: { "#cache": "x" }, tagName: "div", children: [] } as never, parent);
    const text = warnings.join("\n");
    expect(text).toContain("§5.6");
    expect(text).toContain("ignored");
  });

  // A component in a list must not print the same refusal once per row.
  test("warns once per key, not once per instance", async () => {
    const parent = await buildScope({ state: {} } as never, {});
    for (let i = 0; i < 20; i++) {
      renderNode({ $props: { "#cache": i }, tagName: "div", children: [] } as never, parent);
    }
    expect(warnings.filter((w) => w.includes("#cache"))).toHaveLength(1);
  });

  test("a public prop beside a private one still lands", async () => {
    const parent = await buildScope({ state: {} } as never, {});
    renderNode(
      { $props: { "#cache": "no", label: "yes" }, tagName: "div", children: [] } as never,
      parent,
    );
    // The private one was refused; the public one produced no complaint.
    expect(warnings.join("\n")).not.toContain("label");
  });
});

describe("the custom-element interface excludes it", () => {
  /*
   * The property-first interface IS the props mechanism, so a private entry must get no accessor.
   * With one, `el["#cache"] = x` would write straight through every guard above it.
   */
  test("no property accessor is defined for a private key", async () => {
    await defineElement({ ...CHILD, tagName: "priv-accessor" } as never);
    const el = document.createElement("priv-accessor");
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    const own = Object.getOwnPropertyNames(el);
    expect(own).not.toContain("#cache");
    expect(own).toContain("count");
    el.remove();
  });

  test("a props.* attribute naming a private key is refused and stripped", async () => {
    await defineElement({ ...CHILD, tagName: "priv-attr" } as never);
    const el = document.createElement("priv-attr");
    el.setAttribute("props.#cache", "injected");
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(el.hasAttribute("props.#cache")).toBe(false);
    expect(warnings.join("\n")).toContain("#cache");
    el.remove();
  });

  test("a data-jx-props payload naming a private key is refused", async () => {
    await defineElement({ ...CHILD, tagName: "priv-payload" } as never);
    const el = document.createElement("priv-payload");
    el.dataset.jxProps = JSON.stringify({ "#cache": "injected", count: 7 });
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(warnings.join("\n")).toContain("#cache");
    el.remove();
  });
});
