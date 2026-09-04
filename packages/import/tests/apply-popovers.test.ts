import { describe, expect, test } from "bun:test";
import type { JxElement } from "@jxsuite/schema/types";
import { findPopoverDefects } from "@jxsuite/schema/overlays";
import { applyPopovers, looksLikePanel, targetIdOf } from "../src/apply-popovers.ts";

/** The corpus's offcanvas drawer: an explicit id link from a real `<button>`. */
function drawer(): JxElement {
  return {
    children: [
      {
        attributes: {
          "aria-controls": "offcanvas",
          "data-toggle-panel": "#offcanvas",
          "aria-label": "Menu",
        },
        tagName: "button",
      },
      {
        attributes: { id: "offcanvas", role: "dialog", inert: "", "aria-hidden": "true" },
        children: [{ tagName: "p", textContent: "Menu contents" }] as JxElement[],
        style: { display: "none", position: "fixed", zIndex: "100" },
        tagName: "div",
      },
    ] as JxElement[],
    tagName: "div",
  };
}

/**
 * The corpus's mega-menu: the trigger sits inside a `<span>` and the panel is that span's next
 * sibling, so the panel is the trigger's UNCLE and no id names it.
 */
function megaMenu(): JxElement {
  return {
    children: [
      {
        children: [
          {
            children: [
              {
                attributes: { "aria-haspopup": "true", "aria-expanded": "false" },
                tagName: "button",
              },
            ] as JxElement[],
            tagName: "span",
          },
          {
            children: [{ tagName: "a", textContent: "Pavilions" }] as JxElement[],
            style: { display: "grid", opacity: "0", position: "absolute", zIndex: "10" },
            tagName: "ul",
          },
        ] as JxElement[],
        tagName: "li",
      },
    ] as JxElement[],
    tagName: "nav",
  };
}

describe("applyPopovers", () => {
  test("converts the drawer, pairing button and panel by id", () => {
    const tree = drawer();

    expect(applyPopovers(tree)).toEqual({ converted: 1, skippedNavigatingLinks: 0 });

    const [button, panel] = tree.children as JxElement[];
    expect(button!.attributes!["popovertarget"]).toBe("offcanvas");
    expect(panel!.attributes!["popover"]).toBe("auto");
  });

  test("converts the mega-menu, finding a panel that is the trigger's uncle", () => {
    /* "The invoker's own next sibling" finds nothing on any of the corpus's four dropdowns; the
       panel sits beside an ANCESTOR of the trigger. */
    const tree = megaMenu();

    expect(applyPopovers(tree).converted).toBe(1);

    const li = (tree.children as JxElement[])[0]!;
    const [span, panel] = li.children as JxElement[];
    const button = (span!.children as JxElement[])[0]!;
    expect(panel!.attributes!["popover"]).toBe("auto");
    expect(button!.attributes!["popovertarget"]).toBe(panel!.attributes!["id"]);
  });

  test("moves the closed state into :popover-open instead of leaving it in the base rule", () => {
    /* A UA-origin rule closes the popover, so ANY author `display` in the base rule beats it and
       the panel is laid out whether open or not. This is one of the two defects that have actually
       shipped here. */
    const tree = megaMenu();

    applyPopovers(tree);

    const panel = ((tree.children as JxElement[])[0]!.children as JxElement[])[1]!;
    const style = panel.style as Record<string, unknown>;
    expect(style["display"]).toBeUndefined();
    expect(style["opacity"]).toBeUndefined();
    // The design that described the OPEN panel survives, where it belongs.
    expect(style[":popover-open"]).toEqual({ display: "grid", opacity: "1" });
    expect(style["position"]).toBe("absolute");
  });

  test("drops the concealment that carried no design with it", () => {
    const tree = drawer();

    applyPopovers(tree);

    const panel = (tree.children as JxElement[])[1]!;
    const style = panel.style as Record<string, unknown>;
    /* `display: none` has no inverse - it erased whatever the panel used when open - so nothing is
       written and the element's own default answers instead. Guessing `block` would invent a fact. */
    expect(style[":popover-open"]).toBeUndefined();
    expect(style["display"]).toBeUndefined();
  });

  test("removes the attributes that fought the popover for the same job", () => {
    const tree = drawer();

    applyPopovers(tree);

    const [button, panel] = tree.children as JxElement[];
    expect(panel!.attributes!["inert"]).toBeUndefined();
    expect(panel!.attributes!["aria-hidden"]).toBeUndefined();
    // The browser maintains aria-expanded on an invoker; a captured literal is a stale second writer.
    expect(button!.attributes!["aria-expanded"]).toBeUndefined();
  });

  test("the result satisfies the schema's own popover rules", () => {
    /* `findPopoverDefects` is the acceptance oracle the Studio and the starter conformance test
       both use, so passing it is the real definition of correct here. */
    for (const tree of [drawer(), megaMenu()]) {
      applyPopovers(tree);
      expect(findPopoverDefects(tree).filter((d) => d.severity === "error")).toEqual([]);
    }
  });
});

