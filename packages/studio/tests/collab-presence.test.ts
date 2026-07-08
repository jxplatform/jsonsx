import { installMockPlatform, renderInto } from "./harness";
import type { TemplateResult } from "lit-html";
import { createMockCollabHub, settleCollab } from "./collab-mock";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { resetCollabForTests } from "../src/collab/collab-session";
import { collabState } from "../src/collab/collab-state";
import { presenceChipsTemplate } from "../src/collab/presence-chips";
import { createOverlayLayer } from "../src/canvas/iframe-overlay";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { afterEach, describe, expect, test } from "bun:test";

const DOC: JxMutableNode = { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" };
const PATH = "pages/presence.json";

afterEach(() => {
  closeAllTabs();
  resetCollabForTests();
});

describe("presence chips", () => {
  test("render nothing for detached tabs", async () => {
    installMockPlatform();
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    const el = document.createElement("div");
    await renderInto(presenceChipsTemplate(tab) as TemplateResult, el);
    expect(el.querySelector(".jx-presence")).toBeNull();
  });

  test("show the sync status and one colored chip per peer", async () => {
    installMockPlatform();
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    const state = collabState(tab);
    state.status = "synced";
    state.active = true;
    state.peers = [
      {
        clientId: 1,
        state: {
          focusedPath: PATH,
          selection: ["children", 0],
          user: { color: "#e5484d", login: "octocat", name: "Octo Cat" },
        },
      },
      {
        clientId: 2,
        state: {
          focusedPath: "pages/other.json",
          selection: null,
          user: { color: "#30a46c", login: "viewer" },
        },
      },
    ];
    const el = document.createElement("div");
    await renderInto(presenceChipsTemplate(tab) as TemplateResult, el);
    expect(el.querySelector(".jx-presence-status")?.textContent).toBe("Live");
    const chips = [...el.querySelectorAll(".jx-presence-chip")];
    expect(chips).toHaveLength(2);
    expect(chips[0]?.getAttribute("title")).toContain("Octo Cat");
    expect(chips[0]?.textContent?.trim()).toBe("O");
    // A peer focused elsewhere names the file it is in.
    expect(chips[1]?.getAttribute("title")).toContain("pages/other.json");
  });

  test("offline status surfaces in the pill", async () => {
    installMockPlatform();
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    const state = collabState(tab);
    state.status = "offline";
    const el = document.createElement("div");
    await renderInto(presenceChipsTemplate(tab) as TemplateResult, el);
    const pill = el.querySelector<HTMLElement>(".jx-presence-status");
    expect(pill?.dataset["status"]).toBe("offline");
  });
});

describe("overlay presence boxes", () => {
  test("setPresence draws colored boxes with name tags and clears wholesale", () => {
    const overlay = createOverlayLayer(document);
    overlay.setPresence([
      {
        color: "#e5484d",
        label: "Octo Cat",
        placement: { height: 40, left: 10, top: 20, width: 100 },
      },
      { color: "#30a46c", label: "viewer", placement: { height: 8, left: 1, top: 2, width: 3 } },
    ]);
    const boxes = [...overlay.root.querySelectorAll(".overlay-presence")];
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLElement).style.left).toBe("10px");
    expect(boxes[0]?.querySelector(".overlay-presence-tag")?.textContent).toBe("Octo Cat");
    expect((boxes[0] as HTMLElement).style.outline).toContain("#e5484d");

    overlay.setPresence([]);
    expect(overlay.root.querySelectorAll(".overlay-presence")).toHaveLength(0);
    overlay.dispose();
  });
});

describe("selection publishing", () => {
  test("the local structural selection rides awareness for peers to draw", async () => {
    const hub = createMockCollabHub();
    installMockPlatform({ collab: hub.capability });
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    await settleCollab();
    expect(collabState(tab).active).toBe(true);

    const peer = (await hub.capability(PATH))!;
    tab.session.selection = ["children", 0];
    await settleCollab();

    const states = [...peer.awareness.getStates().values()] as {
      selection?: (string | number)[] | null;
      focusedPath?: string | null;
    }[];
    const published = states.find((s) => s.focusedPath === PATH);
    expect(published?.selection).toEqual(["children", 0]);

    tab.session.selection = null;
    await settleCollab();
    const cleared = [...peer.awareness.getStates().values()] as { selection?: unknown }[];
    expect(cleared.some((s) => s.selection === null)).toBe(true);
    peer.destroy();
  });
});
