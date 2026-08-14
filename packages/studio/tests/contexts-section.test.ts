/**
 * Tests for src/settings/contexts-section.ts — Project Settings › Contexts, the ONE definition site
 * for breakpoints, colour schemes and feature queries (plan §4.2, §2 principle 5).
 *
 * What these pin is mostly what is NOT here any more. `$media` used to be writable from four
 * surfaces — the New Project wizard, Settings › General, Properties › Media and the CSS-variables
 * "Enable dark scheme" button — and the third of those rendered only when the document ROOT was
 * selected, so adding a breakpoint cost you your element. This section is the whole story now, so
 * the tests cover the whole story: classification, naming, validation, and the two failure modes (a
 * schema refusal and a refused write) that the predecessors dropped on the floor.
 *
 * `jx-validate` is mocked. The real one compiles the project's generated entry document with ajv,
 * which is both slow and dependent on which extensions the fixture happens to enable — neither of
 * which is what this file is about. What it IS about is that a human editing project.json through a
 * form gets the same gate the AI's `write_project_config` has always had.
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { projectState } from "../src/store";

import type { MockPlatformState } from "./harness";
import type { StudioPlatform } from "../src/types";

/** What the mocked validator returns on the next call. */
let validatorResult: string[] | Error = [];

const validateProjectConfig = mock(async (_config: unknown): Promise<string[]> => {
  if (validatorResult instanceof Error) {
    // eslint-disable-next-line no-throw-literal -- validatorResult IS an Error on this branch
    throw validatorResult as Error;
  }
  return validatorResult;
});
void mock.module("../src/services/jx-validate.js", () => ({
  validateProjectConfig,
  validateDoc: async () => [],
  applyProjectSchemas: () => {},
  resetProjectSchemas: () => {},
}));

const { contextKeyOf, contextKindOf, renderContextsSection, splitContexts } =
  await import("../src/settings/contexts-section");

type AnyConfig = Record<string, any>;

function setup(
  media: Record<string, string> | undefined,
  overrides: Partial<StudioPlatform> = {},
): { container: HTMLElement; state: MockPlatformState } {
  const { state } = installMockPlatform(overrides);
  resetStudioState({
    projectConfig: { name: "Site", ...(media ? { $media: media } : {}) } as unknown,
  });
  const container = document.createElement("div");
  renderContextsSection(container);
  return { container, state };
}

function config(): AnyConfig {
  return (projectState as AnyConfig).projectConfig;
}

function group(container: HTMLElement, kind: string): HTMLElement {
  const el = container.querySelector(`[data-context-group="${kind}"]`);
  if (!el) {
    throw new Error(`no "${kind}" group in the Contexts section`);
  }
  return el as HTMLElement;
}

function rowKeys(container: HTMLElement, kind: string): string[] {
  return [...group(container, kind).querySelectorAll("[data-context]")].map(
    (el) => (el as HTMLElement).dataset.context ?? "",
  );
}

function addButton(container: HTMLElement, kind: string): HTMLElement {
  return group(container, kind).querySelector(`[data-add="${kind}"]`) as HTMLElement;
}

function setAndFire(el: Element, value: string): void {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function errorTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".settings-field-error")].map(
    (el) => el.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  validatorResult = [];
  validateProjectConfig.mockClear();
});

// ─── Classification ──────────────────────────────────────────────────────────
/* All three kinds are the same thing on disk — one `$media` entry — so which group a row belongs
   to has to be DERIVED, not stored. That is what keeps the on-disk format unchanged while the
   authoring surface moves. */

describe("classification", () => {
  test("width queries are sizes, scheme queries are schemes, the rest are features", () => {
    expect(contextKindOf("(max-width: 768px)")).toBe("size");
    expect(contextKindOf("(min-width: 1024px)")).toBe("size");
    expect(contextKindOf("(prefers-color-scheme: dark)")).toBe("scheme");
    expect(contextKindOf("(prefers-color-scheme: light)")).toBe("scheme");
    expect(contextKindOf("(prefers-reduced-motion: reduce)")).toBe("feature");
    expect(contextKindOf("print")).toBe("feature");
  });

  test("splitContexts lifts the base width out and classifies the rest", () => {
    const { base, entries } = splitContexts({
      "--": "1280px",
      "--dark": "(prefers-color-scheme: dark)",
      "--print": "print",
      "--sm": "(max-width: 600px)",
    });
    expect(base).toBe("1280px");
    expect(entries.map((e) => [e.key, e.kind])).toEqual([
      ["--dark", "scheme"],
      ["--print", "feature"],
      ["--sm", "size"],
    ]);
  });

  test("an absent or empty $media splits into nothing", () => {
    expect(splitContexts()).toEqual({ base: "", entries: [] });
    expect(splitContexts({})).toEqual({ base: "", entries: [] });
  });
});

