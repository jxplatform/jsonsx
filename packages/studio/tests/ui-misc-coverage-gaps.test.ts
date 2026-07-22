/**
 * Coverage-gap tests for scattered UI/support modules:
 *
 * - Form-controls: schema-builder handler guards when the underlying value changed between the render
 *   and the interaction (stale field cards).
 * - Value-selector: the textfield click-containment arrow.
 * - Jxsuite-update: the non-semver dev-build bailout and the missing-capability bailout.
 * - Page-params: the dev-proxy fetch fallback for ContentCollection resolution, extensions without
 *   the class, and the state-less resolveParamBoundState guard.
 */
import { installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import { getFormControl } from "../src/ui/schema-form";
import { resetFormControlUiState } from "../src/ui/form-controls";
import { JxValueSelector } from "../src/ui/value-selector";
import { applyJxsuiteUpdate, checkJxsuiteUpdate } from "../src/packages/jxsuite-update";
import { invalidateParamValues, loadParamValues, resolveParamBoundState } from "../src/page-params";
import { refreshFormats, setExtensions } from "../src/format/format-host";
import type { SchemaFormContext } from "../src/ui/schema-form";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Schema-builder stale-card guards ────────────────────────────────────────

describe("schema-builder stale-card guards", () => {
  type ValueEl = HTMLElement & { value: string };

  const contentTypesCtx: SchemaFormContext = {
    resolvePointer: (ptr) => (ptr === "#/$context/content" ? { page: {}, post: {} } : undefined),
  };

  function commitValue(el: Element, value: string): void {
    (el as ValueEl).value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  interface BuilderSchemaValue {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    type: string;
  }

  function mountStale(): { container: HTMLElement; patches: unknown[] } {
    resetFormControlUiState();
    const control = getFormControl("schema-builder")!;
    const value: BuilderSchemaValue = {
      properties: {
        ghost: { type: "string" },
        meta: {
          properties: { child: { type: "string" } },
          required: ["child"],
          type: "object",
        },
        target: { $ref: "#/content/page" },
      },
      required: [],
      type: "object",
    };
    const patches: unknown[] = [];
    const container = document.createElement("div");
    render(
      html`${control({
        ctx: contentTypesCtx,
        key: "schema",
        onChange: (v: unknown) => patches.push(v),
        schema: { format: "json-schema", type: "object" },
        value,
      })}`,
      container,
    );
    // The value the handlers closed over changes underneath them (an external edit landing
    // Between render and interaction) — every handler must guard, not crash.
    delete value.properties.ghost;
    delete value.properties.meta;
    delete value.properties.target;
    return { container, patches };
  }

  function card(container: HTMLElement, fieldName: string): HTMLElement {
    const input = container.querySelector(`.schema-field-name-input[value="${fieldName}"]`);
    return input?.closest(".schema-field-card") as HTMLElement;
  }

  function pickerIn(scope: HTMLElement, label: string): ValueEl {
    return scope.querySelector(`sp-picker[label="${label}"]`) as ValueEl;
  }

  const emptySchema = { properties: {}, required: [], type: "object" };

  test("type, format, and reference-target changes on vanished fields are no-ops", () => {
    const { container, patches } = mountStale();
    commitValue(pickerIn(card(container, "ghost"), "Type"), "number");
    commitValue(pickerIn(card(container, "ghost"), "Format"), "date");
    commitValue(pickerIn(card(container, "target"), "Target"), "post");
    expect(patches).toEqual([emptySchema, emptySchema, emptySchema]);
  });

  test("nested operations on a vanished parent are no-ops", () => {
    const { container, patches } = mountStale();
    const nested = card(container, "meta").querySelector(".schema-field-nested") as HTMLElement;
    const childCard = nested
      .querySelector('.schema-field-name-input[value="child"]')!
      .closest(".schema-field-card") as HTMLElement;

    commitValue(childCard.querySelector(".schema-field-name-input")!, "renamed");
    commitValue(pickerIn(childCard, "Type"), "number");
    commitValue(pickerIn(childCard, "Format"), "image");
    childCard.querySelector("sp-switch")!.dispatchEvent(new Event("change", { bubbles: true }));
    childCard
      .querySelector('[title="Delete field"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // Nested add on the vanished parent
    const addName = nested.querySelector(".schema-nested-add-name") as ValueEl;
    addName.value = "orphan";
    addName.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );

    expect(patches).toEqual([
      emptySchema,
      emptySchema,
      emptySchema,
      emptySchema,
      emptySchema,
      emptySchema,
    ]);
  });

  test("renames to a taken or unusable name are no-ops", () => {
    resetFormControlUiState();
    const control = getFormControl("schema-builder")!;
    const value = {
      properties: { first: { type: "string" }, second: { type: "string" } },
      required: ["first"],
      type: "object",
    };
    const patches: unknown[] = [];
    const container = document.createElement("div");
    render(
      html`${control({
        ctx: contentTypesCtx,
        key: "schema",
        onChange: (v: unknown) => patches.push(v),
        schema: { format: "json-schema", type: "object" },
        value,
      })}`,
      container,
    );
    commitValue(card(container, "first").querySelector(".schema-field-name-input")!, "second");
    commitValue(card(container, "second").querySelector(".schema-field-name-input")!, "$$$");
    for (const patch of patches) {
      expect(patch).toEqual(value);
    }
  });
});

// ─── Value selector ──────────────────────────────────────────────────────────

describe("value-selector textfield click containment", () => {
  if (!customElements.get("jx-value-selector")) {
    customElements.define("jx-value-selector", JxValueSelector);
  }

  test("clicks inside the textfield stop propagating (the overlay trigger must not fire)", async () => {
    const el = document.createElement("jx-value-selector") as JxValueSelector;
    el.options = [{ label: "Italic", value: "italic" }] as JxValueSelector["options"];
    document.body.append(el);
    await el.updateComplete;
    const tf = el.querySelector("sp-textfield")!;
    let escaped = 0;
    el.addEventListener("click", () => {
      escaped += 1;
    });
    tf.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(escaped).toBe(0);
    el.remove();
  });
});

// ─── Jxsuite update bailouts ─────────────────────────────────────────────────

describe("jxsuite-update bailouts", () => {
  test("dev builds (non-semver VERSION) never report updates", async () => {
    installMockPlatform({
      listPackages: async () => [{ name: "@jxsuite/runtime", version: "^0.1.0" }],
    });
    // The test build's VERSION is "dev" — not comparable, so the check bails immediately.
    expect(await checkJxsuiteUpdate()).toBeNull();
  });

  test("applyJxsuiteUpdate without setPackageVersions is a silent no-op", async () => {
    installMockPlatform();
    await applyJxsuiteUpdate(
      [{ current: "^0.1.0", dev: false, name: "@jxsuite/runtime" }],
      "0.30.0",
    );
    expect(document.querySelector(".progress-modal")).toBeNull();
  });
});

// ─── Page params ─────────────────────────────────────────────────────────────

describe("page-params gaps", () => {
  beforeEach(() => {
    invalidateParamValues();
    refreshFormats();
  });

  afterEach(() => {
    refreshFormats();
  });

  test("platforms without resolveClass fall back to the dev proxy", async () => {
    installMockPlatform();
    const calls: { body: string; url: string }[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body), url });
      return Promise.resolve(Response.json([{ id: "a1" }, { data: { sku: "S-2" }, id: "a2" }]));
    }) as unknown as typeof fetch;

    const values = await loadParamValues("proxy-ok", {
      contentType: "product",
      field: "sku",
      param: "sku",
    });
    expect(values).toEqual({ sku: ["a1", "S-2"] });
    expect(calls[0]!.url).toBe("/__jx_resolve__");
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body.$prototype).toBe("ContentCollection");
    expect(body.contentType).toBe("product");
  });

  test("a failing dev-proxy resolution degrades to no values", async () => {
    installMockPlatform();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch;
    expect(await loadParamValues("proxy-fail", { contentType: "product" })).toEqual({});
  });

  test("extensions without a ContentCollection class are skipped in $src resolution", async () => {
    const bodies: Record<string, unknown>[] = [];
    installMockPlatform({
      resolveClass: async (body: Record<string, unknown>) => {
        bodies.push(body);
        return [{ id: "x1" }];
      },
    } as never);
    setExtensions([
      {
        classes: [{ name: "Markdown", path: "/deps/markdown.class.json" }],
        contributions: [],
        name: "markdown",
        specifier: "@ext/markdown",
      },
      {
        classes: [{ name: "ContentCollection", path: "/deps/cc.class.json" }],
        contributions: [],
        name: "cc",
        specifier: "@ext/cc",
      },
    ]);
    const values = await loadParamValues("ext-mixed", { contentType: "product" });
    expect(values).toEqual({ slug: ["x1"] });
    expect(bodies[0]!.$src).toBe("/deps/cc.class.json");
  });

  test("resolveParamBoundState without doc state is a guarded no-op", async () => {
    let resolved = 0;
    installMockPlatform({
      resolveClass: async () => {
        resolved += 1;
        return {};
      },
    } as never);
    await resolveParamBoundState({ tagName: "div" } as never, ["product"]);
    expect(resolved).toBe(0);
  });
});
