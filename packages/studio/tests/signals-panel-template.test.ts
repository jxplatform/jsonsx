/**
 * Signals panel — renderSignalsTemplate interaction coverage: category grouping, accordion
 * collapse, row expansion, add/delete defs, and the per-category inline editors (state, computed,
 * data sources, functions/CEM, expressions).
 */
import {
  flush,
  installMockPlatform,
  key,
  pointer,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { activeTab } from "../src/workspace/workspace";
import { setExtensions } from "../src/format/format-host";
import { renderSignalsTemplate } from "../src/panels/signals-panel";
import { pluginSchemaCache } from "../src/services/code-services";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── Local helpers ────────────────────────────────────────────────────────────

interface Mounted {
  container: HTMLElement;
  calls: { canvas: number; left: number; session: Record<string, unknown>[] };
  ctx: {
    renderLeftPanel: () => void;
    renderCanvas: () => void;
    updateSession: (p: Record<string, unknown>) => void;
  };
  S: Record<string, unknown>;
}

/** Mount the signals template against the active tab with a re-rendering ctx. */
function mountSignals(extra: Record<string, unknown> = {}): Mounted {
  const container = document.createElement("div");
  const calls = { canvas: 0, left: 0, session: [] as Record<string, unknown>[] };
  const tab = activeTab.value;
  if (!tab) {
    throw new Error("no active tab");
  }
  const S: Record<string, unknown> = { document: tab.doc.document, ...extra };
  const ctx = {
    renderCanvas: () => {
      calls.canvas += 1;
    },
    renderLeftPanel: () => {
      calls.left += 1;
      S.document = activeTab.value?.doc.document;
      render(renderSignalsTemplate(S as never, ctx), container);
    },
    updateSession: (patch: Record<string, unknown>) => {
      calls.session.push(patch);
    },
  };
  ctx.renderLeftPanel();
  calls.left = 0;
  return { calls, container, ctx, S };
}

function setup(
  state: Record<string, unknown> | undefined,
  opts: { tagName?: string; extra?: Record<string, unknown> } = {},
): Mounted {
  resetWorkspaceWithTab({
    children: [],
    tagName: opts.tagName ?? "div",
    ...(state !== undefined && { state }),
  } as unknown as JxMutableNode);
  return mountSignals(opts.extra ?? {});
}

function docState(): Record<string, never> {
  return (activeTab.value?.doc.document.state ?? {}) as Record<string, never>;
}

function findRow(container: HTMLElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll(".signal-row")].find(
    (r) => r.querySelector(".signal-name")?.textContent === name,
  ) as HTMLElement | undefined;
}

/** Expand a signal row (idempotent) and return its editor element. */
async function expand(h: Mounted, name: string): Promise<HTMLElement> {
  let row = findRow(h.container, name);
  if (!row) {
    throw new Error(`no row for ${name}`);
  }
  if (!row.classList.contains("expanded")) {
    pointer(row, "click");
    await flush(1);
  }
  row = findRow(h.container, name);
  expect(row?.classList.contains("expanded")).toBe(true);
  const editor = h.container.querySelector(".signal-editor");
  if (!editor) {
    throw new Error("no editor rendered");
  }
  return editor as HTMLElement;
}

function fieldEl<T extends Element>(scope: HTMLElement, prop: string, selector: string): T {
  const row = scope.querySelector(`[data-prop="${prop}"]`);
  if (!row) {
    throw new Error(`no field row ${prop}`);
  }
  const el = row.querySelector(selector);
  if (!el) {
    throw new Error(`no ${selector} in row ${prop}`);
  }
  return el as T;
}

type ValueEl = HTMLElement & { value: string };

/** Set a control's value and fire change (immediate commit path). */
function commitValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Set a control's value and fire input only (debounced commit path). */
function inputValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function findByText(scope: HTMLElement, selector: string, text: string): HTMLElement | undefined {
  return [...scope.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text) as
    | HTMLElement
    | undefined;
}

function addPicker(h: Mounted): ValueEl {
  const picker = h.container.querySelector(".signals-add sp-picker");
  if (!picker) {
    throw new Error("no add picker");
  }
  return picker as ValueEl;
}

beforeEach(() => {
  resetStudioState();
  installMockPlatform();
  pluginSchemaCache.clear();
});

// ─── Grouping and structure ───────────────────────────────────────────────────

