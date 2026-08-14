import { renderInto } from "./harness";
import { describe, expect, test } from "bun:test";
import { html } from "lit-html";
import {
  countProvenance,
  hasProvenance,
  provenanceSummaryText,
  provenanceTitle,
  renderProvenanceChip,
  renderProvenanceDots,
} from "../src/panels/provenance";
import type { FieldProvenance, ProvenanceState } from "../src/panels/provenance";

async function chipFor(p: FieldProvenance, prop = "color") {
  const c = await renderInto(html`${renderProvenanceChip(prop, p)}`);
  return c;
}

describe("renderProvenanceChip", () => {
  test("set renders the accent dot, and clicking it clears", async () => {
    let cleared = 0;
    const c = await chipFor({ onClick: () => (cleared += 1), state: "set" });
    const dot = c.querySelector(".provenance-chip")!;
    expect(dot.tagName.toLowerCase()).toBe("span");
    expect(dot.classList.contains("set-dot")).toBe(true);
    expect(dot.getAttribute("title")).toBe("Set here — click to clear color");
    dot.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(cleared).toBe(1);
  });

  test("inherited names the donor and is a button when it can jump", async () => {
    let jumped = 0;
    const c = await chipFor({ donor: "Md", onClick: () => (jumped += 1), state: "inherited" });
    const el = c.querySelector(".provenance-chip")!;
    expect(el.tagName.toLowerCase()).toBe("button");
    expect(el.textContent!.trim()).toBe("from Md");
    expect(el.getAttribute("title")).toBe("Inherited from Md — click to go there");
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(jumped).toBe(1);
  });

  test("a chip with nowhere to go is a span, not a dead button", async () => {
    const c = await chipFor({ state: "inherited" });
    const el = c.querySelector(".provenance-chip")!;
    expect(el.tagName.toLowerCase()).toBe("span");
    expect(el.textContent!.trim()).toBe("inherited");
    expect(el.getAttribute("title")).toBe("Inherited from the cascade — click to go there");
  });

  test("bound names the signal, and falls back to the word when it cannot", async () => {
    const named = await chipFor({ donor: "brand", onClick: () => {}, state: "bound" });
    expect(named.querySelector(".provenance-chip")!.textContent!.trim()).toBe("brand");
    expect(named.querySelector(".provenance-chip")!.getAttribute("title")).toBe(
      "Bound to brand — click to open it",
    );

    const anonymous = await chipFor({ state: "bound" });
    expect(anonymous.querySelector(".provenance-chip")!.textContent!.trim()).toBe("bound");
    expect(anonymous.querySelector(".provenance-chip")!.getAttribute("title")).toBe("Bound");
  });

  test("default renders nothing at all — absence is the ghost", async () => {
    const c = await chipFor({ state: "default" });
    expect(c.querySelector(".provenance-chip")).toBeNull();
    expect(c.textContent!.trim()).toBe("");
  });

  test("an explicit title wins over the derived one", () => {
    expect(provenanceTitle("color", { state: "set", title: "Say this" })).toBe("Say this");
    expect(provenanceTitle("color", { state: "default" })).toBe(
      "Not set — color falls back to the browser default",
    );
  });
});

describe("counting", () => {
  const states: ProvenanceState[] = ["set", "set", "inherited", "default", "bound"];

  test("tallies the three informative states and ignores defaults", () => {
    expect(countProvenance(states)).toEqual({ bound: 1, inherited: 1, mixed: 0, set: 2 });
    expect(hasProvenance(countProvenance(states))).toBe(true);
    expect(hasProvenance(countProvenance(["default", "default"]))).toBe(false);
  });

  test("reads the tally as a sentence", () => {
    expect(provenanceSummaryText(countProvenance(states))).toBe(
      "2 set here · 1 inherited · 1 bound",
    );
    expect(provenanceSummaryText(countProvenance(["default"]))).toBe("nothing set");
  });
});

describe("renderProvenanceDots", () => {
  test("nothing to say renders nothing", async () => {
    const c = await renderInto(
      html`${renderProvenanceDots({ bound: 0, inherited: 0, mixed: 0, set: 0 })}`,
    );
    expect(c.querySelector(".provenance-dots")).toBeNull();
  });

  test("one dot per informative state, with the tally as the accessible name", async () => {
    const c = await renderInto(
      html`${renderProvenanceDots({ bound: 1, inherited: 2, mixed: 0, set: 3 })}`,
    );
    const dots = c.querySelector(".provenance-dots")!;
    expect(dots.getAttribute("aria-label")).toBe("3 set here · 2 inherited · 1 bound");
    expect(dots.querySelectorAll(".provenance-chip").length).toBe(3);
    expect(dots.querySelector(".provenance-chip--inherited")!.classList.contains("set-dot")).toBe(
      true,
    );
  });

  test("the set dot keeps the clear-all handler and its own tooltip", async () => {
    let cleared = 0;
    const c = await renderInto(
      html`${renderProvenanceDots(
        { bound: 0, inherited: 0, mixed: 0, set: 2 },
        { clearTitle: "Clear all spacing properties", onClearSet: () => (cleared += 1) },
      )}`,
    );
    const dot = c.querySelector(".provenance-chip--set")!;
    expect(dot.getAttribute("title")).toBe("Clear all spacing properties");
    dot.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(cleared).toBe(1);
  });

  test("with no clear handler the set dot is inert rather than a lie", async () => {
    const c = await renderInto(
      html`${renderProvenanceDots({ bound: 0, inherited: 1, mixed: 0, set: 1 })}`,
    );
    const dot = c.querySelector(".provenance-chip--set")!;
    expect(dot.getAttribute("title")).toBe("1 set here · 1 inherited");
  });
});
