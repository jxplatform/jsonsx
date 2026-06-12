import { flush, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { initShellRefs, registerRenderer, statusbarEl } from "../src/store";
import { closeAllTabs } from "../src/workspace/workspace";
import {
  mountStatusbar,
  renderStatusbar,
  setStatusbarRenderer,
  statusMessage,
  unmountStatusbar,
} from "../src/panels/statusbar";

beforeAll(() => {
  const bar = document.createElement("div");
  bar.id = "statusbar";
  document.body.append(bar);
  initShellRefs();
});

beforeEach(() => {
  closeAllTabs();
  statusbarEl.innerHTML = "";
  setStatusbarRenderer(renderStatusbar);
});

afterEach(async () => {
  unmountStatusbar();
  // Drain any pending statusMessage timeout so it can't leak into the next test.
  statusMessage("", 1);
  await flush();
  setStatusbarRenderer(() => {});
});

// ─── renderStatusbar ──────────────────────────────────────────────────────────

describe("renderStatusbar", () => {
  test("no tab renders the default label", () => {
    renderStatusbar();
    expect(statusbarEl.innerHTML).toBe("Jx Studio");
  });

  test("content mode shows Content Mode", () => {
    const tab = resetWorkspaceWithTab();
    tab.doc.mode = "content";
    renderStatusbar();
    expect(statusbarEl.innerHTML).toContain("Content Mode");
  });

  test("selection shows node label and clickable path segments", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    });
    tab.session.selection = ["children", 0];
    renderStatusbar();
    expect(statusbarEl.innerHTML).toContain("Selected: p — Hello");
    const seg = statusbarEl.querySelector(".sb-path-seg") as HTMLElement;
    expect(seg).not.toBeNull();
    expect(seg.textContent).toBe("p");
    expect(seg.dataset.path).toBe(JSON.stringify(["children", 0]));
  });

  test("multi-level selection renders one segment per path pair", () => {
    const tab = resetWorkspaceWithTab({
      children: [
        {
          children: [{ tagName: "li", textContent: "Item" }],
          tagName: "ul",
        },
      ],
      tagName: "div",
    });
    tab.session.selection = ["children", 0, "children", 0];
    renderStatusbar();
    const segs = [...statusbarEl.querySelectorAll(".sb-path-seg")];
    expect(segs.map((s) => s.textContent)).toEqual(["ul", "li"]);
    expect(statusbarEl.querySelectorAll(".sb-path-sep").length).toBe(1);
  });

  test("segment label falls back to tag then [index]", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tag: "h2", textContent: "Styled" }, { textContent: "Anon" }],
      tagName: "div",
    } as any);
    tab.session.selection = ["children", 0];
    renderStatusbar();
    expect(statusbarEl.querySelector(".sb-path-seg")?.textContent).toBe("h2");

    tab.session.selection = ["children", 1];
    renderStatusbar();
    expect(statusbarEl.querySelector(".sb-path-seg")?.textContent).toBe("[1]");
  });

  test("escapes HTML in node labels", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "<b>&hi" }],
      tagName: "div",
    });
    tab.session.selection = ["children", 0];
    renderStatusbar();
    expect(statusbarEl.innerHTML).toContain("&lt;b&gt;&amp;hi");
    expect(statusbarEl.querySelector("b")).toBeNull();
  });

  test("stylebook selection shows Style path when no node selection", () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.stylebookSelection = "ul li";
    renderStatusbar();
    expect(statusbarEl.innerHTML).toContain("Style: ul &gt; li");
    expect(statusbarEl.textContent).toContain("Style: ul > li");
  });

  test("node selection wins over stylebook selection", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "Hi" }],
      tagName: "div",
    });
    tab.session.ui.stylebookSelection = "h1";
    tab.session.selection = ["children", 0];
    renderStatusbar();
    expect(statusbarEl.innerHTML).toContain("Selected:");
    expect(statusbarEl.innerHTML).not.toContain("Style: h1");
  });

  test("parts are joined with separators", () => {
    const tab = resetWorkspaceWithTab();
    tab.doc.mode = "content";
    tab.session.ui.stylebookSelection = "h1";
    renderStatusbar();
    expect(statusbarEl.innerHTML).toContain("Content Mode  |  Style: h1");
  });
});

// ─── statusMessage ────────────────────────────────────────────────────────────

describe("statusMessage", () => {
  test("shows the message, escaped, then clears after the duration", async () => {
    closeAllTabs();
    statusMessage("<saved> & done", 20);
    expect(statusbarEl.innerHTML).toContain("&lt;saved&gt; &amp; done");
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(statusbarEl.innerHTML).toBe("Jx Studio");
  });

  test("a newer message resets the pending timeout", async () => {
    statusMessage("first", 20);
    statusMessage("second", 60);
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    // First timeout was cleared; second message still visible.
    expect(statusbarEl.innerHTML).toContain("second");
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(statusbarEl.innerHTML).toBe("Jx Studio");
  });

  test("invokes the registered renderer callback", () => {
    const rerender = mock(() => {});
    setStatusbarRenderer(rerender);
    statusMessage("ping", 10);
    expect(rerender).toHaveBeenCalledTimes(1);
  });
});

// ─── mountStatusbar / clicks / unmount ────────────────────────────────────────

describe("mountStatusbar", () => {
  test("renders reactively when tab state changes", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    await flush();
    expect(statusbarEl.innerHTML).toBe("Jx Studio");

    tab.session.selection = ["children", 0];
    await flush();
    expect(statusbarEl.innerHTML).toContain("Selected:");
  });

  test("clicking a path segment updates the selection and re-renders panels", async () => {
    const canvasRenderer = mock(() => {});
    registerRenderer("canvas", canvasRenderer);
    const tab = resetWorkspaceWithTab({
      children: [
        {
          children: [{ tagName: "li", textContent: "Item" }],
          tagName: "ul",
        },
      ],
      tagName: "div",
    });
    mountStatusbar();
    tab.session.selection = ["children", 0, "children", 0];
    await flush();

    const seg = statusbarEl.querySelector(".sb-path-seg") as HTMLElement;
    expect(seg.textContent).toBe("ul");
    seg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tab.session.selection).toEqual(["children", 0]);
    expect(canvasRenderer).toHaveBeenCalled();
  });

  test("clicks outside path segments are ignored", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    tab.session.selection = ["children", 0];
    await flush();

    statusbarEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tab.session.selection).toEqual(["children", 0]);
  });

  test("segment without data-path is ignored", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    await flush();
    tab.session.selection = ["children", 0];
    const span = document.createElement("span");
    span.className = "sb-path-seg";
    statusbarEl.append(span);
    span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tab.session.selection).toEqual(["children", 0]);
  });

  test("invalid JSON in data-path is swallowed", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    await flush();
    tab.session.selection = ["children", 0];
    const span = document.createElement("span");
    span.className = "sb-path-seg";
    span.dataset.path = "{not json";
    statusbarEl.append(span);
    expect(() => {
      span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }).not.toThrow();
    expect(tab.session.selection).toEqual(["children", 0]);
  });

  test("unmount stops reactive re-rendering and click handling", async () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    await flush();
    unmountStatusbar();

    statusbarEl.innerHTML = "frozen";
    tab.session.selection = ["children", 0];
    await flush();
    expect(statusbarEl.innerHTML).toBe("frozen");

    const span = document.createElement("span");
    span.className = "sb-path-seg";
    span.dataset.path = JSON.stringify(["children", 0]);
    statusbarEl.append(span);
    tab.session.selection = null;
    span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tab.session.selection).toBeNull();
  });
});