describe("invokers that are not buttons", () => {
  function anchorInvoker(href: string): JxElement {
    return {
      children: [
        { attributes: { "aria-controls": "menu", href }, tagName: "a" },
        {
          attributes: { id: "menu" },
          children: [{ tagName: "p", textContent: "items" }] as JxElement[],
          style: { opacity: "0", position: "absolute" },
          tagName: "div",
        },
      ] as JxElement[],
      tagName: "div",
    };
  }

  test("converts an anchor that is really a button", () => {
    const tree = anchorInvoker("#");

    expect(applyPopovers(tree)).toEqual({ converted: 1, skippedNavigatingLinks: 0 });

    const invoker = (tree.children as JxElement[])[0]!;
    expect(invoker.tagName).toBe("button");
    expect(invoker.attributes!["type"]).toBe("button");
    expect(invoker.attributes!["href"]).toBeUndefined();
    // An opacity-concealed panel gets the exact inverse, so it is clean outright.
    expect(findPopoverDefects(tree)).toEqual([]);
  });

  test("leaves an anchor that actually navigates alone", () => {
    /* `popovertarget` does nothing on an `<a>`, but turning a real link into a button breaks the
       link - a worse defect than an unconverted menu. */
    const tree = anchorInvoker("/pavilions");

    expect(applyPopovers(tree)).toEqual({ converted: 0, skippedNavigatingLinks: 1 });

    const invoker = (tree.children as JxElement[])[0]!;
    expect(invoker.tagName).toBe("a");
    expect(invoker.attributes!["href"]).toBe("/pavilions");
    expect(invoker.attributes!["popovertarget"]).toBeUndefined();
  });
});

describe("what is not a panel", () => {
  test("hidden but in normal flow is not an overlay", () => {
    /* A responsive alternate and a closed accordion row are hidden too. Being lifted out of the
       flow is what separates a thing drawn ON TOP from a thing not drawn at all - and staples
       whatever it is permanently over the page if got wrong. */
    expect(looksLikePanel({ style: { display: "none" }, tagName: "div" })).toBe(false);
  });

  test("positioned but visible is not a closed overlay", () => {
    expect(looksLikePanel({ style: { position: "absolute" }, tagName: "div" })).toBe(false);
  });

  test("an explicit dialog or inert panel counts without being positioned", () => {
    expect(
      looksLikePanel({
        attributes: { role: "dialog" },
        style: { display: "none" },
        tagName: "div",
      }),
    ).toBe(true);
    expect(
      looksLikePanel({ attributes: { inert: "" }, style: { opacity: "0" }, tagName: "div" }),
    ).toBe(true);
  });

  test("a lone hidden element with no invoker is left as it is", () => {
    const tree: JxElement = {
      children: [
        {
          attributes: { id: "orphan" },
          style: { display: "none", position: "absolute" },
          tagName: "div",
        },
      ] as JxElement[],
      tagName: "div",
    };
    const before = JSON.stringify(tree);

    expect(applyPopovers(tree).converted).toBe(0);
    expect(JSON.stringify(tree)).toBe(before);
  });

  test("two invokers cannot claim the same panel", () => {
    const tree = drawer();
    (tree.children as JxElement[]).splice(1, 0, {
      attributes: { "aria-controls": "offcanvas" },
      tagName: "button",
    });

    expect(applyPopovers(tree).converted).toBe(1);
  });
});

describe("targetIdOf", () => {
  test("reads the id from each attribute that can carry it", () => {
    expect(targetIdOf({ attributes: { "aria-controls": "menu" }, tagName: "button" })).toBe("menu");
    expect(
      targetIdOf({ attributes: { "data-toggle-panel": "#offcanvas" }, tagName: "button" }),
    ).toBe("offcanvas");
    expect(targetIdOf({ attributes: { href: "#panel" }, tagName: "a" })).toBe("panel");
  });

  test("does not read a navigating href as an id", () => {
    expect(targetIdOf({ attributes: { href: "/pavilions" }, tagName: "a" })).toBeNull();
    expect(targetIdOf({ attributes: { href: "#" }, tagName: "a" })).toBeNull();
  });

  test("is null with no attributes at all", () => {
    expect(targetIdOf({ tagName: "button" })).toBeNull();
  });
});

describe("visibility-concealed panels", () => {
  test("gets the exact inverse written into the open rule", () => {
    const tree: JxElement = {
      children: [
        { attributes: { "aria-controls": "p" }, tagName: "button" },
        {
          attributes: { id: "p" },
          children: [{ tagName: "p", textContent: "x" }] as JxElement[],
          style: { position: "fixed", visibility: "hidden" },
          tagName: "div",
        },
      ] as JxElement[],
      tagName: "div",
    };

    expect(applyPopovers(tree).converted).toBe(1);

    const style = (tree.children as JxElement[])[1]!.style as Record<string, unknown>;
    expect(style["visibility"]).toBeUndefined();
    expect(style[":popover-open"]).toEqual({ visibility: "visible" });
    expect(findPopoverDefects(tree)).toEqual([]);
  });

  test("collapse counts as hidden", () => {
    expect(
      looksLikePanel({ style: { position: "absolute", visibility: "collapse" }, tagName: "div" }),
    ).toBe(true);
  });
});

describe("nodes carrying no style at all", () => {
  test("an element with no style is not a panel", () => {
    expect(looksLikePanel({ tagName: "div" })).toBe(false);
  });

  test("an invoker whose named panel is not concealed is left alone", () => {
    const tree: JxElement = {
      children: [
        { attributes: { "aria-controls": "plain" }, tagName: "button" },
        { attributes: { id: "plain" }, tagName: "div" },
      ] as JxElement[],
      tagName: "div",
    };
    const before = JSON.stringify(tree);

    expect(applyPopovers(tree).converted).toBe(0);
    expect(JSON.stringify(tree)).toBe(before);
  });

  test("an invoker with no resolvable panel anywhere above it is left alone", () => {
    const tree: JxElement = {
      children: [
        {
          children: [{ attributes: { "aria-haspopup": "true" }, tagName: "button" }] as JxElement[],
          tagName: "span",
        },
      ] as JxElement[],
      tagName: "div",
    };

    expect(applyPopovers(tree).converted).toBe(0);
  });
});
