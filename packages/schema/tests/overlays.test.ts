/**
 * Popover rules — one case per finding, plus the two facts the rules exist to encode.
 *
 * Every fixture here is reduced from something that actually shipped: the base-`display` drawer is
 * Elite's and Burntrock's, the `<a popovertarget>` is jxsuite.com's (nine of them), the
 * anchor-without-fallback is Burntrock's services menu.
 */
import { describe, expect, test } from "bun:test";

import {
  POPOVER_DEFAULT_MODE,
  POPOVER_INVOKER_TAGS,
  POPOVER_MODES,
  documentHasPopover,
  findPopoverDefects,
  isPopover,
  popoverDisplayRepair,
  popoverIdsIn,
  popoverModeOf,
} from "../src/overlays";
import type { JxElement, JxStyle } from "../types";

/** A conforming drawer, so a test can perturb exactly one thing and see exactly one finding. */
function goodPanel(id = "menu"): JxElement {
  return {
    attributes: { "aria-label": "Site menu", popover: "auto" },
    id,
    style: {
      ":popover-open": { display: "flex", transform: "translateX(0)" },
      inset: "0 0 0 auto",
      transform: "translateX(100%)",
      transition: "transform 0.3s, display 0.3s allow-discrete, overlay 0.3s allow-discrete",
    },
    tagName: "nav",
  };
}

function trigger(target = "menu"): JxElement {
  return { attributes: { popovertarget: target, type: "button" }, tagName: "button" };
}

/** Wrap nodes in a document root. */
function doc(...children: JxElement[]): JxElement {
  return { children, tagName: "div" };
}

/** The rule ids a document reports, deduped, so a test names what it means. */
function rules(d: JxElement): string[] {
  return [...new Set(findPopoverDefects(d).map((f) => f.rule))].toSorted();
}

/** The usual document — a trigger and the panel under test — reported as rule ids. */
function rulesFor(panel: JxElement, ...extra: JxElement[]): string[] {
  return rules(doc(trigger(), panel, ...extra));
}

/** The same document's defects, unfiltered. */
function defectsFor(panel: JxElement, ...extra: JxElement[]) {
  return findPopoverDefects(doc(trigger(), panel, ...extra));
}

/** The first defect of a given rule in the usual document, or undefined. */
function findRule(panel: JxElement, rule: string, ...extra: JxElement[]) {
  return defectsFor(panel, ...extra).find((f) => f.rule === rule);
}

describe("constants", () => {
  test("the three keywords, and the house spelling among them", () => {
    expect(POPOVER_MODES).toEqual(["auto", "manual", "hint"]);
    expect(POPOVER_MODES).toContain(POPOVER_DEFAULT_MODE);
  });

  test("only <button> and <input> can invoke — the whole point of invoker-not-button", () => {
    expect([...POPOVER_INVOKER_TAGS].toSorted()).toEqual(["button", "input"]);
    expect(POPOVER_INVOKER_TAGS.has("a")).toBe(false);
  });
});

describe("popoverModeOf / isPopover", () => {
  test('reads the raw value, so "" and "auto" stay distinguishable', () => {
    expect(popoverModeOf({ attributes: { popover: "auto" } })).toBe("auto");
    expect(popoverModeOf({ attributes: { popover: "" } })).toBe("");
  });

  test("a non-popover has no mode, and a bound one is a popover with no readable mode", () => {
    expect(popoverModeOf({ tagName: "div" })).toBeNull();
    expect(isPopover({ tagName: "div" })).toBe(false);
    const bound: JxElement = { attributes: { popover: { $ref: "#/state/mode" } }, tagName: "nav" };
    expect(popoverModeOf(bound)).toBeNull();
    expect(isPopover(bound)).toBe(true);
  });

  test("a missing or non-object attributes bag is not a popover", () => {
    expect(isPopover({ tagName: "div" })).toBe(false);
    expect(isPopover({ attributes: null as never, tagName: "div" })).toBe(false);
  });
});