describe("renderSignalsTemplate structure", () => {
  test("groups defs by category into labeled accordion items", () => {
    const h = setup({
      $count: { default: 0, type: "integer" },
      $double: { $compute: "$count * 2" },
      $items: { $prototype: "Request", url: "/api" },
      $push: { $expression: { operator: "push", target: { $ref: "#/state/$count" } } },
      $title: { default: "x", type: "string" },
      save: { $prototype: "Function", body: "" },
    });
    const labels = [...h.container.querySelectorAll("sp-accordion-item")].map((el) =>
      el.getAttribute("label"),
    );
    expect(labels).toEqual([
      "State (2)",
      "Computed (1)",
      "Data (1)",
      "Expressions (1)",
      "Functions (1)",
    ]);
    expect(h.container.querySelector(".empty-state")).toBeNull();
    // Badge and hint rendered per row
    const row = findRow(h.container, "$items");
    expect(row?.querySelector(".signal-badge")?.textContent).toBe("R");
    expect(row?.querySelector(".signal-hint")?.textContent).toBe("GET /api");
  });

  test("naked primitive and array state entries group safely under State", () => {
    const h = setup({ list: ["a"], plain: 5 } as never);
    const labels = [...h.container.querySelectorAll("sp-accordion-item")].map((el) =>
      el.getAttribute("label"),
    );
    expect(labels).toEqual(["State (2)"]);
    expect(findRow(h.container, "plain")?.querySelector(".signal-badge")?.textContent).toBe("S");
  });

  test("no state → the empty state teaches, and its button adds the same def the picker does", () => {
    const h = setup(undefined);
    expect(h.container.querySelector(".empty-state-message")?.textContent).toContain(
      "Data lives here",
    );
    expect(h.container.querySelectorAll("sp-accordion-item").length).toBe(0);

    (h.container.querySelector(".empty-state-action") as HTMLElement).click();
    expect(docState().$newSignal).toEqual({ default: "", type: "string" } as never);
    expect(h.calls.left).toBeGreaterThan(0);
  });

  test("accordion toggle collapses and re-expands a category", async () => {
    const h = setup({ $a: { default: "" } });
    let item = h.container.querySelector("sp-accordion-item");
    expect(item?.hasAttribute("open")).toBe(true);

    item?.dispatchEvent(new Event("sp-accordion-item-toggle", { bubbles: true }));
    await flush(1);
    item = h.container.querySelector("sp-accordion-item");
    expect(item?.hasAttribute("open")).toBe(false);

    item?.dispatchEvent(new Event("sp-accordion-item-toggle", { bubbles: true }));
    await flush(1);
    item = h.container.querySelector("sp-accordion-item");
    expect(item?.hasAttribute("open")).toBe(true);
  });

  test("clicking a row expands its editor; clicking again collapses", async () => {
    const h = setup({ $a: { default: "x" } });
    const editor = await expand(h, "$a");
    expect(editor.querySelector('[data-prop="Name"]')).not.toBeNull();

    const row = findRow(h.container, "$a");
    pointer(row as Element, "click");
    await flush(1);
    expect(h.container.querySelector(".signal-editor")).toBeNull();
  });

  test("delete button removes the def without expanding the row", () => {
    const h = setup({ $a: { default: "x" }, $b: { default: "y" } });
    const row = findRow(h.container, "$a");
    pointer(row?.querySelector(".signal-del") as Element, "click");
    expect(docState().$a).toBeUndefined();
    expect(docState().$b).toBeDefined();
  });
});

// ─── Add picker ───────────────────────────────────────────────────────────────

describe("add picker", () => {
  test("adds a state signal from the template and expands it", async () => {
    const h = setup({});
    commitValue(addPicker(h), "state");
    await flush(1);
    expect(docState().$newSignal).toEqual({ default: "", type: "string" } as never);
    expect(findRow(h.container, "$newSignal")?.classList.contains("expanded")).toBe(true);
  });

  test("name collisions increment a numeric suffix", () => {
    const h = setup({ $newSignal: { default: "taken" } });
    commitValue(addPicker(h), "state");
    expect(docState().$newSignal1).toEqual({ default: "", type: "string" } as never);
  });

  test("function template uses newFunction base name", () => {
    const h = setup({});
    commitValue(addPicker(h), "function");
    expect(docState().newFunction).toEqual({
      $prototype: "Function",
      body: "",
      parameters: [],
    } as never);
  });

  test("request template seeds method/timing/url", () => {
    const h = setup({});
    commitValue(addPicker(h), "request");
    expect(docState().$newSignal).toEqual({
      $prototype: "Request",
      method: "GET",
      timing: "client",
      url: "",
    } as never);
  });

  test("empty or unknown picker values are no-ops", () => {
    const h = setup({});
    commitValue(addPicker(h), "");
    commitValue(addPicker(h), "bogus");
    expect(Object.keys(docState())).toEqual([]);
  });

  test("project imports appear as menu items and add a prototype def", async () => {
    resetStudioState({
      projectConfig: { imports: { ContentCollection: "./plugins/cc.js" } },
    });
    const h = setup({});
    const menuValues = [...h.container.querySelectorAll(".signals-add sp-menu-item")].map((el) =>
      el.getAttribute("value"),
    );
    expect(menuValues).toContain("import:ContentCollection");

    let fetched = 0;
    installMockPlatform({
      fetchPluginSchema: async () => {
        fetched += 1;
        return { properties: { source: { type: "string" } } };
      },
    });
    commitValue(addPicker(h), "import:ContentCollection");
    expect(docState().$contentCollection).toEqual({ $prototype: "ContentCollection" } as never);
    await flush();
    // Schema fetched through the platform and cached, then the panel re-rendered
    expect(fetched).toBe(1);
    expect(pluginSchemaCache.get("./plugins/cc.js::ContentCollection")).toEqual({
      properties: { source: { type: "string" } },
    });
    expect(h.calls.left).toBeGreaterThan(0);
  });

  test("import without a known source path still adds the def and re-renders", () => {
    resetStudioState({ projectConfig: { imports: { Known: "./k.js" } } });
    const h = setup({ $missing: { $prototype: "Missing" } });
    commitValue(addPicker(h), "import:Missing");
    // Collision with the existing $missing def → suffix
    expect(docState().$missing1).toEqual({ $prototype: "Missing" } as never);
    expect(h.calls.left).toBeGreaterThan(0);
  });

  test("extension state classes appear as menu items and seed stateDefaults", () => {
    setExtensions([
      {
        classes: [
          // Auth carries admission blocks → not a state class, so no menu item.
          { name: "Auth", path: "/ext/Auth.class.json" },
          {
            name: "Session",
            path: "/ext/Session.class.json",
            state: true,
            stateDefaults: { timing: "client" },
          },
          { name: "AuthActions", path: "/ext/AuthActions.class.json", state: true },
        ],
        contributions: [],
        name: "@jxsuite/auth",
        specifier: "@jxsuite/auth",
      },
    ]);
    try {
      const h = setup({});
      const menuValues = [...h.container.querySelectorAll(".signals-add sp-menu-item")].map((el) =>
        el.getAttribute("value"),
      );
      expect(menuValues).toContain("ext:Session");
      expect(menuValues).toContain("ext:AuthActions");
      expect(menuValues).not.toContain("ext:Auth");

      // The descriptor's stateDefaults seed the created def (specs/extensions.md §10).
      commitValue(addPicker(h), "ext:Session");
      expect(docState().$session).toEqual({ $prototype: "Session", timing: "client" } as never);
      // Without stateDefaults the def is the bare prototype reference.
      commitValue(addPicker(h), "ext:AuthActions");
      expect(docState().$authActions).toEqual({ $prototype: "AuthActions" } as never);
      expect(h.calls.left).toBeGreaterThan(0);
    } finally {
      setExtensions([]);
    }
  });
});