describe("naming", () => {
  test("a friendly name becomes a -- key without the user typing dashes", () => {
    expect(contextKeyOf("Tablet")).toBe("--tablet");
    expect(contextKeyOf("Wide screen")).toBe("--wide-screen");
    expect(contextKeyOf("  Extra  Large  ")).toBe("--extra-large");
  });

  test("dashes the user does type are not doubled", () => {
    expect(contextKeyOf("--tablet")).toBe("--tablet");
  });

  test("a name with nothing nameable in it is refused, not turned into --", () => {
    expect(contextKeyOf("")).toBe("");
    expect(contextKeyOf("---")).toBe("");
    expect(contextKeyOf("!!!")).toBe("");
  });
});

// ─── Rendering ───────────────────────────────────────────────────────────────

describe("rendering", () => {
  test("the three groups always render, each with an empty state and an add button", () => {
    const { container } = setup(undefined);
    for (const kind of ["size", "scheme", "feature"]) {
      expect(rowKeys(container, kind)).toEqual([]);
      expect(addButton(container, kind)).not.toBeNull();
    }
    expect(container.textContent).toContain("No breakpoints yet");
    expect(container.textContent).toContain("No colour schemes yet");
  });

  test("entries land in their own group and nowhere else", () => {
    const { container } = setup({
      "--": "1280px",
      "--dark": "(prefers-color-scheme: dark)",
      "--print": "print",
      "--sm": "(max-width: 600px)",
    });
    expect(rowKeys(container, "size")).toEqual(["--sm"]);
    expect(rowKeys(container, "scheme")).toEqual(["--dark"]);
    expect(rowKeys(container, "feature")).toEqual(["--print"]);
  });

  test("the base width renders its own row, outside every group", () => {
    const { container } = setup({ "--": "1280px" });
    const base = container.querySelector('[data-context="base"]') as HTMLInputElement;
    expect(base.value).toBe("1280px");
    expect(base.closest("[data-context-group]")).toBeNull();
  });

  test("a scheme row is a picker, so a scheme can never be mistyped into a feature", () => {
    const { container } = setup({ "--dark": "(prefers-color-scheme: dark)" });
    const picker = group(container, "scheme").querySelector("sp-picker");
    expect(picker).not.toBeNull();
    expect((picker as unknown as { value: string }).value).toBe("dark");
  });
});

// ─── Editing ─────────────────────────────────────────────────────────────────

describe("editing", () => {
  test("adding a breakpoint writes one entry with a real query", async () => {
    const { container } = setup({ "--": "1280px" });
    pointer(addButton(container, "size"), "click");
    await flush(4);
    expect(config().$media).toEqual({ "--": "1280px", "--breakpoint": "(max-width: 768px)" });
  });

  test("adding twice does not collide — the second takes the next free name", async () => {
    const { container } = setup({});
    pointer(addButton(container, "size"), "click");
    await flush(4);
    pointer(addButton(container, "size"), "click");
    await flush(4);
    expect(Object.keys(config().$media)).toEqual(["--breakpoint", "--breakpoint-2"]);
  });

  test("adding a colour scheme writes the canonical prefers-color-scheme query", async () => {
    const { container } = setup({});
    pointer(addButton(container, "scheme"), "click");
    await flush(4);
    expect(config().$media["--dark"]).toBe("(prefers-color-scheme: dark)");
  });

  test("changing a query persists it", async () => {
    const { container } = setup({ "--sm": "(max-width: 600px)" });
    const value = group(container, "size").querySelector(".settings-media-value")!;
    setAndFire(value, "(max-width: 720px)");
    await flush(4);
    expect(config().$media["--sm"]).toBe("(max-width: 720px)");
  });

  test("renaming preserves order — a rename is not a reordering", async () => {
    const { container } = setup({
      "--": "1280px",
      "--sm": "(max-width: 600px)",
      "--md": "(max-width: 900px)",
    });
    const name = group(container, "size").querySelector(".settings-media-name")!;
    setAndFire(name, "Phone");
    await flush(4);
    expect(Object.keys(config().$media)).toEqual(["--", "--phone", "--md"]);
    expect(config().$media["--phone"]).toBe("(max-width: 600px)");
  });

  test("switching a scheme row's picker rewrites the query, not the name", async () => {
    const { container } = setup({ "--scheme": "(prefers-color-scheme: dark)" });
    const picker = group(container, "scheme").querySelector("sp-picker")!;
    (picker as unknown as { value: string }).value = "light";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(4);
    expect(config().$media).toEqual({ "--scheme": "(prefers-color-scheme: light)" });
  });

  test("remove deletes exactly one entry", async () => {
    const { container } = setup({ "--sm": "(max-width: 600px)", "--md": "(max-width: 900px)" });
    const remove = group(container, "size").querySelector('[data-remove="--sm"]') as HTMLElement;
    pointer(remove, "click");
    await flush(4);
    expect(config().$media).toEqual({ "--md": "(max-width: 900px)" });
  });

  test("the base width accepts pixels and clearing it drops the key", async () => {
    const { container } = setup({ "--": "1280px", "--sm": "(max-width: 600px)" });
    setAndFire(container.querySelector('[data-context="base"]')!, "1440px");
    await flush(4);
    expect(config().$media["--"]).toBe("1440px");

    setAndFire(container.querySelector('[data-context="base"]')!, "");
    await flush(4);
    expect(config().$media).toEqual({ "--sm": "(max-width: 600px)" });
  });
});