describe("popoverIdsIn", () => {
  test("collects ids from both spellings, deduped, in document order", () => {
    const d = doc(
      goodPanel("a"),
      { attributes: { id: "b", popover: "auto" }, tagName: "nav" },
      goodPanel("a"),
    );
    expect(popoverIdsIn(d)).toEqual(["a", "b"]);
  });

  test("reaches into $switch cases and repeater templates", () => {
    const d: JxElement = {
      children: [
        { $switch: "#/state/x", cases: { one: goodPanel("in-case") }, tagName: "div" },
        { $prototype: "Array", items: [], map: goodPanel("in-map"), tagName: "div" },
        {
          children: { $prototype: "Array", items: [], map: goodPanel("legacy") } as never,
          tagName: "ul",
        },
      ],
      tagName: "div",
    };
    expect(popoverIdsIn(d).toSorted()).toEqual(["in-case", "in-map", "legacy"]);
  });

  test("a popover with no id contributes nothing, and an empty id is not an id", () => {
    expect(popoverIdsIn(doc({ attributes: { popover: "auto" }, tagName: "nav" }))).toEqual([]);
    expect(popoverIdsIn(doc({ attributes: { id: "", popover: "auto" }, tagName: "nav" }))).toEqual(
      [],
    );
  });
});

describe("a conforming document reports nothing", () => {
  test("trigger plus panel, with a close button inside", () => {
    const panel = goodPanel();
    panel.children = [
      {
        attributes: { popovertarget: "menu", popovertargetaction: "hide", type: "button" },
        tagName: "button",
      },
      { attributes: { href: "/about" }, tagName: "a" },
    ];
    expect(defectsFor(panel)).toEqual([]);
  });
});

describe("invoker-not-button — the fact nine jxsuite.com links got wrong", () => {
  test("popovertarget on an <a> is an error with a mechanical repair", () => {
    const panel = goodPanel();
    panel.children = [
      {
        attributes: { href: "/x", popovertarget: "menu", popovertargetaction: "hide" },
        tagName: "a",
      },
    ];
    const found = defectsFor(panel);
    const f = found.find((x) => x.rule === "invoker-not-button");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.fix).toBe("invoker");
    expect(f?.path).toEqual(["children", 1, "children", 0]);
  });

  test("it suppresses the target rules for the same node — one defect, one finding", () => {
    const panel = goodPanel();
    panel.children = [{ attributes: { popovertarget: "nonexistent" }, tagName: "a" }];
    const found = defectsFor(panel).filter((f) => f.path.length === 4);
    expect(found.map((f) => f.rule)).toEqual(["invoker-not-button"]);
  });

  test("an element with no tagName still reports", () => {
    const d = doc(trigger(), goodPanel(), { attributes: { popovertarget: "menu" } });
    expect(rules(d)).toContain("invoker-not-button");
  });
});

describe("target rules", () => {
  test("target-missing names the popovers that do exist", () => {
    const d = doc(
      { attributes: { popovertarget: "gone", type: "button" }, tagName: "button" },
      goodPanel("menu"),
    );
    const f = findPopoverDefects(d).find((x) => x.rule === "target-missing");
    expect(f?.severity).toBe("error");
    expect(f?.detail).toContain('"menu"');
    expect(f?.fix).toBeUndefined();
  });

  test("it stays silent in a document with no popover of its own — the panel may be in a component", () => {
    const d = doc({
      attributes: { popovertarget: "elsewhere", type: "button" },
      tagName: "button",
    });
    expect(rules(d)).not.toContain("target-missing");
  });

  test("target-mismatch — Burntrock's drawer button naming the dropdown", () => {
    const drawer = goodPanel("drawer");
    drawer.children = [
      { attributes: { popovertarget: "dropdown", type: "button" }, tagName: "button" },
    ];
    const d = doc(trigger("drawer"), trigger("dropdown"), drawer, goodPanel("dropdown"));
    const f = findPopoverDefects(d).find((x) => x.rule === "target-mismatch");
    expect(f?.severity).toBe("warn");
    expect(f?.message).toContain("#drawer");
  });

  test("a button inside the panel it targets is correct", () => {
    const panel = goodPanel("menu");
    panel.children = [
      {
        attributes: { popovertarget: "menu", popovertargetaction: "hide", type: "button" },
        tagName: "button",
      },
    ];
    expect(rulesFor(panel)).not.toContain("target-mismatch");
  });

  test("a button inside an anonymous panel cannot mismatch — there is no id to compare", () => {
    const panel: JxElement = {
      attributes: { popover: "auto" },
      children: [{ attributes: { popovertarget: "menu", type: "button" }, tagName: "button" }],
      style: { ":popover-open": { display: "flex" } },
      tagName: "nav",
    };
    const named = goodPanel();
    expect(rulesFor(panel, named)).not.toContain("target-mismatch");
  });
});