// ─── State signal editor ──────────────────────────────────────────────────────

describe("state signal editor", () => {
  test("rename commits through the Name field", async () => {
    const h = setup({ $old: { default: "v" } });
    const editor = await expand(h, "$old");
    commitValue(fieldEl(editor, "Name", "sp-textfield"), "$renamed");
    expect(docState().$old).toBeUndefined();
    expect(docState().$renamed).toEqual({ default: "v" } as never);
  });

  test("rename to an existing name is rejected", async () => {
    const h = setup({ $a: { default: 1 }, $b: { default: 2 } });
    const editor = await expand(h, "$a");
    commitValue(fieldEl(editor, "Name", "sp-textfield"), "$b");
    expect(docState().$a).toEqual({ default: 1 } as never);
    expect(docState().$b).toEqual({ default: 2 } as never);
  });

  test("type picker updates the def", async () => {
    const h = setup({ $sig: { default: "", type: "string" } });
    const editor = await expand(h, "$sig");
    commitValue(fieldEl(editor, "Type", "sp-picker"), "integer");
    expect((docState().$sig! as { type: string }).type).toBe("integer");
  });

  test("format picker shows for string type and switches Default to a media picker", async () => {
    const h = setup({ $img: { default: "", type: "string" } });
    let editor = await expand(h, "$img");
    commitValue(fieldEl(editor, "Format", "sp-picker"), "image");
    expect((docState().$img! as { format: string }).format).toBe("image");

    h.ctx.renderLeftPanel();
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    expect(editor.querySelector(".media-picker")).not.toBeNull();

    // Media picker input commits the default after its debounce
    const tf = editor.querySelector(".media-picker sp-textfield") as Element;
    inputValue(tf, "/hero.png");
    await new Promise((r) => {
      setTimeout(r, 450);
    });
    expect((docState().$img! as { default: string }).default).toBe("/hero.png");
  });

  test("format row hidden for non-string types", async () => {
    const h = setup({ $n: { default: 1, type: "integer" } });
    const editor = await expand(h, "$n");
    expect(editor.querySelector('[data-prop="Format"]')).toBeNull();
  });

  test("default values parse per type", async () => {
    const h = setup({
      $arr: { default: [], type: "array" },
      $bool: { default: false, type: "boolean" },
      $int: { default: 0, type: "integer" },
      $num: { default: 0, type: "number" },
      $obj: { default: {}, type: "object" },
      $str: { default: "", type: "string" },
    });

    let editor = await expand(h, "$int");
    commitValue(fieldEl(editor, "Default", "sp-textfield"), "42");
    expect((docState().$int! as { default: number }).default).toBe(42);

    editor = await expand(h, "$num");
    commitValue(fieldEl(editor, "Default", "sp-textfield"), "3.5");
    expect((docState().$num! as { default: number }).default).toBe(3.5);

    editor = await expand(h, "$bool");
    commitValue(fieldEl(editor, "Default", "sp-textfield"), "true");
    expect((docState().$bool! as { default: boolean }).default).toBe(true);

    editor = await expand(h, "$arr");
    commitValue(fieldEl(editor, "Default", "sp-textfield"), '["a","b"]');
    expect((docState().$arr! as { default: string[] }).default).toEqual(["a", "b"]);

    // Invalid JSON falls back to the raw string
    editor = await expand(h, "$obj");
    commitValue(fieldEl(editor, "Default", "sp-textfield"), "{oops");
    expect((docState().$obj! as { default: string }).default).toBe("{oops");

    editor = await expand(h, "$str");
    commitValue(fieldEl(editor, "Default", "sp-textfield"), "plain");
    expect((docState().$str! as { default: string }).default).toBe("plain");
  });

  test("invalid integer default coerces to 0 and object default displays as JSON", async () => {
    const h = setup({
      $int: { default: 0, type: "integer" },
      $obj: { default: { a: 1 }, type: "object" },
    });
    let editor = await expand(h, "$int");
    commitValue(fieldEl(editor, "Default", "sp-textfield"), "abc");
    expect((docState().$int! as { default: number }).default).toBe(0);

    editor = await expand(h, "$obj");
    const tf = fieldEl<ValueEl>(editor, "Default", "sp-textfield");
    expect(tf.value).toBe('{"a":1}');
  });

  test("description commits and clears to undefined", async () => {
    const h = setup({ $s: { default: "" } });
    let editor = await expand(h, "$s");
    commitValue(fieldEl(editor, "Description", "sp-textfield"), "my desc");
    expect((docState().$s! as { description: string }).description).toBe("my desc");

    h.ctx.renderLeftPanel();
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    commitValue(fieldEl(editor, "Description", "sp-textfield"), "");
    expect((docState().$s! as { description?: string }).description).toBeUndefined();
  });

  test("custom element docs expose CEM fields (attribute, reflects, deprecated)", async () => {
    const h = setup({ $open: { default: false, type: "boolean" } }, { tagName: "my-card" });
    const editor = await expand(h, "$open");

    commitValue(fieldEl(editor, "Attribute", "sp-textfield"), "open");
    expect((docState().$open! as { attribute: string }).attribute).toBe("open");

    const check = fieldEl<HTMLElement & { checked: boolean }>(editor, "reflects", "sp-checkbox");
    check.checked = true;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docState().$open! as { reflects: boolean }).reflects).toBe(true);

    check.checked = false;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docState().$open! as { reflects?: boolean }).reflects).toBeUndefined();

    commitValue(fieldEl(editor, "Deprecated", "sp-textfield"), "use $visible");
    expect((docState().$open! as { deprecated: string }).deprecated).toBe("use $visible");
  });

  test("non-custom-element docs hide CEM fields", async () => {
    const h = setup({ $s: { default: "" } });
    const editor = await expand(h, "$s");
    expect(editor.querySelector('[data-prop="Attribute"]')).toBeNull();
    expect(editor.querySelector('[data-prop="reflects"]')).toBeNull();
  });
});

