import "./harness";
import { describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import {
  DEFAULT_DEBOUNCE_MS,
  clearDraft,
  hasDraft,
  getFieldValue,
  rawTextArea,
  scheduleDraftCommit,
  setDraft,
  spNumberField,
  spTextArea,
  spTextField,
} from "../src/ui/field-input";

// ─── Local helpers ───────────────────────────────────────────────────────────

function mountWidget(tpl: unknown) {
  const container = document.createElement("div");
  render(html`<div>${tpl}</div>`, container);
  return container;
}

function setAndDispatch(el: Element, type: string, value: string) {
  (el as unknown as { value: string }).value = value;
  el.dispatchEvent(new Event(type, { bubbles: false }));
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ─── Draft-store edge cases ──────────────────────────────────────────────────

describe("draft store edge cases", () => {
  test("DEFAULT_DEBOUNCE_MS is a sane positive number", () => {
    expect(DEFAULT_DEBOUNCE_MS).toBeGreaterThan(0);
  });

  test("clearDraft cancels a pending debounced commit", async () => {
    let calls = 0;
    setDraft("g1", "abc");
    scheduleDraftCommit("g1", 10, () => {
      calls += 1;
    });
    clearDraft("g1");
    await sleep(30);
    expect(calls).toBe(0);
    expect(hasDraft("g1")).toBe(false);
  });

  test("scheduleDraftCommit without a draft is a no-op", async () => {
    let calls = 0;
    clearDraft("g2");
    scheduleDraftCommit("g2", 5, () => {
      calls += 1;
    });
    await sleep(20);
    expect(calls).toBe(0);
  });
});

// ─── spTextField handlers ────────────────────────────────────────────────────

describe("spTextField handlers", () => {
  test("input sets a draft and live mode commits after the debounce", async () => {
    const commits: string[] = [];
    const container = mountWidget(
      spTextField("tf1", "doc", (v) => commits.push(v), { debounceMs: 10 }),
    );
    const tf = container.querySelector("sp-textfield")!;
    setAndDispatch(tf, "input", "typed");
    expect(hasDraft("tf1")).toBe(true);
    expect(getFieldValue("tf1", "doc")).toBe("typed");
    expect(commits).toEqual([]);
    await sleep(40);
    expect(commits).toEqual(["typed"]);
    // Draft persists after a debounced commit so the field stays controlled.
    expect(hasDraft("tf1")).toBe(true);
    clearDraft("tf1");
  });

  test("commitMode blur suppresses the debounced commit; change commits and clears", async () => {
    const commits: string[] = [];
    const container = mountWidget(
      spTextField("tf2", "doc", (v) => commits.push(v), { commitMode: "blur", debounceMs: 5 }),
    );
    const tf = container.querySelector("sp-textfield")!;
    setAndDispatch(tf, "input", "renaming");
    await sleep(30);
    expect(commits).toEqual([]); // No mid-typing commit in blur mode
    setAndDispatch(tf, "change", "renamed");
    expect(commits).toEqual(["renamed"]);
    expect(hasDraft("tf2")).toBe(false);
  });

  test("Enter keydown flushes the draft immediately", () => {
    const commits: string[] = [];
    const container = mountWidget(
      spTextField("tf3", "doc", (v) => commits.push(v), { debounceMs: 5000 }),
    );
    const tf = container.querySelector("sp-textfield")!;
    setAndDispatch(tf, "input", "fast");
    tf.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(commits).toEqual(["fast"]);
    expect(hasDraft("tf3")).toBe(false);
  });

  test("non-Enter keydown does not commit", () => {
    const commits: string[] = [];
    const container = mountWidget(spTextField("tf4", "doc", (v) => commits.push(v)));
    const tf = container.querySelector("sp-textfield")!;
    setAndDispatch(tf, "input", "partial");
    tf.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(commits).toEqual([]);
    expect(hasDraft("tf4")).toBe(true);
    clearDraft("tf4");
  });

  test("renders placeholder, size, disabled and style options", () => {
    const container = mountWidget(
      spTextField("tf5", "v", () => {}, {
        disabled: true,
        placeholder: "Type here",
        size: "m",
        style: "width:80px",
      }),
    );
    const tf = container.querySelector("sp-textfield")!;
    expect(tf.getAttribute("placeholder")).toBe("Type here");
    expect(tf.getAttribute("size")).toBe("m");
    expect(tf.hasAttribute("disabled")).toBe(true);
    expect(tf.getAttribute("style")).toBe("width:80px");
  });
});

// ─── spTextArea ──────────────────────────────────────────────────────────────

describe("spTextArea", () => {
  test("renders a multiline sp-textfield bound to the draft layer", () => {
    const container = mountWidget(spTextArea("ta1", "body text", () => {}));
    const tf = container.querySelector("sp-textfield")!;
    expect(tf.hasAttribute("multiline")).toBe(true);
    expect((tf as unknown as { value: string }).value).toBe("body text");
  });

  test("input debounces a commit and change flushes immediately", async () => {
    const commits: string[] = [];
    const container = mountWidget(
      spTextArea("ta2", "doc", (v) => commits.push(v), { debounceMs: 10 }),
    );
    const tf = container.querySelector("sp-textfield")!;
    setAndDispatch(tf, "input", "line one");
    await sleep(40);
    expect(commits).toEqual(["line one"]);
    setAndDispatch(tf, "change", "line one\nline two");
    expect(commits).toEqual(["line one", "line one\nline two"]);
    expect(hasDraft("ta2")).toBe(false);
  });

  test("passes through placeholder/disabled options", () => {
    const container = mountWidget(
      spTextArea("ta3", "", () => {}, { disabled: true, placeholder: "Notes" }),
    );
    const tf = container.querySelector("sp-textfield")!;
    expect(tf.getAttribute("placeholder")).toBe("Notes");
    expect(tf.hasAttribute("disabled")).toBe(true);
  });
});

// ─── rawTextArea ─────────────────────────────────────────────────────────────

describe("rawTextArea", () => {
  test("renders a native textarea with default min-height", () => {
    const container = mountWidget(rawTextArea("rt1", "code", () => {}));
    const ta = container.querySelector("textarea.field-input")!;
    expect(ta).toBeTruthy();
    expect(ta.getAttribute("style")).toContain("min-height:40px");
    expect((ta as HTMLTextAreaElement).value).toBe("code");
  });

  test("mono option adds a monospace font and custom minHeight applies", () => {
    const container = mountWidget(
      rawTextArea("rt2", "", () => {}, { minHeight: "120px", mono: true, style: "color:red" }),
    );
    const style = container.querySelector("textarea")!.getAttribute("style")!;
    expect(style).toContain("min-height:120px");
    expect(style).toContain("monospace");
    expect(style).toContain("color:red");
  });

  test("input debounces and change commits immediately", async () => {
    const commits: string[] = [];
    const container = mountWidget(
      rawTextArea("rt3", "doc", (v) => commits.push(v), { debounceMs: 10 }),
    );
    const ta = container.querySelector("textarea")!;
    setAndDispatch(ta, "input", "a = 1");
    await sleep(40);
    expect(commits).toEqual(["a = 1"]);
    setAndDispatch(ta, "change", "a = 2");
    expect(commits).toEqual(["a = 1", "a = 2"]);
    expect(hasDraft("rt3")).toBe(false);
  });

  test("disabled and placeholder options render", () => {
    const container = mountWidget(
      rawTextArea("rt4", "", () => {}, { disabled: true, placeholder: "{}" }),
    );
    const ta = container.querySelector("textarea")!;
    expect(ta.hasAttribute("disabled")).toBe(true);
    expect(ta.getAttribute("placeholder")).toBe("{}");
  });
});

// ─── spNumberField ───────────────────────────────────────────────────────────

describe("spNumberField", () => {
  function mountNumber(value?: number, opts: Parameters<typeof spNumberField>[2] = {}) {
    const commits: (number | undefined)[] = [];
    const container = mountWidget(spNumberField(value, (v) => commits.push(v), opts));
    const nf = container.querySelector("sp-number-field")!;
    return { commits, container, nf };
  }

  test("binds the numeric value and hides the stepper by default", () => {
    const { nf } = mountNumber(12);
    expect((nf as unknown as { value: number }).value).toBe(12);
    expect(nf.hasAttribute("hide-stepper")).toBe(true);
  });

  test("undefined value binds undefined", () => {
    const { nf } = mountNumber();
    expect((nf as unknown as { value: unknown }).value).toBeUndefined();
  });

  test("change with a numeric string commits the parsed number", () => {
    const { commits, nf } = mountNumber(1);
    setAndDispatch(nf, "change", "3.5");
    expect(commits).toEqual([3.5]);
  });

  test("change with empty string commits undefined", () => {
    const { commits, nf } = mountNumber(1);
    setAndDispatch(nf, "change", "");
    expect(commits).toEqual([undefined]);
  });

  test("change with a non-numeric string commits undefined", () => {
    const { commits, nf } = mountNumber(1);
    setAndDispatch(nf, "change", "abc");
    expect(commits).toEqual([undefined]);
  });

  test("hideStepper false keeps the stepper visible and disabled renders", () => {
    const { nf } = mountNumber(0, { disabled: true, hideStepper: false, style: "width:50px" });
    expect(nf.hasAttribute("hide-stepper")).toBe(false);
    expect(nf.hasAttribute("disabled")).toBe(true);
    expect(nf.getAttribute("style")).toBe("width:50px");
  });
});
