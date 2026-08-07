/**
 * Tests for the `reference` form control (src/ui/form-controls.ts) and the dispatch that reaches it
 * (src/ui/schema-form.ts's `referenceTarget`).
 *
 * The control is registered ONCE and every form gets it, so these assertions are about the whole
 * §9.2 promise: a `$ref` to a collection is a picker in the entry editor, in a settings form and in
 * an array-of-objects row, without any of those three knowing the control exists.
 */
import { flush, pointer } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { html, render } from "lit-html";

let ids: string[] = ["ada", "grace"];
let listError = "";
let listCalls = 0;

void mock.module("../src/grid/sources/content-source", () => ({
  listCollectionEntryIds: async (name: string) => {
    listCalls += 1;
    if (listError) {
      throw new Error(listError);
    }
    return name === "authors" ? ids : [];
  },
}));

const { invalidateReferenceEntries } = await import("../src/ui/form-controls");
const { renderForm, renderInlineField } = await import("../src/ui/schema-form");
const { referenceTarget } = await import("../src/ui/schema-form");

interface Mounted {
  container: HTMLElement;
  patches: Record<string, unknown>[];
  redraw: () => void;
}

/** Mount one `author` field over a live value, repainting on the control's own rerender hook. */
function mountReference(value: unknown, schema: Record<string, unknown>): Mounted {
  const container = document.createElement("div");
  const patches: Record<string, unknown>[] = [];
  const state = { value };
  const redraw = () => {
    render(
      html`${renderForm(
        { properties: { author: schema } },
        { author: state.value },
        {
          onChange: (patch) => {
            patches.push(patch);
            state.value = patch.author;
            redraw();
          },
          rerender: () => redraw(),
        },
      )}`,
      container,
    );
  };
  redraw();
  return { container, patches, redraw };
}

function picker(container: HTMLElement): HTMLElement | null {
  return container.querySelector("sp-picker.reference-field");
}

function choose(el: Element, value: string): void {
  (el as HTMLElement & { value: string }).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  ids = ["ada", "grace"];
  listError = "";
  listCalls = 0;
  invalidateReferenceEntries();
});

describe("referenceTarget", () => {
  test("names the collection a #/content pointer references, and nothing else", () => {
    expect(referenceTarget({ $ref: "#/content/authors" })).toBe("authors");
    expect(referenceTarget({ $ref: "#/state/authors" })).toBeNull();
    expect(referenceTarget({ $ref: "#/content/authors/extra" })).toBeNull();
    expect(referenceTarget({})).toBeNull();
    // A field with no schema at all — the inline path hands one through.
    const noSchema: { $ref?: string } | undefined = undefined;
    expect(referenceTarget(noSchema)).toBeNull();
  });
});

describe("the control", () => {
  test("says it is loading, then draws the collection's entries", async () => {
    const m = mountReference("", { $ref: "#/content/authors" });
    expect(picker(m.container)?.getAttribute("label")).toBe("Loading…");
    await flush();
    const options = [...m.container.querySelectorAll("sp-menu-item")].map((o) => o.textContent);
    expect(options).toEqual(["—", "ada", "grace"]);
  });

  test("commits the chosen id, and clears to undefined", async () => {
    const m = mountReference("", { $ref: "#/content/authors" });
    await flush();
    choose(picker(m.container)!, "grace");
    expect(m.patches.at(-1)).toEqual({ author: "grace" });
    await flush();
    choose(picker(m.container)!, "__none__");
    expect(m.patches.at(-1)).toEqual({ author: undefined });
  });

  test("keeps a dangling reference visible instead of blanking the field", async () => {
    const m = mountReference("hopper", { $ref: "#/content/authors" });
    await flush();
    const missing = m.container.querySelector("sp-menu-item.reference-missing");
    expect(missing?.textContent).toBe("hopper — not found");
    expect(picker(m.container)?.getAttribute("value")).toBe("hopper");
  });

  test("an empty collection says so rather than presenting a blank dropdown", async () => {
    const m = mountReference("", { $ref: "#/content/nobody" });
    await flush();
    expect(m.container.querySelector(".reference-note")?.textContent).toContain(
      "No nobody entries yet",
    );
  });

  test("a failed read stays editable, names the reason, and retries", async () => {
    listError = "EACCES";
    const m = mountReference("ada", { $ref: "#/content/authors" });
    await flush();
    expect(m.container.querySelector(".reference-note--failed")?.textContent).toContain("EACCES");
    const field = m.container.querySelector("sp-textfield.reference-field") as HTMLElement & {
      value: string;
    };
    expect(field).not.toBeNull();
    field.value = "grace";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(m.patches.at(-1)).toEqual({ author: "grace" });

    listError = "";
    pointer(m.container.querySelector("sp-action-button")!, "click");
    await flush();
    expect(picker(m.container)).not.toBeNull();
  });

  test("reads a collection once and forgets it only when invalidated", async () => {
    mountReference("", { $ref: "#/content/authors" });
    await flush();
    expect(listCalls).toBe(1);
    mountReference("", { $ref: "#/content/authors" });
    await flush();
    expect(listCalls).toBe(1);
    invalidateReferenceEntries("authors");
    mountReference("", { $ref: "#/content/authors" });
    await flush();
    expect(listCalls).toBe(2);
  });

  test("a `ui.control` override on a field that references nothing stays editable and says why", async () => {
    const container = document.createElement("div");
    const patches: Record<string, unknown>[] = [];
    render(
      html`${renderForm(
        { properties: { author: { type: "string" } } },
        { author: "ada" },
        {
          onChange: (patch) => patches.push(patch),
          ui: { author: { control: "reference" } },
        },
      )}`,
      container,
    );
    await flush();
    expect(container.querySelector(".reference-note")?.textContent).toContain(
      "No collection referenced",
    );
    const field = container.querySelector("sp-textfield.reference-field") as HTMLElement & {
      value: string;
    };
    field.value = "grace";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(patches.at(-1)).toEqual({ author: "grace" });
  });
});