describe("link-does-not-dismiss — the two cases navigation cannot cover", () => {
  test("target=_blank inside a panel — jxsuite.com's GitHub link", () => {
    const panel = goodPanel();
    panel.children = [
      { attributes: { href: "https://github.com/x", target: "_blank" }, tagName: "a" },
    ];
    const f = defectsFor(panel).find((x) => x.rule === "link-does-not-dismiss");
    expect(f?.severity).toBe("warn");
    expect(f?.detail).toContain("new tab");
  });

  test("a same-document fragment — Burntrock's /#services", () => {
    const panel = goodPanel();
    panel.children = [{ attributes: { href: "/#services" }, tagName: "a" }];
    const f = defectsFor(panel).find((x) => x.rule === "link-does-not-dismiss");
    expect(f?.detail).toContain("fragment");
  });

  test("href written as a top-level key is read too", () => {
    const panel = goodPanel();
    panel.children = [{ href: "/#services", tagName: "a" } as JxElement];
    expect(rulesFor(panel)).toContain("link-does-not-dismiss");
  });

  test("an ordinary cross-document link is fine, and a link outside any panel is not judged", () => {
    const panel = goodPanel();
    panel.children = [{ attributes: { href: "/about" }, tagName: "a" }];
    const d = doc(trigger(), panel, { attributes: { href: "/#top" }, tagName: "a" });
    expect(rules(d)).not.toContain("link-does-not-dismiss");
  });
});

describe("invalid-mode", () => {
  test("a keyword that is not one of the three", () => {
    const panel = goodPanel();
    (panel.attributes as Record<string, unknown>).popover = "modal";
    const f = findRule(panel, "invalid-mode");
    expect(f?.severity).toBe("error");
    expect(f?.fix).toBe("mode");
  });

  test('a boolean, which two compiler emitters turn into popover="true" = manual', () => {
    const panel = goodPanel();
    (panel.attributes as Record<string, unknown>).popover = true;
    const f = findRule(panel, "invalid-mode");
    expect(f?.message).toContain("boolean");
    expect(f?.fix).toBe("mode");
  });

  test('"" and the three keywords are all accepted', () => {
    for (const mode of ["", ...POPOVER_MODES]) {
      const panel = goodPanel();
      (panel.attributes as Record<string, unknown>).popover = mode;
      expect(rulesFor(panel)).not.toContain("invalid-mode");
    }
  });
});

describe("base-display — the defect that shipped twice", () => {
  test("display in the base rule is an error with a repair", () => {
    const panel = goodPanel();
    (panel.style as JxStyle).display = "flex";
    const f = findRule(panel, "base-display");
    expect(f?.severity).toBe("error");
    expect(f?.fix).toBe("display");
    expect(f?.message).toContain("#menu");
  });

  test("display inside a breakpoint is the same defect through another door", () => {
    const panel = goodPanel();
    (panel.style as JxStyle)["@--md"] = { display: "flex" };
    const f = defectsFor(panel).find((x) => x.rule === "breakpoint-display");
    expect(f?.message).toContain("@--md");
    expect(f?.fix).toBe("display");
  });

  test("visibility is the ad-hoc second mechanism Burntrock added", () => {
    const panel = goodPanel();
    (panel.style as JxStyle).visibility = "hidden";
    const f = findRule(panel, "base-visibility");
    expect(f?.severity).toBe("warn");
    expect(f?.fix).toBe("display");
  });

  test("a popover with no style at all reports no display defect", () => {
    const panel: JxElement = { attributes: { id: "bare", popover: "auto" }, tagName: "nav" };
    const d = doc(trigger("bare"), panel);
    expect(rules(d)).not.toContain("base-display");
  });
});

