import { installMockPlatform, renderInto } from "./harness";
import type { TemplateResult } from "lit-html";
import { createMockCollabHub, settleCollab } from "./collab-mock";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { resetCollabForTests } from "../src/collab/collab-session";
import { collabState } from "../src/collab/collab-state";
import {
  presenceChipsTemplate,
  readOnlyBannerTemplate,
  statusTitle,
} from "../src/collab/presence-chips";
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
  test("render nothing while the platform offers no collaboration at all", async () => {
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
          structuralSelection: [["children", 0]],
          user: { color: "#e5484d", login: "octocat", name: "Octo Cat" },
        },
      },
      {
        clientId: 2,
        state: {
          focusedPath: "pages/other.json",
          structuralSelection: null,
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
    tab.session.selection = [["children", 0]];
    await settleCollab();

    const states = [...peer.awareness.getStates().values()] as {
      structuralSelection?: (string | number)[][] | null;
      focusedPath?: string | null;
    }[];
    const published = states.find((s) => s.focusedPath === PATH);
    expect(published?.structuralSelection).toEqual([["children", 0]]);

    tab.session.selection = [];
    await settleCollab();
    const cleared = [...peer.awareness.getStates().values()] as {
      structuralSelection?: unknown;
    }[];
    expect(cleared.some((s) => s.structuralSelection === null)).toBe(true);
    peer.destroy();
  });
});

// ─── §7.4: the states co-editing could not announce ──────────────────────────
/* `"detached"` used to mean three things at once and say none of them — this build has no
   collaboration, this document is solo, and the attach was tried and FAILED. A freeze, meanwhile,
   was a three-second grey line, which is exactly what a bug looks like. */

describe("collab honesty", () => {
  async function chips(patch: Record<string, unknown>): Promise<HTMLElement> {
    installMockPlatform();
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    Object.assign(collabState(tab), patch);
    const el = document.createElement("div");
    await renderInto(presenceChipsTemplate(tab) as TemplateResult, el);
    return el;
  }

  test("solo says Solo — it is not the same word as broken", async () => {
    const el = await chips({ active: false, status: "detached" });
    expect(el.querySelector(".jx-presence-status")?.textContent?.trim()).toBe("Solo");
  });

  test("a failed attach says so, and carries the reason", async () => {
    const el = await chips({ attachError: "relay unreachable", status: "failed" });
    const pill = el.querySelector(".jx-presence-status")!;
    expect(pill.textContent?.trim()).toBe("Not connected");
    expect((pill as HTMLElement).dataset.status).toBe("failed");
    expect(el.querySelector(".jx-presence")?.getAttribute("title")).toContain("relay unreachable");
  });

  test("the source-canonical freeze gets a standing indicator that denies being an error", async () => {
    const el = await chips({ active: true, sourceCanonical: true, status: "synced" });
    const flag = el.querySelector('[data-flag="frozen"]')!;
    expect(flag.textContent?.trim()).toBe("Code view held");
    expect(flag.getAttribute("title")).toContain("not an error");
  });

  test("a read-only guest is told before they type, not after", async () => {
    const el = await chips({ active: true, readOnly: true, status: "synced" });
    expect(el.querySelector('[data-flag="read-only"]')?.textContent?.trim()).toBe("Read-only");
  });

  test("statusTitle states the one undo fact nobody would guess", () => {
    expect(statusTitle("synced", "")).toContain("never a collaborator's");
    expect(statusTitle("offline", "")).toContain("never a collaborator's");
    expect(statusTitle("failed", "boom")).toContain("boom");
    expect(statusTitle("connecting", "")).toBe("Connecting…");
  });
});

describe("read-only banner", () => {
  function tabWith(patch: Record<string, unknown>) {
    installMockPlatform();
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    Object.assign(collabState(tab), patch);
    return tab;
  }

  test("renders only for an ACTIVE read-only session", async () => {
    const el = document.createElement("div");
    await renderInto(
      readOnlyBannerTemplate(tabWith({ active: true, readOnly: true })) as TemplateResult,
      el,
    );
    expect(el.querySelector('.jx-collab-banner[data-kind="read-only"]')?.textContent).toContain(
      "not published",
    );
  });

  test("renders nothing when writable, inactive, or tabless", async () => {
    for (const patch of [
      { active: true, readOnly: false },
      { active: false, readOnly: true },
    ]) {
      const el = document.createElement("div");
      const tpl = readOnlyBannerTemplate(tabWith(patch));
      if (tpl !== undefined && typeof tpl !== "symbol") {
        await renderInto(tpl as TemplateResult, el);
      }
      expect(el.querySelector(".jx-collab-banner")).toBeNull();
    }
    expect(readOnlyBannerTemplate(null)).toBeDefined();
  });
});
