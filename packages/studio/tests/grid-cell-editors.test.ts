import { flush } from "./harness";
import { describe, expect, test } from "bun:test";
import { editorForColumn, formatterForColumn } from "../src/grid/cell-editors";
import type { CellLike } from "../src/grid/cell-editors";
import type { GridColumn } from "../src/grid/grid-source";

const makeHost = (className: string) => {
  const el = document.createElement("div");
  el.className = className;
  return el;
};

const col = (kind: GridColumn["kind"], schema?: GridColumn["schema"]): GridColumn => ({
  editable: kind !== "readonly",
  field: "f",
  kind,
  title: "F",
  ...(schema ? { schema } : {}),
});

const cellWith = (value: unknown): CellLike => ({ getValue: () => value });

/** Drive an editor factory and capture its success/cancel outcomes. */
function openEditor(column: GridColumn, value: unknown) {
  const editor = editorForColumn(column, makeHost)!;
  const outcome: { success: unknown[]; cancel: number; rendered: number } = {
    cancel: 0,
    rendered: 0,
    success: [],
  };
  const host = editor(
    cellWith(value),
    (fn) => {
      outcome.rendered += 1;
      fn();
    },
    (v) => outcome.success.push(v),
    () => (outcome.cancel += 1),
  );
  document.body.append(host);
  return { host, outcome };
}

function keydown(el: Element, key: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
}

describe("editorForColumn", () => {
  test("readonly and non-editable columns get no editor", () => {
    expect(editorForColumn(col("readonly"), makeHost)).toBeUndefined();
    expect(
      editorForColumn({ editable: false, field: "f", kind: "string", title: "F" }, makeHost),
    ).toBeUndefined();
  });

  test("text editor commits coerced values on Enter and only once", async () => {
    const { host, outcome } = openEditor(col("number"), 10);
    await flush();
    const input = host.querySelector("input")!;
    expect(input.value).toBe("10");
    expect(outcome.rendered).toBe(1);

    input.value = "$1,234";
    keydown(input, "Enter");
    input.dispatchEvent(new Event("blur")); // Late blur must not double-commit.
    expect(outcome.success).toEqual([1234]);
    expect(outcome.cancel).toBe(0);
  });

  test("text editor cancels on Escape and commits on blur", async () => {
    const escape = openEditor(col("string"), "hello");
    await flush();
    keydown(escape.host.querySelector("input")!, "Escape");
    expect(escape.outcome.cancel).toBe(1);
    expect(escape.outcome.success).toEqual([]);

    const blur = openEditor(col("string"), "hello");
    await flush();
    const input = blur.host.querySelector("input")!;
    input.value = "world";
    input.dispatchEvent(new Event("blur"));
    expect(blur.outcome.success).toEqual(["world"]);
  });

  test("array editor round-trips comma text to string[]", async () => {
    const { host, outcome } = openEditor(col("array"), ["a", "b"]);
    await flush();
    const input = host.querySelector("input")!;
    expect(input.value).toBe("a, b");
    input.value = "x, y , z";
    keydown(input, "Enter");
    expect(outcome.success).toEqual([["x", "y", "z"]]);
  });

  test("date editor shows the date part and commits the string", async () => {
    const { host, outcome } = openEditor(col("date"), "2026-07-13T10:00:00Z");
    await flush();
    const input = host.querySelector("input")!;
    expect(input.type).toBe("date");
    expect(input.value).toBe("2026-07-13");
    input.value = "2026-08-01";
    keydown(input, "Enter");
    expect(outcome.success).toEqual(["2026-08-01"]);
  });

  test("checkbox editor commits on change and cancels on Escape", async () => {
    const change = openEditor(col("boolean"), false);
    await flush();
    const box = change.host.querySelector("input")!;
    expect(box.type).toBe("checkbox");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(change.outcome.success).toEqual([true]);

    const escape = openEditor(col("boolean"), true);
    await flush();
    keydown(escape.host.querySelector("input")!, "Escape");
    expect(escape.outcome.cancel).toBe(1);
  });

  test("select editor lists enum options plus a none item; blur cancels", async () => {
    const schema = { enum: ["draft", "published"], type: "string" };
    const change = openEditor(col("enum", schema), "draft");
    await flush();
    const select = change.host.querySelector("select")!;
    const options = [...select.querySelectorAll("option")].map((o) => o.value);
    expect(options).toEqual(["", "draft", "published"]);

    select.value = "published";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(change.outcome.success).toEqual(["published"]);

    const none = openEditor(col("enum", schema), "draft");
    await flush();
    const noneSelect = none.host.querySelector("select")!;
    noneSelect.value = "";
    noneSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(none.outcome.success).toEqual([null]);

    const blur = openEditor(col("enum", schema), "draft");
    await flush();
    blur.host.querySelector("select")!.dispatchEvent(new Event("blur"));
    expect(blur.outcome.cancel).toBe(1);
  });
});

describe("formatterForColumn", () => {
  test("renders plain text for scalars and kind classes on the host", () => {
    const format = formatterForColumn(col("string"), makeHost);
    const host = format(cellWith("hello")) as HTMLElement;
    expect(host.textContent).toContain("hello");
    expect(host.className).toContain("jx-grid-kind-string");
  });

  test("booleans render a check only when true", () => {
    const format = formatterForColumn(col("boolean"), makeHost);
    expect((format(cellWith(true)) as HTMLElement).textContent).toContain("✓");
    expect((format(cellWith(false)) as HTMLElement).textContent?.trim()).toBe("");
  });

  test("arrays render one chip per item", () => {
    const format = formatterForColumn(col("array"), makeHost);
    const host = format(cellWith(["red", "blue"])) as HTMLElement;
    const chips = host.querySelectorAll(".jx-grid-chip");
    expect(chips).toHaveLength(2);
    expect(chips[1]!.textContent).toContain("blue");
  });

  test("references render their target text", () => {
    const format = formatterForColumn(col("reference"), makeHost);
    const host = format(cellWith({ $ref: "#/content/posts/hi" })) as HTMLElement;
    expect(host.textContent).toContain("#/content/posts/hi");
  });
});
