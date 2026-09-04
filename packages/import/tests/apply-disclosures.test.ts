import { describe, expect, test } from "bun:test";
import type { JxElement } from "@jxsuite/schema/types";
import { countLeaves } from "../src/apply-accordions.ts";
import {
  applyDisclosures,
  isDisclosureInvoker,
  isDisclosurePanel,
} from "../src/apply-disclosures.ts";

/**
 * The corpus's "read more" disclosure, verbatim in shape: the panel is hidden by the ATTRIBUTE and
 * carries no style at all, and it sits BEFORE the control that opens it.
 */
function readMore(id: string, tabindex = "-1"): JxElement {
  return {
    children: [
      { children: [{ tagName: "p", textContent: "Visible intro" }] as JxElement[], tagName: "div" },
      {
        attributes: { hidden: "", id },
        children: [{ tagName: "p", textContent: `extra copy for ${id}` }] as JxElement[],
        tagName: "div",
      },
      {
        children: [
          {
            attributes: {
              "aria-controls": id,
              "aria-expanded": "false",
              role: "button",
              tabindex,
            },
            children: [
              {
                attributes: { "data-more-text": "Read more" },
                children: ["Read more"] as never,
                tagName: "span",
              },
            ] as JxElement[],
            tagName: "a",
          },
        ] as JxElement[],
        tagName: "p",
      },
    ] as JxElement[],
    tagName: "div",
  };
}

describe("applyDisclosures", () => {
  test("converts an ARIA-declared disclosure into <details>", () => {
    const tree = readMore("more-1");

    expect(applyDisclosures(tree)).toEqual({ converted: 1, duplicateInvokers: 0 });

    const kids = tree.children as JxElement[];
    expect(kids.map((c) => c.tagName)).toEqual(["div", "details"]);
  });

  test("puts the control's label in <summary> and the panel after it", () => {
    const tree = readMore("more-1");

    applyDisclosures(tree);

    const details = (tree.children as JxElement[])[1]!;
    const [summary, panel] = details.children as JxElement[];
    expect(summary!.tagName).toBe("summary");
    expect(countLeaves(summary!)).toEqual(["t:Read more"]);
    expect(countLeaves(panel!)).toEqual(["t:extra copy for more-1"]);
  });

  test("unwraps the old control so summary does not nest an interactive element", () => {
    /* `<summary>` IS the control once this lands. Unwrapping rather than deleting keeps the label,
       which is the only part of the control a reader ever saw. */
    const tree = readMore("more-1");

    applyDisclosures(tree);

    const serialized = JSON.stringify(tree);
    expect(serialized).not.toContain("aria-expanded");
    expect(serialized).not.toContain("aria-controls");
    expect(serialized).not.toContain('"tagName": "a"');
    expect(serialized).toContain("Read more");
  });

  test("unhides the panel so its content is reachable", () => {
    const tree = readMore("more-1");

    applyDisclosures(tree);

    const panel = ((tree.children as JxElement[])[1]!.children as JxElement[])[1]!;
    expect(panel.attributes!["hidden"]).toBeUndefined();
    // The id survives, because something else on the page may still refer to it.
    expect(panel.attributes!["id"]).toBe("more-1");
  });

  test("places the details where the first of the pair sat", () => {
    /* The source order is panel then control; `<details>` always renders its summary above its
       content, so the label moves up to where the pair began. */
    const tree = readMore("more-1");

    applyDisclosures(tree);

    const kids = tree.children as JxElement[];
    expect(kids[0]!.tagName).toBe("div");
    expect(kids[1]!.tagName).toBe("details");
  });

  test("conserves every leaf", () => {
    const tree = readMore("more-1");
    const before = countLeaves(tree);

    applyDisclosures(tree);

    expect(countLeaves(tree)).toEqual(before);
  });

  test("converts several disclosures under one parent", () => {
    const merged: JxElement = {
      children: [
        ...(readMore("more-1").children as JxElement[]),
        ...(readMore("more-2").children as JxElement[]),
      ] as JxElement[],
      tagName: "div",
    };

    expect(applyDisclosures(merged).converted).toBe(2);
    expect((merged.children as JxElement[]).filter((c) => c.tagName === "details")).toHaveLength(2);
  });

  test("also converts a panel hidden by display rather than the attribute", () => {
    const tree = readMore("more-1");
    const panel = (tree.children as JxElement[])[1]!;
    delete (panel.attributes as Record<string, unknown>)["hidden"];
    panel.style = { display: "none" };

    expect(applyDisclosures(tree).converted).toBe(1);
  });
});

describe("a second control for a panel already claimed", () => {
  test("stops reporting a state it no longer governs", () => {
    /* Two controls pointing at one panel is the read-more / show-less pair. Once the panel is
       inside a `<details>`, a leftover `aria-expanded="false"` lies to a screen reader. */
    const tree = readMore("more-1");
    (tree.children as JxElement[]).push({
      children: [
        {
          attributes: { "aria-controls": "more-1", "aria-expanded": "false", role: "button" },
          children: ["Show less"] as never,
          tagName: "a",
        },
      ] as JxElement[],
      tagName: "p",
    });

    const result = applyDisclosures(tree);

    expect(result.converted).toBe(1);
    expect(result.duplicateInvokers).toBe(1);
    const serialized = JSON.stringify(tree);
    expect(serialized).not.toContain("aria-expanded");
    // The label it carried is still there; only its controlhood was removed.
    expect(serialized).toContain("Show less");
  });
});

