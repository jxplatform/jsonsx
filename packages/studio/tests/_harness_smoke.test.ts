import {
  installMockPlatform,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
  setValue,
  stubRect,
} from "./harness";
import { describe, expect, test } from "bun:test";
import { html } from "lit-html";
import { getPlatform } from "../src/platform";

describe("harness smoke", () => {
  test("renderInto renders lit templates", async () => {
    const el = await renderInto(html`<p class="x">hi</p>`);
    expect(el.querySelector("p.x")?.textContent).toBe("hi");
  });
  test("mock platform fs round-trip", async () => {
    const { state } = installMockPlatform({}, { "/project/a.json": "{}" });
    const p = getPlatform();
    await p.writeFile("/project/b.txt", "hello");
    expect(await p.readFile("/project/b.txt")).toBe("hello");
    const entries = await p.listDirectory("/project");
    expect(entries.length).toBe(2);
    expect(state.calls[0]?.[0]).toBe("writeFile");
  });
  test("state + tab reset", () => {
    resetStudioState();
    const tab = resetWorkspaceWithTab();
    expect(tab?.doc.document).toBeTruthy();
  });
  test("stubRect + setValue", async () => {
    const el = await renderInto(html`<input />`);
    stubRect(el, { height: 10, left: 5, top: 5, width: 10 });
    expect(el.getBoundingClientRect().width).toBe(10);
    const input = el.querySelector("input")!;
    let fired = 0;
    input.addEventListener("input", () => {
      fired += 1;
    });
    setValue(input, "abc");
    expect(input.value).toBe("abc");
    expect(fired).toBe(1);
  });
});
