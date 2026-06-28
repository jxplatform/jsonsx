/**
 * Tests for src/editor/inline-link.ts — realm-agnostic link + template-token application for the
 * iframe-side inline editor.
 *
 * The execCommand-driven branches (createLink, insertText) are verified at the STUB level:
 * happy-dom has no `document.execCommand`, so these assertions prove the branch wiring
 * (args/order), NOT the real DOM mutation a browser would produce. The UNWRAP branch is asserted
 * against the real DOM (no execCommand needed).
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { applyLink, insertTemplateToken, linkStateForSelection } from "../src/editor/inline-link";

function mountEditable(html: string): HTMLElement {
  const el = document.createElement("p");
  el.contentEditable = "true";
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

function selectContents(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  delete (document as unknown as Record<string, unknown>).execCommand;
});

describe("linkStateForSelection", () => {
  test("reports the href when the selection is inside an <a>", () => {
    const el = mountEditable(`<a href="https://x.example/p">go</a>`);
    selectContents(el.querySelector("a")!.firstChild!);
    expect(linkStateForSelection(el)).toEqual({ active: true, href: "https://x.example/p" });
  });

  test("returns the author-entered (relative) href, not the resolved property", () => {
    const el = mountEditable(`<a href="/relative/path">go</a>`);
    selectContents(el.querySelector("a")!.firstChild!);
    expect(linkStateForSelection(el).href).toBe("/relative/path");
  });

  test("reports inactive when the selection is outside any <a>", () => {
    const el = mountEditable(`plain <strong>text</strong>`);
    selectContents(el.querySelector("strong")!.firstChild!);
    expect(linkStateForSelection(el)).toEqual({ active: false, href: null });
  });

  test("reports inactive when there is no selection", () => {
    const el = mountEditable("plain");
    window.getSelection()?.removeAllRanges();
    expect(linkStateForSelection(el)).toEqual({ active: false, href: null });
  });
});

describe("applyLink", () => {
  test("rewrites the href of an existing <a> (no execCommand)", () => {
    const el = mountEditable(`<a href="https://old">go</a>`);
    selectContents(el.querySelector("a")!.firstChild!);
    applyLink(el, "https://new");
    expect(el.querySelector("a")!.getAttribute("href")).toBe("https://new");
  });

  test("UNWRAP branch: a null/empty href removes the <a> but preserves the text (real DOM)", () => {
    const el = mountEditable(`before <a href="https://x">link</a> after`);
    selectContents(el.querySelector("a")!.firstChild!);
    applyLink(el, null);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("link");
    expect(el.textContent).toContain("before");
    expect(el.textContent).toContain("after");
  });

  test("CREATE branch: with no existing <a>, a non-empty href calls execCommand('createLink')", () => {
    const el = mountEditable("plain");
    selectContents(el.firstChild!);
    const calls: unknown[][] = [];
    (document as unknown as Record<string, unknown>).execCommand = (...args: unknown[]) => {
      calls.push(args);
      return true;
    };
    applyLink(el, "https://made");
    expect(calls).toEqual([["createLink", false, "https://made"]]);
  });

  test("no existing <a> and an empty href does nothing (no execCommand)", () => {
    const el = mountEditable("plain");
    selectContents(el.firstChild!);
    const calls: unknown[][] = [];
    (document as unknown as Record<string, unknown>).execCommand = (...args: unknown[]) => {
      calls.push(args);
      return true;
    };
    applyLink(el, "");
    expect(calls).toEqual([]);
  });
});

describe("insertTemplateToken", () => {
  test("focuses the root and inserts ${token} via execCommand('insertText')", () => {
    const el = mountEditable("");
    selectContents(el);
    const calls: unknown[][] = [];
    (document as unknown as Record<string, unknown>).execCommand = (...args: unknown[]) => {
      calls.push(args);
      return true;
    };
    insertTemplateToken(el, "state.title");
    expect(calls).toEqual([["insertText", false, "${state.title}"]]);
  });
});