// ─── Computed editor ──────────────────────────────────────────────────────────

describe("computed editor", () => {
  test("shows expression and dependency list; typing recomputes $deps after debounce", async () => {
    const h = setup({
      $sum: { $compute: "$a + $b", $deps: ["#/state/$a", "#/state/$b"] },
    });
    const editor = await expand(h, "$sum");
    const ta = fieldEl<ValueEl>(editor, "expression", "textarea");
    expect(ta.value).toBe("$a + $b");
    expect(editor.querySelector('[data-prop="dependencies"]')?.textContent).toContain("$a, $b");

    inputValue(ta, "$x * $y + $x");
    await new Promise((r) => {
      setTimeout(r, 540);
    });
    const def = docState().$sum! as { $compute: string; $deps: string[] };
    expect(def.$compute).toBe("$x * $y + $x");
    expect(def.$deps).toEqual(["#/state/$x", "#/state/$y"]);
  });

  test("dependencies row hidden when $deps is empty", async () => {
    const h = setup({ $c: { $compute: "1" } });
    const editor = await expand(h, "$c");
    expect(editor.querySelector('[data-prop="dependencies"]')).toBeNull();
  });
});

// ─── Data source editors ──────────────────────────────────────────────────────

describe("data source editors", () => {
  test("Request: url, method and timing commit", async () => {
    const h = setup({ $req: { $prototype: "Request", method: "GET", timing: "client", url: "" } });
    const editor = await expand(h, "$req");
    commitValue(fieldEl(editor, "URL", "sp-textfield"), "/api/posts");
    commitValue(fieldEl(editor, "Method", "sp-picker"), "POST");
    commitValue(fieldEl(editor, "Timing", "sp-picker"), "server");
    const def = docState().$req! as { method: string; timing: string; url: string };
    expect(def.url).toBe("/api/posts");
    expect(def.method).toBe("POST");
    expect(def.timing).toBe("server");
  });

  test("LocalStorage: key commits; default parses JSON or keeps raw string", async () => {
    const h = setup({ $ls: { $prototype: "LocalStorage", default: null, key: "" } });
    const editor = await expand(h, "$ls");
    commitValue(fieldEl(editor, "Key", "sp-textfield"), "theme");
    commitValue(fieldEl(editor, "Default", "textarea"), '{"mode":"dark"}');
    expect((docState().$ls! as { key: string }).key).toBe("theme");
    expect((docState().$ls! as { default: unknown }).default).toEqual({ mode: "dark" } as never);

    commitValue(fieldEl(editor, "Default", "textarea"), "not json");
    expect((docState().$ls! as { default: unknown }).default).toBe("not json" as never);
  });

  test("SessionStorage renders object defaults as pretty JSON", async () => {
    const h = setup({ $ss: { $prototype: "SessionStorage", default: { mode: "dark" }, key: "k" } });
    const editor = await expand(h, "$ss");
    const ta = fieldEl<ValueEl>(editor, "Default", "textarea");
    expect(JSON.parse(ta.value)).toEqual({ mode: "dark" });
  });

  test("IndexedDB: database/store commit; version parses with fallback to 1", async () => {
    const h = setup({ $db: { $prototype: "IndexedDB", database: "", store: "", version: 1 } });
    const editor = await expand(h, "$db");
    commitValue(fieldEl(editor, "Database", "sp-textfield"), "appdb");
    commitValue(fieldEl(editor, "Store", "sp-textfield"), "items");
    commitValue(fieldEl(editor, "Version", "sp-textfield"), "5");
    let def = docState().$db! as { database: string; store: string; version: number };
    expect(def.database).toBe("appdb");
    expect(def.store).toBe("items");
    expect(def.version).toBe(5);

    commitValue(fieldEl(editor, "Version", "sp-textfield"), "bogus");
    def = docState().$db as never;
    expect(def.version).toBe(1);
  });

  test("Cookie: name and default commit", async () => {
    const h = setup({ $ck: { $prototype: "Cookie", default: "", name: "" } });
    const editor = await expand(h, "$ck");
    commitValue(fieldEl(editor, "Cookie", "sp-textfield"), "sid");
    commitValue(fieldEl(editor, "Default", "sp-textfield"), "anon");
    const def = docState().$ck! as { default: string; name: string };
    expect(def.name).toBe("sid");
    expect(def.default).toBe("anon");
  });

  test("Set: JSON default commits; invalid JSON is ignored", async () => {
    const h = setup({ $set: { $prototype: "Set", default: [] } });
    const editor = await expand(h, "$set");
    commitValue(fieldEl(editor, "Default", "textarea"), '["a","b"]');
    expect((docState().$set! as { default: string[] }).default).toEqual(["a", "b"]);

    commitValue(fieldEl(editor, "Default", "textarea"), "{nope");
    expect((docState().$set! as { default: string[] }).default).toEqual(["a", "b"]);
  });

  test("FormData edits the fields key and renders existing fields as JSON", async () => {
    const h = setup({ $fd: { $prototype: "FormData", fields: { email: "" } } });
    const editor = await expand(h, "$fd");
    const ta = fieldEl<ValueEl>(editor, "Fields", "textarea");
    expect(JSON.parse(ta.value)).toEqual({ email: "" });
    commitValue(ta, '{"email":"","name":""}');
    expect((docState().$fd! as { fields: unknown }).fields).toEqual({
      email: "",
      name: "",
    } as never);
  });

  test("Map renders its default and commits parsed JSON", async () => {
    const h = setup({ $map: { $prototype: "Map", default: { a: 1 } } });
    const editor = await expand(h, "$map");
    const ta = fieldEl<ValueEl>(editor, "Default", "textarea");
    expect(JSON.parse(ta.value)).toEqual({ a: 1 });
    commitValue(ta, '{"b":2}');
    expect((docState().$map! as { default: unknown }).default).toEqual({ b: 2 } as never);
  });

  test("unknown prototype falls back to the external plugin editor", async () => {
    const h = setup({ $ext: { $prototype: "Widget", $src: "./w.js" } });
    const editor = await expand(h, "$ext");
    expect(editor.querySelector('[data-prop="Source"]')).not.toBeNull();
    expect(editor.querySelector('[data-prop="Kind"]')).not.toBeNull();
  });
});