describe("no-open-rule", () => {
  test("a panel with no :popover-open rule at all", () => {
    const panel: JxElement = {
      attributes: { id: "menu", popover: "auto" },
      style: { inset: "0" },
      tagName: "nav",
    };
    expect(rulesFor(panel)).toContain("no-open-rule");
  });

  test("a block-layout panel with no display anywhere is fine — two of jxsuite.com's three", () => {
    const panel = goodPanel();
    panel.style = { ":popover-open": { transform: "none" }, inset: "0" };
    expect(rulesFor(panel)).not.toContain("no-open-display");
  });

  test("the & spelling counts, and so does one nested in a breakpoint", () => {
    const amp = goodPanel();
    amp.style = { "&:popover-open": { display: "flex" } };
    expect(rulesFor(amp)).not.toContain("no-open-rule");
    const nested = goodPanel();
    nested.style = { "@--md": { ":popover-open": { display: "flex" } } };
    expect(rulesFor(nested)).not.toContain("no-open-rule");
  });

  test("a breakpoint block that holds no open rule does not satisfy it", () => {
    const panel = goodPanel();
    panel.style = { "@--md": { inset: "0" }, inset: "0 0 0 auto" };
    expect(rulesFor(panel)).toContain("no-open-rule");
  });

  test("a scalar under a selector-looking key is not a rule", () => {
    const panel = goodPanel();
    panel.style = { ":popover-open": "nonsense" as never };
    expect(rulesFor(panel)).toContain("no-open-rule");
  });
});

describe("no-open-display — flex declared, display never turned on", () => {
  test("a flex panel whose open rule supplies no display is an error", () => {
    const panel = goodPanel();
    panel.style = { ":popover-open": { transform: "none" }, flexDirection: "column" };
    const f = findRule(panel, "no-open-display");
    expect(f?.severity).toBe("error");
    expect(f?.fix).toBe("open-display");
  });

  test("the kebab spelling counts, and so does gap", () => {
    for (const prop of ["flex-direction", "gap", "gridTemplateColumns"]) {
      const panel = goodPanel();
      panel.style = { ":popover-open": { transform: "none" }, [prop]: "1rem" };
      expect(rulesFor(panel)).toContain("no-open-display");
    }
  });

  test("it does not fire once the open rule sets a display — the conforming shape", () => {
    const panel = goodPanel();
    expect(rulesFor(panel)).not.toContain("no-open-display");
  });

  test("it does not fire when the base rule already sets display — base-display owns that", () => {
    const panel = goodPanel();
    panel.style = { display: "flex", flexDirection: "column" };
    const found = rulesFor(panel);
    expect(found).toContain("base-display");
    expect(found).not.toContain("no-open-display");
  });
});

describe("cut-exit", () => {
  test("transitioning display without overlay cuts the exit animation", () => {
    const panel = goodPanel();
    (panel.style as JxStyle).transition = "transform 0.3s, display 0.3s allow-discrete";
    const f = findRule(panel, "cut-exit");
    expect(f?.severity).toBe("warn");
  });

  test("it looks inside at-rule blocks too, and reports once", () => {
    const panel = goodPanel();
    (panel.style as JxStyle).transition = "transform 0.3s, display 0.3s allow-discrete";
    (panel.style as JxStyle)["@--md"] = { transition: "opacity 0.2s, display 0.2s allow-discrete" };
    expect(defectsFor(panel).filter((f) => f.rule === "cut-exit")).toHaveLength(1);
  });

  test("a transition that mentions neither is fine", () => {
    const panel = goodPanel();
    (panel.style as JxStyle).transition = "transform 0.3s";
    expect(rulesFor(panel)).not.toContain("cut-exit");
  });
});

