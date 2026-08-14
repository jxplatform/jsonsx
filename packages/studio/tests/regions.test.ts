import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  focusRegionOf,
  inspectorTabRegion,
  isRegionId,
  listRegions,
  navigatorPanelRegion,
  overlayRegion,
  parseRegionId,
  REGION_ATTR,
  REGION_FOR_FOCUS,
  regionIdOf,
  regions,
  resolveAllRegions,
  resolveRegion,
  SHELL_REGION_HOSTS,
  stampShellRegions,
} from "../src/ui/regions";
import type { FocusRegion } from "../src/shell";

function tree(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

beforeEach(() => {
  document.body.textContent = "";
});

// ─── The grammar ──────────────────────────────────────────────────────────────

describe("parseRegionId", () => {
  test("a bare surface", () => {
    expect(parseRegionId("navigator")).toEqual({ surface: "navigator" });
    expect(parseRegionId("commandbar")).toEqual({ surface: "commandbar" });
  });

  test("surface.instance", () => {
    expect(parseRegionId("pane.secondary")).toEqual({ instance: "secondary", surface: "pane" });
    expect(parseRegionId("overlay.palette")).toEqual({ instance: "palette", surface: "overlay" });
  });

  test("dock.bottom is a surface, not an instance of a `dock` surface", () => {
    expect(parseRegionId("dock.bottom")).toEqual({ surface: "dock.bottom" });
    expect(parseRegionId("dock.bottom/activity")).toEqual({
      part: "activity",
      surface: "dock.bottom",
    });
  });

  test("parts, including a nested leaf", () => {
    expect(parseRegionId("navigator/panel:git")).toEqual({
      part: "panel:git",
      surface: "navigator",
    });
    expect(parseRegionId("navigator/panel:git/commit")).toEqual({
      part: "panel:git/commit",
      surface: "navigator",
    });
    expect(parseRegionId("pane.primary/tabs")).toEqual({
      instance: "primary",
      part: "tabs",
      surface: "pane",
    });
  });

  test("rejects anything that is not a region id — a CSS selector above all", () => {
    for (const bad of [
      "#left-panel",
      ".settings-modal",
      "sp-popover[open]",
      "#right-panel [data-prop='href']",
      "xpath///div",
      "",
      "navigator/",
      "pane.",
      "sidebar",
    ]) {
      expect(parseRegionId(bad)).toBeNull();
      expect(isRegionId(bad)).toBe(false);
    }
  });
});

// ─── Resolution ───────────────────────────────────────────────────────────────

describe("resolveRegion", () => {
  test("finds a stamped element and returns null for an absent one", () => {
    tree(`<div id="a" ${REGION_ATTR}="navigator"></div>`);
    expect(resolveRegion("navigator")?.id).toBe("a");
    expect(resolveRegion("inspector")).toBeNull();
  });

  test("never falls back to treating the id as a selector", () => {
    tree(`<div class="settings-modal"></div>`);
    expect(resolveRegion(".settings-modal")).toBeNull();
    expect(resolveAllRegions(".settings-modal")).toEqual([]);
  });

  test("`pane` names the primary pane", () => {
    tree(`<div id="p" ${REGION_ATTR}="pane.primary"><div id="t" ${REGION_ATTR}="pane.primary/tabs">
      </div></div>`);
    expect(resolveRegion("pane")?.id).toBe("p");
    expect(resolveRegion("pane/tabs")?.id).toBe("t");
  });

  test("two overlays of one kind are both answerable; resolve takes the topmost", () => {
    tree(`
      <div id="first" ${REGION_ATTR}="overlay.menu"></div>
      <div id="second" ${REGION_ATTR}="overlay.menu"></div>
    `);
    expect(resolveAllRegions("overlay.menu").map((el) => el.id)).toEqual(["first", "second"]);
    expect(resolveRegion("overlay.menu")?.id).toBe("second");
  });

  test("resolves inside an explicit root", () => {
    const detached = document.createElement("div");
    detached.innerHTML = `<div id="d" ${REGION_ATTR}="rail"></div>`;
    expect(resolveRegion("rail")).toBeNull();
    expect(resolveRegion("rail", detached)?.id).toBe("d");
  });

  test("inspector/field:<prop> reads the `data-prop` the field row already emits", () => {
    tree(`<div ${REGION_ATTR}="inspector">
      <div class="field-row" data-prop="href" id="href-row"></div>
      <div class="field-row" data-prop="src" id="src-row"></div>
    </div>`);
    expect(resolveRegion("inspector/field:href")?.id).toBe("href-row");
    expect(resolveRegion("inspector/field:src")?.id).toBe("src-row");
    expect(resolveRegion("inspector/field:nope")).toBeNull();
  });

  test("a stamped id always wins over the derived resolver", () => {
    tree(`<div ${REGION_ATTR}="inspector">
      <div data-prop="href" id="by-prop"></div>
      <div ${REGION_ATTR}="inspector/field:href" id="by-stamp"></div>
    </div>`);
    expect(resolveRegion("inspector/field:href")?.id).toBe("by-stamp");
  });
});

describe("listRegions / regionIdOf", () => {
  test("enumerates the ids on screen, deduplicated and sorted", () => {
    tree(`
      <div ${REGION_ATTR}="navigator">
        <div ${REGION_ATTR}="navigator/panel:git"><span id="leaf"></span></div>
      </div>
      <div ${REGION_ATTR}="navigator"></div>
      <div ${REGION_ATTR}="not-a-region"></div>
    `);
    expect(listRegions()).toEqual(["navigator", "navigator/panel:git"]);
  });

  test("regionIdOf walks up to the nearest region", () => {
    tree(`<div ${REGION_ATTR}="navigator">
      <div ${REGION_ATTR}="navigator/panel:git"><span id="leaf"></span></div>
    </div>`);
    expect(regionIdOf(document.querySelector("#leaf"))).toBe("navigator/panel:git");
    expect(regionIdOf(null)).toBeNull();
    expect(regionIdOf(document.body)).toBeNull();
  });
});

// ─── The FocusRegion map — the whole reason the enum was inert ─────────────────

describe("FocusRegion map", () => {
  test("every FocusRegion has a region id, and every id is well-formed", () => {
    const declared: FocusRegion[] = ["rail", "navigator", "pane", "inspector", "dock", "status"];
    for (const focus of declared) {
      const id = REGION_FOR_FOCUS[focus];
      expect(typeof id).toBe("string");
      expect(isRegionId(id)).toBe(true);
    }
  });

  test("round-trips: a node inside a region reports the FocusRegion it sits in", () => {
    tree(`
      <div ${REGION_ATTR}="navigator"><span id="in-nav"></span></div>
      <div ${REGION_ATTR}="pane.primary"><span id="in-pane"></span></div>
      <div ${REGION_ATTR}="dock.bottom"><span id="in-dock"></span></div>
      <div ${REGION_ATTR}="statusbar"><span id="in-status"></span></div>
      <div ${REGION_ATTR}="overlay.dialog"><span id="in-overlay"></span></div>
    `);
    expect(focusRegionOf(document.querySelector("#in-nav"))).toBe("navigator");
    expect(focusRegionOf(document.querySelector("#in-pane"))).toBe("pane");
    expect(focusRegionOf(document.querySelector("#in-dock"))).toBe("dock");
    expect(focusRegionOf(document.querySelector("#in-status"))).toBe("status");
    // An overlay is not one of the shell's focus regions — it is above them.
    expect(focusRegionOf(document.querySelector("#in-overlay"))).toBeNull();
    expect(focusRegionOf(null)).toBeNull();
  });
});

// ─── Derivation ───────────────────────────────────────────────────────────────

describe("derived ids", () => {
  test("a panel id becomes a region id — that is what survives a rename", () => {
    expect(navigatorPanelRegion("git")).toBe("navigator/panel:git");
    // P3 renames the Head panel to Page; the region follows with no edit here.
    expect(navigatorPanelRegion("page")).toBe("navigator/panel:page");
  });

  test("an inspector tab value becomes a region id", () => {
    expect(inspectorTabRegion("style")).toBe("inspector/tab:style");
  });

  test("a modal is a dialog and a popover is a menu", () => {
    expect(overlayRegion("dialog")).toBe("overlay.dialog");
    expect(overlayRegion("modal")).toBe("overlay.dialog");
    expect(overlayRegion("popover")).toBe("overlay.menu");
    expect(overlayRegion("popover", "zoom-indicator")).toBe("overlay.menu:zoom-indicator");
    expect(overlayRegion("modal", "settings")).toBe("overlay.dialog:settings");
  });

  test("every derived id the helpers mint parses", () => {
    for (const id of [
      navigatorPanelRegion("git"),
      inspectorTabRegion("style"),
      overlayRegion("popover", "zoom-indicator"),
      overlayRegion("modal", "settings"),
      overlayRegion("dialog"),
      ...Object.values(SHELL_REGION_HOSTS),
    ]) {
      expect(isRegionId(id)).toBe(true);
    }
  });
});

describe("a region named by ROLE outlives the node it was minted on", () => {
  test("`inspector.assistant` no longer needs a shell host at all", () => {
    // It was minted for `#chat-panel`, a fifth grid column. The column went; then the DIV went;
    // The id did neither, because it names the assistant's PLACE in the inspector rather than a
    // Node. `panels/chat-panel.ts` stamps it on whatever container hosts the chat, so this table
    // Has one fewer row and `ai-sidebar-chat`'s crop still resolves.
    expect(SHELL_REGION_HOSTS["#chat-panel"]).toBeUndefined();
    expect(isRegionId("inspector.assistant")).toBe(true);
    const host = tree(`<div id="assistant" data-jx-region="inspector.assistant"></div>`);
    expect(resolveRegion("inspector.assistant", host)?.id).toBe("assistant");
    // `inspector.assistant` is an INSTANCE of the inspector surface, so focus lands in the dock it
    // Belongs to — which is the whole reason the surface axis exists.
    expect(focusRegionOf(host.querySelector("#assistant"))).toBe("inspector");
  });

  test("`pane.primary/frontmatter` outlived `#frontmatter-panel` the same way", () => {
    // It named a grid row. The row is gone and the Document Header card is drawn inside the stage,
    // Where `panels/frontmatter-panel.ts` stamps the id on the card's own <section> — so the table
    // Has one fewer row and `properties-bar`'s crop still resolves.
    expect(SHELL_REGION_HOSTS["#frontmatter-panel"]).toBeUndefined();
    expect(isRegionId("pane.primary/frontmatter")).toBe(true);
    const host = tree(
      `<div id="canvas-wrap"><section class="doc-header" id="card"
         data-jx-region="pane.primary/frontmatter"></section></div>`,
    );
    stampShellRegions(host);
    expect(resolveRegion("pane.primary/frontmatter", host)?.id).toBe("card");
    // It is a PART of the primary pane, so focus lands in the pane it belongs to.
    expect(focusRegionOf(host.querySelector("#card"))).toBe("pane");
  });
});

describe("stampShellRegions", () => {
  test("stamps the hosts index.html declares, and is idempotent", () => {
    const host = tree(
      Object.keys(SHELL_REGION_HOSTS)
        .map((selector) => `<div id="${selector.slice(1)}"></div>`)
        .join(""),
    );
    stampShellRegions(host);
    stampShellRegions(host);
    for (const [selector, id] of Object.entries(SHELL_REGION_HOSTS)) {
      expect(host.querySelector(selector)?.getAttribute(REGION_ATTR)).toBe(id);
    }
    expect(listRegions(host)).toEqual(Object.values(SHELL_REGION_HOSTS).toSorted());
  });

  test("an absent host is simply not stamped", () => {
    const host = tree(`<div id="statusbar"></div>`);
    expect(() => {
      stampShellRegions(host);
    }).not.toThrow();
    expect(listRegions(host)).toEqual(["statusbar"]);
  });
});

describe("the regions namespace", () => {
  test("gathers the readers the rest of the app imports", () => {
    tree(`<div id="n" ${REGION_ATTR}="navigator"></div>`);
    expect(regions.resolve("navigator")?.id).toBe("n");
    expect(regions.resolveAll("navigator")).toHaveLength(1);
    expect(regions.list()).toEqual(["navigator"]);
    expect(regions.parse("navigator")).toEqual({ surface: "navigator" });
    expect(regions.idOf(document.querySelector("#n"))).toBe("navigator");
    expect(regions.focusRegionOf(document.querySelector("#n"))).toBe("navigator");
  });
});