// ─── Function editor ──────────────────────────────────────────────────────────

describe("function editor", () => {
  test("description and body commit; code-editor button updates the session", async () => {
    const h = setup({ save: { $prototype: "Function", body: "", parameters: [] } });
    const editor = await expand(h, "save");

    commitValue(fieldEl(editor, "Description", "sp-textfield"), "saves things");
    expect((docState().save! as { description: string }).description).toBe("saves things");

    const body = editor.querySelector('textarea[style*="--font-mono"]') as ValueEl;
    inputValue(body, "console.log(1)");
    expect((docState().save! as { body: string }).body).toBe("console.log(1)");

    pointer(
      editor.querySelector('sp-action-button[title="Open in code editor"]') as Element,
      "click",
    );
    expect(h.calls.session).toEqual([
      { ui: { editingFunction: { defName: "save", type: "def" } } },
    ]);
    expect(h.calls.canvas).toBe(1);
  });

  test("external function shows Source/Export fields instead of a body", async () => {
    const h = setup({ run: { $export: "runIt", $prototype: "Function", $src: "./fns.js" } });
    const editor = await expand(h, "run");
    expect(editor.querySelector('textarea[style*="--font-mono"]')).toBeNull();

    commitValue(fieldEl(editor, "Source", "sp-textfield"), "./other.js");
    commitValue(fieldEl(editor, "Export", "sp-textfield"), "main");
    const def = docState().run! as { $export: string; $src: string };
    expect(def.$src).toBe("./other.js");
    expect(def.$export).toBe("main");
  });

  test("basic parameters: chips render, Enter adds, × removes, last removal clears the key", async () => {
    const h = setup({ go: { $prototype: "Function", body: "", parameters: ["a", "b"] } });
    let editor = await expand(h, "go");
    const paramsRow = editor.querySelector('[data-prop="parameters"]') as HTMLElement;

    // Add via Enter in the "+" input
    const addInput = paramsRow.querySelector('input[placeholder="+"]') as ValueEl;
    addInput.value = "c";
    key(addInput, "Enter");
    expect((docState().go! as { parameters: unknown[] }).parameters).toEqual([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ] as never[]);

    // Non-Enter keys do nothing
    addInput.value = "d";
    key(addInput, "a");
    expect((docState().go! as { parameters: unknown[] }).parameters).toHaveLength(3);

    // Remove the first chip
    h.ctx.renderLeftPanel();
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    const firstRemove = [...editor.querySelectorAll('[data-prop="parameters"] span')].find(
      (el) => el.textContent?.trim() === "×",
    );
    pointer(firstRemove as Element, "click");
    expect((docState().go! as { parameters: unknown[] }).parameters).toEqual([
      { name: "b" },
      { name: "c" },
    ] as never[]);
  });

  test("removing the only parameter deletes the parameters key", async () => {
    const h = setup({ go: { $prototype: "Function", body: "", parameters: ["only"] } });
    const editor = await expand(h, "go");
    const remove = [...editor.querySelectorAll('[data-prop="parameters"] span')].find(
      (el) => el.textContent?.trim() === "×",
    );
    pointer(remove as Element, "click");
    expect((docState().go! as { parameters?: unknown }).parameters).toBeUndefined();
  });

  test("advanced parameter editor: edit name/type/description/optional, add and remove rows", async () => {
    const h = setup({
      adv: {
        $prototype: "Function",
        body: "",
        parameters: [{ name: "evt", type: { text: "Event" } }, "ctx"],
      },
    });
    let editor = await expand(h, "adv");

    // Switch to advanced mode. The advanced handlers close over render-time params, so re-render
    // (and re-query inputs) after every commit, like the real panel does.
    pointer(findByText(editor, "span", "▸ Advanced") as Element, "click");
    await flush(1);
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    const rowsSel = '[data-prop="parameters"] input.field-input';
    const inputsNow = () => [...editor.querySelectorAll(rowsSel)] as ValueEl[];
    const refresh = () => {
      h.ctx.renderLeftPanel();
      editor = h.container.querySelector(".signal-editor") as HTMLElement;
    };
    // 2 params × 3 text inputs each
    expect(inputsNow()).toHaveLength(6);
    expect(inputsNow()[1]?.value).toBe("Event");

    // Rename first param
    commitValue(inputsNow()[0] as Element, "event");
    let params = (docState().adv! as { parameters: never[] }).parameters;
    expect(params[0]).toEqual({ name: "event", type: { text: "Event" } } as never);

    // Clear its type, then set a description
    refresh();
    commitValue(inputsNow()[1] as Element, "");
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect(params[0]).toEqual({ name: "event" } as never);
    refresh();
    commitValue(inputsNow()[2] as Element, "the event");
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect((params[0]! as { description: string }).description).toBe("the event");

    // Set then clear the description on the second param
    refresh();
    commitValue(inputsNow()[5] as Element, "context");
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect((params[1]! as { description: string }).description).toBe("context");
    refresh();
    commitValue(inputsNow()[5] as Element, "");
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect((params[1]! as { description?: string }).description).toBeUndefined();

    // Toggle optional on and off
    refresh();
    const checkAt = (i: number) =>
      editor.querySelectorAll('[data-prop="parameters"] input[type="checkbox"]')[
        i
      ] as HTMLInputElement;
    let check0 = checkAt(0);
    check0.checked = true;
    check0.dispatchEvent(new Event("change", { bubbles: true }));
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect((params[0]! as { optional: boolean }).optional).toBe(true);
    refresh();
    check0 = checkAt(0);
    check0.checked = false;
    check0.dispatchEvent(new Event("change", { bubbles: true }));
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect((params[0]! as { optional?: boolean }).optional).toBeUndefined();

    // Type set branch ({ text }) on second param
    refresh();
    commitValue(inputsNow()[4] as Element, "AppContext");
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect((params[1]! as { type: unknown }).type).toEqual({ text: "AppContext" } as never);

    // Add a row
    refresh();
    pointer(findByText(editor, "button.kv-add", "+ Add parameter") as Element, "click");
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect(params).toHaveLength(3);
    expect(params[2]).toEqual({ name: "" } as never);

    // Remove a row via ×
    h.ctx.renderLeftPanel();
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    const removes = [...editor.querySelectorAll('[data-prop="parameters"] span')].filter(
      (el) => el.textContent?.trim() === "×",
    );
    pointer(removes[2] as Element, "click");
    params = (docState().adv! as { parameters: never[] }).parameters;
    expect(params).toHaveLength(2);

    // Back to basic mode
    pointer(findByText(editor, "span", "▾ Basic") as Element, "click");
    await flush(1);
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    expect(editor.querySelector('input[placeholder="+"]')).not.toBeNull();
  });

  test("removing the only advanced parameter clears the key", async () => {
    const h = setup({ solo: { $prototype: "Function", body: "", parameters: ["x"] } });
    let editor = await expand(h, "solo");
    pointer(findByText(editor, "span", "▸ Advanced") as Element, "click");
    await flush(1);
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    const remove = [...editor.querySelectorAll('[data-prop="parameters"] span')].find(
      (el) => el.textContent?.trim() === "×",
    );
    pointer(remove as Element, "click");
    expect((docState().solo! as { parameters?: unknown }).parameters).toBeUndefined();
  });
});

