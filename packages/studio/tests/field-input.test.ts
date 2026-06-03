import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import { render } from "lit-html";
import { html } from "lit-html";
import {
  getFieldValue,
  setDraft,
  clearDraft,
  commitField,
  scheduleDraftCommit,
  hasDraft,
  spTextField,
} from "../src/ui/field-input";

describe("field-input draft store", () => {
  test("getFieldValue returns committed when no draft", () => {
    clearDraft("k1");
    expect(getFieldValue("k1", "committed")).toBe("committed");
    expect(hasDraft("k1")).toBe(false);
  });

  test("setDraft makes getFieldValue return the in-progress draft", () => {
    setDraft("k2", "typing");
    expect(getFieldValue("k2", "committed")).toBe("typing");
    expect(hasDraft("k2")).toBe(true);
    clearDraft("k2");
    expect(getFieldValue("k2", "committed")).toBe("committed");
  });

  test("commitField commits the latest draft and clears it", () => {
    let committed = "";
    setDraft("k3", "final");
    commitField("k3", (v) => (committed = v));
    expect(committed).toBe("final");
    expect(hasDraft("k3")).toBe(false);
    // After commit the field reflects the committed document value again.
    expect(getFieldValue("k3", "doc")).toBe("doc");
  });

  test("clearDraft discards without committing", () => {
    let calls = 0;
    setDraft("k4", "x");
    clearDraft("k4");
    commitField("k4", () => calls++); // no draft → nothing to commit
    expect(calls).toBe(0);
  });
});

describe("draft commit semantics", () => {
  test("debounced commit fires the latest draft after the delay, draft persists for live edit", async () => {
    let committed: string | null = null;
    setDraft("d1", "ab");
    scheduleDraftCommit("d1", 20, (v) => (committed = v));
    setDraft("d1", "abc"); // keep typing before the debounce fires
    scheduleDraftCommit("d1", 20, (v) => (committed = v));
    expect(committed).toBe(null); // nothing committed synchronously
    await new Promise((r) => setTimeout(r, 45));
    expect(committed).toBe("abc"); // latest value, not the earlier "ab"
    // Draft is kept after a debounced commit so the field stays controlled while focused.
    expect(getFieldValue("d1", "doc")).toBe("abc");
    clearDraft("d1");
  });

  test("a later scheduleDraftCommit cancels the earlier pending one", async () => {
    let calls = 0;
    setDraft("d2", "one");
    scheduleDraftCommit("d2", 15, () => calls++);
    setDraft("d2", "two");
    scheduleDraftCommit("d2", 15, () => calls++);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1); // only the latest timer fires
    clearDraft("d2");
  });

  test("commitField (blur/Enter) cancels a pending debounce and commits once", async () => {
    let committed: string | null = null;
    let calls = 0;
    setDraft("d3", "typed");
    scheduleDraftCommit("d3", 50, () => calls++);
    commitField("d3", (v) => {
      committed = v;
      calls++;
    });
    expect(committed).toBe("typed");
    expect(hasDraft("d3")).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(1); // the debounce timer was cancelled by commitField
  });
});

describe("spTextField widget render", () => {
  test("renders an sp-textfield showing the current draft value", () => {
    const container = document.createElement("div");
    setDraft("r1", "draftval");
    render(html`<div>${spTextField("r1", "committed", () => {})}</div>`, container);
    const el = container.querySelector("sp-textfield");
    expect(el).toBeTruthy();
    // live() binds the draft value as the property.
    expect((el as unknown as { value?: string }).value).toBe("draftval");
    clearDraft("r1");
  });
});
