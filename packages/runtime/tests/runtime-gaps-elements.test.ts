import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, test, expect, mock, spyOn } from "bun:test";
import { reactive } from "@vue/reactivity";
import { defineElement, Jx, renderNode as _renderNode } from "../src/runtime";
import type { JxDocument } from "@jxsuite/schema/types";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

const renderNode: (...args: Parameters<typeof _renderNode>) => HTMLElement = _renderNode as any;

const wait = (ms = 0) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// ─── registerElements via Jx $elements ───────────────────────────────────────

describe("registerElements", () => {
  test("registers ref'd elements, skips invalid entries, warns on bad packages", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const childDoc = {
      children: ["nested"],
      tagName: "gaps-reg-child",
    };
    const parentDoc = {
      $elements: [{ $ref: "http://localhost/gaps-reg-child.json" }],
      children: ["parent"],
      tagName: "gaps-reg-parent",
    };
    const noTagDoc = { children: [] };
    global.fetch = mock((url: string) => {
      const docs: Record<string, unknown> = {
        "gaps-no-tag.json": noTagDoc,
        "gaps-reg-child.json": childDoc,
        "gaps-reg-parent.json": parentDoc,
      };
      for (const [k, d] of Object.entries(docs)) {
        if (String(url).includes(k)) {
          return Promise.resolve({ json: () => Promise.resolve(d), ok: true });
        }
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as any;

    const target = document.createElement("div");
    await Jx(
      {
        $elements: [
          "totally-fake-gaps-pkg", // Bare package: import fails → warn
          "./gaps-relative-missing.js", // Relative side-effect import fails → warn
          { notARef: true } as any, // Non-ref object: skipped
          { $ref: "http://localhost/gaps-no-tag.json" }, // No tagName: skipped
          { $ref: "http://localhost/gaps-reg-parent.json" }, // Registers child first (depth-first)
          { $ref: "http://localhost/gaps-reg-parent.json" }, // Already registered: skipped
        ],
        tagName: "div",
      } as unknown as JxDocument,
      target,
    );

    expect(customElements.get("gaps-reg-parent")).toBeTruthy();
    expect(customElements.get("gaps-reg-child")).toBeTruthy();
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    warn.mockRestore();
  });
});

// ─── Jx({ base }) ────────────────────────────────────────────────────────────

describe("Jx base option", () => {
  /** Register one document object and report the URL its `$elements` ref was fetched from. */
  async function fetchedRefUrl(tagName: string, base?: string) {
    const seen: string[] = [];
    global.fetch = mock((url: string) => {
      seen.push(String(url));
      return Promise.resolve({ json: () => Promise.resolve({ children: [], tagName }), ok: true });
    }) as any;
    /* A ref per tag: `resolve()` memoises by resolved URL, so reusing one path would hand the
       second call the first call's document and quietly prove nothing. */
    await Jx(
      {
        $elements: [{ $ref: `./components/${tagName}.json` }],
        tagName: "div",
      } as unknown as JxDocument,
      document.createElement("div"),
      base === undefined ? undefined : { base },
    );
    return seen[0]!;
  }

  test("a document object resolves its refs against the given base", async () => {
    /* The page is served deep in the site while its references stay root-relative — which is the
       whole reason a host that composes documents server-side has to be able to say so. Without
       the option the base is the PAGE, and every ref resolves a directory too deep. */
    expect(await fetchedRefUrl("gaps-based-root", "http://localhost/")).toBe(
      "http://localhost/components/gaps-based-root.json",
    );
    expect(await fetchedRefUrl("gaps-based-deep", "http://localhost/blog/hello/")).toBe(
      "http://localhost/blog/hello/components/gaps-based-deep.json",
    );
  });

  test("the element registered is the one the base pointed at", async () => {
    await fetchedRefUrl("gaps-based-registered", "http://localhost/");
    expect(customElements.get("gaps-based-registered")).toBeTruthy();
  });
});

// ─── injectHead via Jx $head ─────────────────────────────────────────────────

describe("injectHead", () => {
  test("injects head entries, rewrites bare specifiers, dedupes, sets textContent", async () => {
    const target = document.createElement("div");
    const headEntries = [
      null, // Skipped
      { attributes: {} }, // No tagName: skipped
      {
        attributes: { href: "some-gaps-pkg/style.css", rel: "stylesheet" },
        tagName: "link",
      },
      {
        attributes: { href: "some-gaps-pkg/style.css", rel: "stylesheet" },
        tagName: "link", // Duplicate: skipped
      },
      {
        attributes: { type: "module" },
        tagName: "script",
        textContent: "/* gaps inline */",
      },
      { attributes: { content: "gaps", name: "gaps-meta" }, tagName: "meta" },
    ];
    await Jx({ $head: headEntries, tagName: "div" } as unknown as JxDocument, target);

    const links = document.head.querySelectorAll(
      'link[href="/node_modules/some-gaps-pkg/style.css"]',
    );
    expect(links.length).toBe(1); // Bare specifier rewritten + deduped
    const script = document.head.querySelector('script[type="module"]');
    expect(script?.textContent).toBe("/* gaps inline */");
    expect(document.head.querySelector('meta[name="gaps-meta"]')).toBeTruthy();
  });
});

// ─── defineElement: property setters and adoptedCallback ────────────────────

describe("defineElement lifecycle gaps", () => {
  test("property setter forwards into reactive state after connection", async () => {
    await defineElement({
      children: ["${state.greeting}"],
      state: { greeting: { default: "hi" } },
      tagName: "gaps-setter-el",
    } as unknown as JxDocument);
    const el = document.createElement("gaps-setter-el") as HTMLElement & {
      greeting: string;
    };
    document.body.append(el);
    await wait();
    expect(el.textContent).toBe("hi");
    el.greeting = "yo"; // Setter → state → re-render
    await wait();
    expect(el.greeting).toBe("yo");
    expect(el.textContent).toBe("yo");
    el.remove();
  });

  test("adoptedCallback invokes state.onAdopted", async () => {
    await defineElement({
      children: [],
      state: {
        onAdopted: { $prototype: "Function", body: "state.wasAdopted = true;" },
        wasAdopted: { default: false },
      },
      tagName: "gaps-adopted-el",
    } as unknown as JxDocument);
    const el = document.createElement("gaps-adopted-el") as HTMLElement & {
      adoptedCallback: () => void;
      wasAdopted: boolean;
    };
    document.body.append(el);
    await wait();
    expect(el.wasAdopted).toBe(false);
    el.adoptedCallback();
    expect(el.wasAdopted).toBe(true);
    el.remove();
  });
});

// ─── renderCustomElementWithProps ────────────────────────────────────────────

describe("renderCustomElementWithProps", () => {
  test("$ref, template, and literal props; reactive forwarding; children; onNodeCreated", async () => {
    await defineElement({
      children: ["${state.p}|${state.t}|${state.plainNum}"],
      state: {
        p: { default: "" },
        plainNum: { default: 0 },
        t: { default: "" },
      },
      tagName: "gaps-props-el",
    } as unknown as JxDocument);

    const created: string[] = [];
    const parentState = reactive({ src: "ref-1", x: "tpl-1" });
    const el = renderNode(
      {
        $props: {
          p: { $ref: "#/state/src" },
          plainNum: 7,
          t: "${state.x}",
        },
        children: [{ tagName: "i" }],
        tagName: "gaps-props-el",
      } as any,
      parentState,
      {
        onNodeCreated: (n: HTMLElement) => created.push(n.tagName.toLowerCase()),
      } as any,
    );
    expect(created).toContain("gaps-props-el");
    expect(created).toContain("i");
    expect(el.querySelector("i")).toBeTruthy();

    document.body.append(el);
    await wait();
    expect(el.textContent).toContain("ref-1|tpl-1|7");

    parentState.src = "ref-2"; // Reactive $ref forwarding
    parentState.x = "tpl-2"; // Reactive template forwarding
    await wait();
    expect(el.textContent).toContain("ref-2|tpl-2|7");
    el.remove();
  });

  test("host style and attributes applied at usage site", async () => {
    await defineElement({
      children: [],
      state: {},
      tagName: "gaps-host-el",
    } as unknown as JxDocument);
    const el = renderNode(
      {
        $props: { anything: 1 },
        attributes: { "data-host": "yes" },
        style: { color: "red" },
        tagName: "gaps-host-el",
      } as any,
      reactive({}),
    );
    expect(el.style.color).toBe("red");
    expect(el.dataset.host).toBe("yes");
  });
});

// ─── distributeSlots ─────────────────────────────────────────────────────────

describe("distributeSlots", () => {
  test("named and unnamed slots receive matching light DOM children", async () => {
    await defineElement({
      children: [
        {
          children: [{ attributes: { name: "head" }, tagName: "slot" }],
          tagName: "header",
        },
        { attributes: { name: "side" }, tagName: "slot" }, // No matches: untouched
        { children: ["fallback"], tagName: "slot" },
      ],
      state: {},
      tagName: "gaps-slot-el",
    } as unknown as JxDocument);

    const el = document.createElement("gaps-slot-el");
    const headChild = document.createElement("span");
    headChild.setAttribute("slot", "head");
    headChild.textContent = "H";
    const bodyChild = document.createElement("b");
    bodyChild.textContent = "B";
    el.append(headChild, document.createTextNode("txt"), bodyChild);
    document.body.append(el);
    await wait();

    const headerSlot = el.querySelector('header slot[name="head"]') as HTMLElement;
    expect(headerSlot.children.length).toBe(1);
    expect(headerSlot.children[0]!.textContent).toBe("H");

    const sideSlot = el.querySelector('slot[name="side"]') as HTMLElement;
    expect(sideSlot.childNodes.length).toBe(0);

    const defaultSlot = el.querySelector("slot:not([name])") as HTMLElement;
    expect(defaultSlot.textContent).toBe("txtB"); // Fallback replaced by unnamed children
    el.remove();
  });

  test("template without slots leaves light children undistributed", async () => {
    await defineElement({
      children: [{ children: ["only-template"], tagName: "p" }],
      state: {},
      tagName: "gaps-noslot-el",
    } as unknown as JxDocument);
    const el = document.createElement("gaps-noslot-el");
    el.append(document.createElement("em"));
    document.body.append(el);
    await wait();
    expect(el.querySelector("em")).toBe(null); // Cleared, never re-attached
    expect(el.textContent).toBe("only-template");
    el.remove();
  });
});