// ─── Function body mode (statements vs code, spec §20) ───────────────────────

describe("function body mode", () => {
  test("string body renders the Code mode: toggle present, textarea shown", async () => {
    const h = setup({ fn: { $prototype: "Function", body: "doIt()", parameters: [] } });
    const editor = await expand(h, "fn");
    expect(editor.querySelector(".body-mode-toggle")).not.toBeNull();
    expect(editor.querySelector(".body-mode-code")?.hasAttribute("selected")).toBe(true);
    expect(editor.querySelector(".body-mode-statements")?.hasAttribute("selected")).toBe(false);
    expect(editor.querySelector('textarea[style*="--font-mono"]')).not.toBeNull();
    expect(editor.querySelector(".statement-editor")).toBeNull();
  });

  test("array body renders the Statements mode with the statement editor", async () => {
    const h = setup({
      fn: { $prototype: "Function", body: [{ dispatchEvent: "ping" }], parameters: [] },
    });
    const editor = await expand(h, "fn");
    expect(editor.querySelector(".body-mode-statements")?.hasAttribute("selected")).toBe(true);
    expect(editor.querySelector(".statement-editor")).not.toBeNull();
    expect(editor.querySelector('textarea[style*="--font-mono"]')).toBeNull();
    // The code-editor (Monaco) affordance only applies to string bodies
    expect(editor.querySelector('sp-action-button[title="Open in code editor"]')).toBeNull();
  });

  test("switching to Statements seeds an empty array; switching back seeds an empty string", async () => {
    const h = setup({ fn: { $prototype: "Function", body: "doIt()", parameters: [] } });
    let editor = await expand(h, "fn");
    pointer(editor.querySelector(".body-mode-statements") as Element, "click");
    expect((docState().fn! as { body: unknown }).body).toEqual([] as never);

    // The toggle re-renders the panel; the statement editor is now live
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    expect(editor.querySelector(".statement-editor")).not.toBeNull();

    pointer(editor.querySelector(".body-mode-code") as Element, "click");
    expect((docState().fn! as { body: unknown }).body).toBe("" as never);
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    expect(editor.querySelector(".statement-editor")).toBeNull();
    expect(editor.querySelector('textarea[style*="--font-mono"]')).not.toBeNull();
  });

  test("re-clicking the active mode is a no-op", async () => {
    const h = setup({ fn: { $prototype: "Function", body: "keep me", parameters: [] } });
    const editor = await expand(h, "fn");
    pointer(editor.querySelector(".body-mode-code") as Element, "click");
    expect((docState().fn! as { body: unknown }).body).toBe("keep me" as never);
  });

  test("statement editor edits write the def body through mutateUpdateDef", async () => {
    const h = setup({ fn: { $prototype: "Function", body: [], parameters: [] } });
    const editor = await expand(h, "fn");
    const add = editor.querySelector("sp-picker.statement-add") as HTMLElement & { value: string };
    add.value = "set";
    add.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docState().fn! as { body: unknown }).body).toEqual([
      { operator: "=", target: { $ref: "" }, value: null },
    ] as never);
  });

  test("dispatch statements offer the def's declared emits names", async () => {
    const h = setup({
      fn: {
        $prototype: "Function",
        body: [{ dispatchEvent: "" }],
        emits: [{ name: "cart-changed" }],
        parameters: [],
      },
    });
    const editor = await expand(h, "fn");
    const combo = editor.querySelector(".statement-dispatch-name");
    expect(combo?.tagName.toLowerCase()).toBe("sp-combobox");
    const names = [...combo!.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"));
    expect(names).toEqual(["cart-changed"]);
  });

  test("row hint summarizes structured bodies by statement count", async () => {
    const h = setup({
      fn: { $prototype: "Function", body: [{ dispatchEvent: "a" }], parameters: [] },
      fn2: { $prototype: "Function", body: [], parameters: [] },
    });
    const row = [...h.container.querySelectorAll(".signal-row")].find(
      (r) => r.querySelector(".signal-name")?.textContent === "fn",
    );
    expect(row?.querySelector(".signal-hint")?.textContent).toBe("1 statement");
    const row2 = [...h.container.querySelectorAll(".signal-row")].find(
      (r) => r.querySelector(".signal-name")?.textContent === "fn2",
    );
    expect(row2?.querySelector(".signal-hint")?.textContent).toBe("0 statements");
  });
});