describe("unsafe-anchor — Burntrock's services dropdown", () => {
  test("position-anchor with no fallback", () => {
    const panel = goodPanel();
    Object.assign(panel.style as JxStyle, {
      inset: "unset",
      positionAnchor: "--btn",
      top: "anchor(bottom)",
    });
    const f = findRule(panel, "unsafe-anchor");
    expect(f?.detail).toContain("STATIC position");
  });

  test("an anchor() inset alone is enough to trip it", () => {
    const panel = goodPanel();
    Object.assign(panel.style as JxStyle, { top: "anchor(bottom)" });
    expect(rulesFor(panel)).toContain("unsafe-anchor");
  });

  test("position-area, position-try-fallbacks or a @supports block each satisfy it", () => {
    for (const fallback of [
      { positionArea: "block-end" },
      { positionTryFallbacks: "flip-block" },
      { "@supports not (position-area: block-end)": { top: "5rem" } },
    ]) {
      const panel = goodPanel();
      Object.assign(panel.style as JxStyle, { positionAnchor: "--btn" }, fallback);
      expect(rulesFor(panel)).not.toContain("unsafe-anchor");
    }
  });

  test("the kebab spellings are read as well as the camel ones", () => {
    const panel = goodPanel();
    Object.assign(panel.style as JxStyle, {
      "position-anchor": "--btn",
      "position-area": "block-end",
    });
    expect(rulesFor(panel)).not.toContain("unsafe-anchor");
  });

  test("a panel that does not use anchor positioning is not asked for a fallback", () => {
    const panel = goodPanel();
    expect(rulesFor(panel)).not.toContain("unsafe-anchor");
  });
});

describe("no-invoker", () => {
  test("a popover nothing opens", () => {
    const f = findPopoverDefects(doc(goodPanel())).find((x) => x.rule === "no-invoker");
    expect(f?.severity).toBe("warn");
  });

  test("an <a> naming it does not count, because an <a> cannot invoke", () => {
    const panel = goodPanel();
    const d = doc({ attributes: { href: "/x", popovertarget: "menu" }, tagName: "a" }, panel);
    expect(rules(d)).toContain("no-invoker");
  });

  test("an anonymous popover is never reported — there is no id to match", () => {
    expect(
      rules(
        doc({
          attributes: { popover: "auto" },
          style: { ":popover-open": { display: "flex" } },
          tagName: "nav",
        }),
      ),
    ).not.toContain("no-invoker");
  });
});

describe("popoverDisplayRepair", () => {
  test("moves the base display into :popover-open", () => {
    const style: JxStyle = { display: "flex", transform: "translateX(100%)" };
    expect(popoverDisplayRepair(style)).toEqual({
      base: ["display"],
      breakpoints: [],
      openDisplay: "flex",
    });
  });

  test("keeps an existing open display and just deletes the base one", () => {
    const style: JxStyle = { ":popover-open": { display: "grid" }, display: "flex" };
    expect(popoverDisplayRepair(style)).toEqual({
      base: ["display"],
      breakpoints: [],
      openDisplay: null,
    });
  });

  test("reads the & spelling of the open rule too", () => {
    const style: JxStyle = { "&:popover-open": { display: "grid" }, display: "flex" };
    expect(popoverDisplayRepair(style)?.openDisplay).toBeNull();
  });

  test("takes visibility with it, and names the breakpoints without deleting them", () => {
    const style: JxStyle = { "@--md": { display: "flex" }, visibility: "hidden" };
    expect(popoverDisplayRepair(style)).toEqual({
      base: ["visibility"],
      breakpoints: ["@--md"],
      openDisplay: null,
    });
  });

  test("nothing to repair, and nothing to repair on an absent style", () => {
    expect(popoverDisplayRepair({ inset: "0" })).toBeNull();
    const absent: JxStyle | undefined = undefined;
    expect(popoverDisplayRepair(absent)).toBeNull();
  });
});

describe("documentHasPopover", () => {
  test("a document that declares one, however it is spelled or nested", () => {
    const simple = doc(goodPanel());
    expect(documentHasPopover(simple)).toBe(true);
    const inCase = doc({
      $switch: "#/state/x",
      cases: { one: goodPanel() },
      tagName: "div",
    } as JxElement);
    expect(documentHasPopover(inCase)).toBe(true);
  });

  test("a document with none", () => {
    const plain = doc(trigger(), { tagName: "p" });
    expect(documentHasPopover(plain)).toBe(false);
  });
});