describe("what a disclosure is not", () => {
  test("a positioned concealed panel is an overlay, and belongs to the popover pass", () => {
    expect(
      isDisclosurePanel({
        attributes: { hidden: "" },
        style: { position: "absolute" },
        tagName: "div",
      }),
    ).toBe(false);
  });

  test("a visible panel is not a disclosure panel", () => {
    expect(isDisclosurePanel({ attributes: { id: "x" }, tagName: "div" })).toBe(false);
  });

  test("a control without both halves of the contract is not an invoker", () => {
    expect(
      isDisclosureInvoker({ attributes: { "aria-expanded": "false" }, tagName: "button" }),
    ).toBe(false);
    expect(isDisclosureInvoker({ attributes: { "aria-controls": "x" }, tagName: "button" })).toBe(
      false,
    );
    expect(isDisclosureInvoker({ tagName: "button" })).toBe(false);
  });

  test("an invoker whose panel does not exist is left alone", () => {
    const tree = readMore("more-1");
    const panel = (tree.children as JxElement[])[1]!;
    (panel.attributes as Record<string, unknown>)["id"] = "somewhere-else";
    const before = JSON.stringify(tree);

    expect(applyDisclosures(tree).converted).toBe(0);
    expect(JSON.stringify(tree)).toBe(before);
  });

  test("an invoker and panel with no common parent are left alone", () => {
    const tree: JxElement = {
      children: [
        {
          children: [
            {
              attributes: { "aria-controls": "far", "aria-expanded": "false" },
              children: ["open"] as never,
              tagName: "button",
            },
          ] as JxElement[],
          tagName: "section",
        },
        {
          children: [
            { attributes: { hidden: "", id: "far" }, children: ["body"] as never, tagName: "div" },
          ] as JxElement[],
          tagName: "aside",
        },
      ] as JxElement[],
      tagName: "div",
    };
    const before = JSON.stringify(tree);

    expect(applyDisclosures(tree).converted).toBe(0);
    expect(JSON.stringify(tree)).toBe(before);
  });

  test("terminates when a converted disclosure is revisited", () => {
    /* A summary produced by this pass must never be offered back as a candidate, or the loop over
       one parent would not end. */
    const tree = readMore("more-1");

    expect(applyDisclosures(tree).converted).toBe(1);
    expect(applyDisclosures(tree).converted).toBe(0);
  });
});

describe("controls whose label is bare text", () => {
  test("keeps a label that the parser collapsed into textContent", () => {
    /* `htmlToJx` folds a lone text child into `textContent` and emits no `children` array, which is
       what most real controls look like. Reading children alone drops the label, and the leaf
       census then abandons the rewrite - correct, but the wrong outcome. */
    const tree: JxElement = {
      children: [
        {
          attributes: { hidden: "", id: "p1" },
          children: [{ tagName: "p", textContent: "body copy" }] as JxElement[],
          tagName: "div",
        },
        {
          children: [
            {
              attributes: { "aria-controls": "p1", "aria-expanded": "false", role: "button" },
              tagName: "a",
              textContent: "Read more",
            },
          ] as JxElement[],
          tagName: "p",
        },
      ] as JxElement[],
      tagName: "div",
    };
    const before = countLeaves(tree);

    expect(applyDisclosures(tree).converted).toBe(1);
    expect(countLeaves(tree)).toEqual(before);

    const details = (tree.children as JxElement[])[0]!;
    expect(details.tagName).toBe("details");
    expect(countLeaves((details.children as JxElement[])[0]!)).toEqual(["t:Read more"]);
  });
});

describe("control shapes the unwrap has to survive", () => {
  function pair(invokerBranch: JxElement): JxElement {
    return {
      children: [
        {
          attributes: { hidden: "", id: "p1" },
          children: [{ tagName: "p", textContent: "body copy" }] as JxElement[],
          tagName: "div",
        },
        invokerBranch,
      ] as JxElement[],
      tagName: "div",
    };
  }

  test("a control that is itself the direct child loses its controlhood", () => {
    /* There is no enclosing element to unwrap it out of, so without an explicit strip its own
       `aria-expanded` would ride onto the `<summary>` and report a state it no longer owns. */
    const tree = pair({
      attributes: { "aria-controls": "p1", "aria-expanded": "false", role: "button" },
      tagName: "button",
      textContent: "Toggle",
    });

    expect(applyDisclosures(tree).converted).toBe(1);

    const summary = ((tree.children as JxElement[])[0]!.children as JxElement[])[0]!;
    expect(summary.tagName).toBe("summary");
    expect(JSON.stringify(summary)).not.toContain("aria-expanded");
    expect(countLeaves(summary)).toEqual(["t:Toggle"]);
  });

  test("a control nested beside its own sibling text keeps both", () => {
    const tree = pair({
      children: [
        "Prefix ",
        {
          children: [
            {
              attributes: { "aria-controls": "p1", "aria-expanded": "false" },
              tagName: "a",
              textContent: "Read more",
            },
          ] as JxElement[],
          tagName: "em",
        },
      ] as never,
      tagName: "p",
    });
    const before = countLeaves(tree);

    expect(applyDisclosures(tree).converted).toBe(1);
    expect(countLeaves(tree)).toEqual(before);
  });

  test("a control with no label at all still converts", () => {
    // An icon-only control carries its whole appearance in CSS and holds no leaves of its own.
    const tree = pair({
      children: [
        {
          attributes: { "aria-controls": "p1", "aria-expanded": "false" },
          style: { backgroundImage: "url(/i.svg)" },
          tagName: "button",
        },
      ] as JxElement[],
      tagName: "p",
    });

    expect(applyDisclosures(tree).converted).toBe(1);
  });
});