// ─── Emits editor (custom elements) ──────────────────────────────────────────

describe("emits editor", () => {
  test("hidden for non-custom-element documents", async () => {
    const h = setup({ fn: { $prototype: "Function", body: "" } });
    const editor = await expand(h, "fn");
    expect(editor.textContent).not.toContain("Emits");
  });

  test("edits event name, type, description; add and remove entries", async () => {
    const h = setup(
      {
        notify: {
          $prototype: "Function",
          body: "",
          emits: [
            { description: "old", name: "changed", type: { text: "CustomEvent" } },
            { name: "closed" },
          ],
        },
      },
      { tagName: "my-card" },
    );
    let editor = await expand(h, "notify");
    expect(editor.textContent).toContain("Emits");

    // Handlers close over render-time emits arrays — re-render and re-query between commits.
    const refresh = () => {
      h.ctx.renderLeftPanel();
      editor = h.container.querySelector(".signal-editor") as HTMLElement;
    };
    const inputAt = (placeholder: string, i: number) =>
      editor.querySelectorAll(`input[placeholder="${placeholder}"]`)[i] as ValueEl;

    expect(editor.querySelectorAll('input[placeholder="event name"]')).toHaveLength(2);
    commitValue(inputAt("event name", 0), "updated");
    let { emits } = docState().notify! as { emits: never[] };
    expect((emits[0]! as { name: string }).name).toBe("updated");

    // Clear type and description on the first event
    refresh();
    commitValue(inputAt("type", 0), "");
    ({ emits } = docState().notify! as { emits: never[] });
    expect((emits[0]! as { type?: unknown }).type).toBeUndefined();
    refresh();
    commitValue(inputAt("description", 0), "");
    ({ emits } = docState().notify! as { emits: never[] });
    expect((emits[0]! as { description?: string }).description).toBeUndefined();

    // Set type/description on the second event
    refresh();
    commitValue(inputAt("type", 1), "Event");
    refresh();
    commitValue(inputAt("description", 1), "fires on close");
    ({ emits } = docState().notify! as { emits: never[] });
    expect(emits[1]).toEqual({
      description: "fires on close",
      name: "closed",
      type: { text: "Event" },
    } as never);

    // Add an event
    refresh();
    pointer(findByText(editor, "button.kv-add", "+ Add event") as Element, "click");
    ({ emits } = docState().notify! as { emits: never[] });
    expect(emits).toHaveLength(3);
    expect(emits[2]).toEqual({ name: "" } as never);

    // Remove one of several
    h.ctx.renderLeftPanel();
    editor = h.container.querySelector(".signal-editor") as HTMLElement;
    const firstRemove = [...editor.querySelectorAll("span")].find(
      (el) => el.textContent?.trim() === "×" && el.closest('[data-prop="parameters"]') === null,
    );
    pointer(firstRemove as Element, "click");
    ({ emits } = docState().notify! as { emits: never[] });
    expect(emits).toHaveLength(2);
  });

  test("malformed CEM type objects render as empty type text", async () => {
    const h = setup(
      { fn: { $prototype: "Function", body: "", emits: [{ name: "e", type: { weird: 1 } }] } },
      { tagName: "x-el" },
    );
    const editor = await expand(h, "fn");
    const typeInput = editor.querySelector('input[placeholder="type"]') as ValueEl;
    expect(typeInput.value).toBe("");
  });

  test("removing the only event clears the emits key", async () => {
    const h = setup(
      { fn: { $prototype: "Function", body: "", emits: [{ name: "only" }] } },
      { tagName: "x-el" },
    );
    const editor = await expand(h, "fn");
    const remove = [...editor.querySelectorAll("span")].find(
      (el) => el.textContent?.trim() === "×" && el.closest('[data-prop="parameters"]') === null,
    );
    pointer(remove as Element, "click");
    expect((docState().fn! as { emits?: unknown }).emits).toBeUndefined();
  });
});