describe("every consumer gets it without asking", () => {
  test("the frontmatter renderer reaches the registry rather than its own ladder", async () => {
    const { renderFmField } = await import("../src/panels/frontmatter-fields");
    // The renderer takes its tab now (it is drawn per pane by the Document Header card), so the
    // Document it commits into has to exist before the widget is built.
    const { closeAllTabs, openTab } = await import("../src/workspace/workspace");
    closeAllTabs();
    const tab = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "content/blog/hello.md",
      frontmatter: { author: "ada" },
      id: "content/blog/hello.md",
    });
    const container = document.createElement("div");
    render(
      html`${renderFmField(tab, "author", { $ref: "#/content/authors" }, "ada", new Set())}`,
      container,
    );
    await flush();
    // Before this dispatch a `$ref` field fell through to a bare textfield: an entry id typed from
    // Memory, with no list and no sign when it was wrong.
    expect(container.querySelector("sp-picker.reference-field")).not.toBeNull();
    expect((container.querySelector(".style-row") as HTMLElement | null)?.dataset.prop).toBe(
      "author",
    );

    // And it commits through the document's transaction log, like every other frontmatter widget.
    choose(container.querySelector("sp-picker.reference-field")!, "grace");
    expect(tab.doc.content.frontmatter.author).toBe("grace");
    closeAllTabs();
  });

  test("a settled collection renders synchronously — no Loading flash on every repaint", async () => {
    const first = mountReference("", { $ref: "#/content/authors" });
    await flush();
    expect(picker(first.container)).not.toBeNull();
    // A second field, drawn after the read settled, must not fall back to the placeholder: the
    // Enclosing form repaints on every keystroke in the field beside it.
    const second = mountReference("ada", { $ref: "#/content/authors" });
    expect(picker(second.container)?.getAttribute("label")).not.toBe("Loading…");
    expect(second.container.querySelectorAll("sp-menu-item")).toHaveLength(3);
  });

  test("a plain renderForm field dispatches on the schema alone", async () => {
    const m = mountReference("", { $ref: "#/content/authors" });
    await flush();
    expect(picker(m.container)).not.toBeNull();
  });

  test("an inline field inside an array-of-objects row dispatches too", async () => {
    const container = document.createElement("div");
    const commits: unknown[] = [];
    const draw = () => {
      render(
        html`${renderInlineField(
          "author",
          { $ref: "#/content/authors" },
          "",
          (v) => commits.push(v),
          undefined,
          undefined,
          () => draw(),
        )}`,
        container,
      );
    };
    draw();
    await flush();
    const inline = container.querySelector("sp-picker.reference-field");
    expect(inline).not.toBeNull();
    choose(inline!, "ada");
    expect(commits).toEqual(["ada"]);
  });
});