// ─── Refusals (§7.1 inline tier) ─────────────────────────────────────────────
/* Every one of these used to be a silent snap-back: the predecessors did `void
   updateSiteConfig(...)` and dropped the rejection, so a refused value looked like the field
   forgetting what you typed. */

describe("refusals", () => {
  test("a base width that is not pixels is refused at its own control", async () => {
    const { container } = setup({ "--": "1280px" });
    setAndFire(container.querySelector('[data-context="base"]')!, "wide");
    await flush(4);
    expect(errorTexts(container)).toContain("Enter a width in pixels, like 1280px.");
    expect(config().$media["--"]).toBe("1280px");
  });

  test("an empty name is refused and the entry survives", async () => {
    const { container } = setup({ "--sm": "(max-width: 600px)" });
    setAndFire(group(container, "size").querySelector(".settings-media-name")!, "   ");
    await flush(4);
    expect(errorTexts(container)).toContain("A context needs a name.");
    expect(config().$media).toEqual({ "--sm": "(max-width: 600px)" });
  });

  test("renaming onto an existing name is refused instead of eating the other entry", async () => {
    const { container } = setup({ "--sm": "(max-width: 600px)", "--md": "(max-width: 900px)" });
    const names = group(container, "size").querySelectorAll(".settings-media-name");
    setAndFire(names[0]!, "md");
    await flush(4);
    expect(errorTexts(container).join(" ")).toContain("already defined");
    expect(config().$media).toEqual({
      "--md": "(max-width: 900px)",
      "--sm": "(max-width: 600px)",
    });
  });

  test("renaming to the same name is a no-op, not an error", async () => {
    const { container } = setup({ "--sm": "(max-width: 600px)" });
    setAndFire(group(container, "size").querySelector(".settings-media-name")!, "sm");
    await flush(4);
    expect(errorTexts(container)).toEqual([]);
    expect(config().$media).toEqual({ "--sm": "(max-width: 600px)" });
  });

  test("an empty query is refused", async () => {
    const { container } = setup({ "--sm": "(max-width: 600px)" });
    setAndFire(group(container, "size").querySelector(".settings-media-value")!, "  ");
    await flush(4);
    expect(errorTexts(container).join(" ")).toContain("needs a media query");
    expect(config().$media["--sm"]).toBe("(max-width: 600px)");
  });
});

// ─── Validation and write failures ───────────────────────────────────────────

describe("validation", () => {
  test("a schema refusal blocks the write and is shown at the row that caused it", async () => {
    validatorResult = ["/$media/--sm: must match pattern"];
    const { container, state } = setup({ "--sm": "(max-width: 600px)" });
    setAndFire(group(container, "size").querySelector(".settings-media-value")!, "nonsense");
    await flush(6);
    expect(errorTexts(container)).toContain("/$media/--sm: must match pattern");
    expect(config().$media["--sm"]).toBe("(max-width: 600px)");
    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
  });

  test("a validator that will not compile reports itself and blocks nothing else", async () => {
    validatorResult = new Error("ajv exploded");
    const { container } = setup({ "--sm": "(max-width: 600px)" });
    setAndFire(
      group(container, "size").querySelector(".settings-media-value")!,
      "(min-width: 1px)",
    );
    await flush(6);
    expect(errorTexts(container).join(" ")).toContain("Could not validate project.json");
  });

  test("a rejected write is shown, not swallowed", async () => {
    const { container } = setup({ "--sm": "(max-width: 600px)" }, {
      writeFile: async () => {
        throw new Error("EROFS: read-only file system");
      },
    } as unknown as Partial<StudioPlatform>);
    setAndFire(
      group(container, "size").querySelector(".settings-media-value")!,
      "(min-width: 1px)",
    );
    await flush(6);
    expect(errorTexts(container).join(" ")).toContain(
      "Could not save project.json — EROFS: read-only file system",
    );
  });

  test("a later success clears the error", async () => {
    const { container } = setup({ "--sm": "(max-width: 600px)" }, {
      writeFile: async () => {
        throw new Error("EROFS");
      },
    } as unknown as Partial<StudioPlatform>);
    setAndFire(
      group(container, "size").querySelector(".settings-media-value")!,
      "(min-width: 1px)",
    );
    await flush(6);
    expect(errorTexts(container)).not.toEqual([]);

    installMockPlatform();
    setAndFire(
      group(container, "size").querySelector(".settings-media-value")!,
      "(min-width: 2px)",
    );
    await flush(6);
    expect(errorTexts(container)).toEqual([]);
    expect(config().$media["--sm"]).toBe("(min-width: 2px)");
  });
});