// ─── Expression editor ────────────────────────────────────────────────────────

describe("expression editor", () => {
  test("renders the expression editor and commits operator changes", async () => {
    const h = setup({
      $inc: { $expression: { operator: "=", target: { $ref: "#/state/$count" } } },
    });
    const editor = await expand(h, "$inc");
    const opPicker = fieldEl<ValueEl>(editor, "operator", "sp-picker");
    commitValue(opPicker, "!");
    const def = docState().$inc! as { $expression: { operator: string } };
    expect(def.$expression.operator).toBe("!");
  });

  test("missing $expression falls back to a default node", async () => {
    const h = setup({
      $e: { $expression: { operator: "push", target: { $ref: "#/state/$list" } } },
    });
    const editor = await expand(h, "$e");
    expect(editor.querySelector('[data-prop="operator"]')).not.toBeNull();
    expect(editor.querySelector('[data-prop="target"]')).not.toBeNull();
  });

  test("formula-workspace button updates the session and re-renders the canvas", async () => {
    const h = setup({
      $inc: { $expression: { operator: "=", target: { $ref: "#/state/$count" } } },
    });
    const editor = await expand(h, "$inc");
    pointer(
      editor.querySelector('sp-action-button[title="Open in formula workspace"]') as Element,
      "click",
    );
    expect(h.calls.session).toEqual([{ ui: { editingFormula: { defName: "$inc", type: "def" } } }]);
    expect(h.calls.canvas).toBe(1);
  });
});
