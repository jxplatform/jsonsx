import { flush, installMockPlatform, renderInto, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PARITY_ROW_LIMIT,
  parityRows,
  refreshParityScan,
  registerI18nPanel,
  renderI18nPanel,
} from "../src/panels/i18n-panel";
import { getPanel, resetPanels } from "../src/panels/panel-registry";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext } from "../src/commands/context";
import { setActiveRegistry } from "../src/commands/active-registry";
import { problems, resetNotifications, toasts } from "../src/services/notify";
import { registerPlatform } from "../src/platform";
import { setProjectState } from "../src/store";
import type { AnyCommand } from "../src/commands/registry";
import type { CommandContext } from "../src/commands/context";
import type { LibraryFile } from "../src/browse/library-model";
import type { NavigatorPanelContext, NavigatorPanelDeps } from "../src/panels/panel-registry";
import type { ResolvedI18n } from "@jxsuite/schema/locale";
import type { StudioPlatform } from "../src/types";
import type { TemplateResult } from "lit-html";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EN_FR: ResolvedI18n = {
  defaultLocale: "en",
  locales: ["en", "fr"],
  routing: "prefix-except-default",
};

/** One scanned file, as `scanLibrary` would have produced it. */
function file(path: string, modified?: string, category = "Pages"): LibraryFile {
  return {
    category,
    ext: path.split(".").pop() ?? "",
    modified,
    name: path.split("/").pop() ?? path,
    path,
    type: "json",
  };
}

/** The cell at `key` × `locale`, or `undefined` when the row is absent. */
function cellAt(rows: ReturnType<typeof parityRows>, key: string, locale: string) {
  return rows.find((row) => row.key === key)?.cells.get(locale);
}

// ─── parityRows — the pure fold ───────────────────────────────────────────────

describe("parityRows", () => {
  test("a page written in every declared language is present in every column", () => {
    const rows = parityRows([file("pages/about.json"), file("pages/fr/about.json")], EN_FR);
    expect(rows).toHaveLength(1);
    expect(cellAt(rows, "pages/about.json", "en")).toEqual({
      path: "pages/about.json",
      state: "present",
    });
    expect(cellAt(rows, "pages/about.json", "fr")).toEqual({
      path: "pages/fr/about.json",
      state: "present",
    });
  });

  /*
   * The case the path cannot reach. Without the declared key these are two half-empty rows —
   * `pages/about.json` present in English, `pages/a-propos.json` present in French, and two
   * `missing` cells naming files nobody should write — which is the wrong answer on the one surface
   * whose whole job is to say which pages are translated.
   */
  test("a localized slug is one row, not two, when the document says which page it is", () => {
    const rows = parityRows(
      [file("pages/about.json"), file("pages/fr/a-propos.json")],
      EN_FR,
      new Map([["pages/fr/a-propos.json", "about"]]),
    );
    expect(rows).toHaveLength(1);
    expect(cellAt(rows, "pages/about.json", "fr")).toEqual({
      path: "pages/fr/a-propos.json",
      state: "present",
    });
  });

  // One route can be a page or a directory's index, so a declared key is tried as both against the
  // Files actually scanned — `expositions/index.json` declaring `exhibitions` is the same page as
  // `pages/exhibitions/index.json`, not a sibling of it.
  test("a declared key finds a directory index as readily as a page", () => {
    const rows = parityRows(
      [file("pages/exhibitions/index.json"), file("pages/fr/expositions/index.json")],
      EN_FR,
      new Map([["pages/fr/expositions/index.json", "exhibitions"]]),
    );
    expect(rows).toHaveLength(1);
    expect(cellAt(rows, "pages/exhibitions/index.json", "fr")).toEqual({
      path: "pages/fr/expositions/index.json",
      state: "present",
    });
  });

  test("a language with no file names the path the file WOULD go to", () => {
    // The whole point of the grid: absence is not renderable from the file tree, and a `missing`
    // Cell that could not say where the file belongs would be a report with no action behind it.
    const rows = parityRows([file("pages/index.json")], EN_FR);
    expect(cellAt(rows, "pages/index.json", "fr")).toEqual({
      path: "pages/fr/index.json",
      state: "missing",
    });
  });

  test("a translation older than its source is stale, and names what it is behind", () => {
    const rows = parityRows(
      [
        file("pages/about.json", "2026-02-01T00:00:00.000Z"),
        file("pages/fr/about.json", "2026-01-01T00:00:00.000Z"),
      ],
      EN_FR,
    );
    expect(cellAt(rows, "pages/about.json", "fr")).toEqual({
      behind: "pages/about.json",
      path: "pages/fr/about.json",
      state: "stale",
    });
    // The source is never stale against itself.
    expect(cellAt(rows, "pages/about.json", "en")).toMatchObject({ state: "present" });
  });

  test("a translation NEWER than its source is present, not stale", () => {
    const rows = parityRows(
      [
        file("pages/about.json", "2026-01-01T00:00:00.000Z"),
        file("pages/fr/about.json", "2026-02-01T00:00:00.000Z"),
      ],
      EN_FR,
    );
    expect(cellAt(rows, "pages/about.json", "fr")).toMatchObject({ state: "present" });
  });

  test("a file the platform gave no timestamp for is present, never stale", () => {
    // An absent timestamp is not evidence of being behind. Both directions, because the missing
    // Value can be on either side of the comparison.
    const noTranslationTime = parityRows(
      [file("pages/about.json", "2026-02-01T00:00:00.000Z"), file("pages/fr/about.json")],
      EN_FR,
    );
    expect(cellAt(noTranslationTime, "pages/about.json", "fr")).toMatchObject({ state: "present" });

    const noSourceTime = parityRows(
      [file("pages/about.json"), file("pages/fr/about.json", "2026-01-01T00:00:00.000Z")],
      EN_FR,
    );
    expect(cellAt(noSourceTime, "pages/about.json", "fr")).toMatchObject({ state: "present" });
  });

  test("an unparseable timestamp is refused rather than read as the epoch", () => {
    const rows = parityRows(
      [file("pages/about.json", "not a date"), file("pages/fr/about.json", "2026-01-01")],
      EN_FR,
    );
    expect(cellAt(rows, "pages/about.json", "fr")).toMatchObject({ state: "present" });
  });

  test("a file under no locale segment lands under the DEFAULT locale", () => {
    const rows = parityRows([file("pages/about.json")], EN_FR);
    expect(cellAt(rows, "pages/about.json", "en")).toMatchObject({ state: "present" });
    expect(cellAt(rows, "pages/about.json", "fr")).toMatchObject({ state: "missing" });
  });

  test("a key present only in a NON-default locale still gets a row", () => {
    const rows = parityRows([file("pages/fr/contact.json")], EN_FR);
    expect(rows.map((row) => row.key)).toEqual(["pages/contact.json"]);
    expect(cellAt(rows, "pages/contact.json", "en")).toEqual({
      path: "pages/contact.json",
      state: "missing",
    });
    expect(cellAt(rows, "pages/contact.json", "fr")).toMatchObject({ state: "present" });
  });

  test("an asset is not a row — `categoryFor` has already decided what is media", () => {
    const rows = parityRows(
      [file("pages/hero.png", undefined, "Media"), file("pages/index.json")],
      EN_FR,
    );
    expect(rows.map((row) => row.key)).toEqual(["pages/index.json"]);
  });

  test("a file under no collection has nowhere to put a locale, and the cell says null", () => {
    // `content/hello.md` is not inside a collection, so there is no `content/<type>/<locale>/`
    // Position for its translation. A path invented here would create a file nothing serves.
    const rows = parityRows([file("content/hello.md")], EN_FR);
    expect(cellAt(rows, "content/hello.md", "fr")).toEqual({ path: null, state: "missing" });
  });

  test("a content entry inside a collection gets the collection's locale position", () => {
    const rows = parityRows([file("content/blog/en/hello.md", undefined, "Content")], EN_FR);
    expect(cellAt(rows, "content/blog/hello.md", "en")).toMatchObject({ state: "present" });
    expect(cellAt(rows, "content/blog/hello.md", "fr")).toEqual({
      path: "content/blog/fr/hello.md",
      state: "missing",
    });
  });

  test("when two files claim one square, the one at the canonical path wins", () => {
    // `pages/about.json` and `pages/en/about.json` are both the English copy under
    // `prefix-except-default`, and the grid must agree with where a Create would have written.
    const rows = parityRows([file("pages/en/about.json"), file("pages/about.json")], EN_FR);
    expect(cellAt(rows, "pages/about.json", "en")).toMatchObject({ path: "pages/about.json" });
  });

  test("under prefix-always the default locale is prefixed like every other", () => {
    const always: ResolvedI18n = { ...EN_FR, routing: "prefix-always" };
    const rows = parityRows([file("pages/fr/about.json")], always);
    expect(cellAt(rows, "pages/about.json", "en")).toEqual({
      path: "pages/en/about.json",
      state: "missing",
    });
  });

  test("rows come back in key order, whatever order the scan arrived in", () => {
    const rows = parityRows(
      [file("pages/zeta.json"), file("pages/alpha.json"), file("pages/mid.json")],
      EN_FR,
    );
    expect(rows.map((row) => row.key)).toEqual([
      "pages/alpha.json",
      "pages/mid.json",
      "pages/zeta.json",
    ]);
  });
});

// ─── The mounted panel ────────────────────────────────────────────────────────

/** Every command run through the registry this window publishes, in order. */
const ran: { id: string; args: unknown }[] = [];

/** A record as bare as the registry allows — the panel must not care what it does. */
function stub(id: string, over: Partial<AnyCommand> = {}): AnyCommand {
  return {
    category: "Project",
    id,
    level: "document",
    run: (_ctx, args) => {
      ran.push({ args, id });
    },
    title: id,
    ...over,
  } as AnyCommand;
}

let context: CommandContext = emptyContext();

function publish(commands: AnyCommand[]): void {
  const registry = createCommandRegistry({ getContext: () => context });
  registry.registerAll(commands);
  setActiveRegistry(registry);
}

/** The panel context a `level: "project"` panel gets: no document, and deps that refuse to be read. */
function panelCtx(): NavigatorPanelContext {
  return {
    deps: new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`the Languages panel read deps.${String(prop)}`);
        },
      },
    ) as NavigatorPanelDeps,
    doc: null,
    rerender: () => {},
  };
}

/** Draw the body once. The first call kicks the scan off; the second draws what it found. */
async function paint(): Promise<HTMLElement> {
  const body = renderI18nPanel(panelCtx());
  const host = await renderInto(body as TemplateResult);
  await flush();
  return host;
}

/** Draw, let the scan settle, draw again — the two paints the panel really performs. */
async function paintSettled(): Promise<HTMLElement> {
  await paint();
  return paint();
}

const SEED: Record<string, string> = {
  "content/blog/en/hello.md": "# hello",
  "pages/about.json": "{}",
  "pages/fr/about.json": "{}",
  "pages/index.json": "{}",
};

function openBilingualProject(): void {
  resetStudioState({
    projectConfig: {
      i18n: { defaultLocale: "en", locales: ["en", "fr"] },
      name: "Demo",
    },
    projectRoot: "/demo",
  });
}

beforeEach(() => {
  ran.length = 0;
  context = emptyContext();
  refreshParityScan();
  resetNotifications();
  resetPanels();
  installMockPlatform({}, SEED);
  publish([stub("i18n.openTranslation"), stub("i18n.createTranslation")]);
  openBilingualProject();
});

afterEach(() => {
  setActiveRegistry(null);
  setProjectState(null as never);
  resetPanels();
  refreshParityScan();
});

describe("the empty states", () => {
  test("a project that declares no locales is told what Languages is for", async () => {
    resetStudioState({ projectConfig: { name: "Demo" }, projectRoot: "/demo" });
    const host = await paint();
    expect(host.textContent).toContain("written in one language");
    expect(host.querySelector(".i18n-parity")).toBeNull();
  });

  test("one declared locale is still one language", async () => {
    resetStudioState({
      projectConfig: { i18n: { locales: ["en"] }, name: "Demo" },
      projectRoot: "/demo",
    });
    const host = await paint();
    expect(host.textContent).toContain("written in one language");
  });

  test("its action opens Settings through the registry, and is dead when nothing declares it", async () => {
    resetStudioState({ projectConfig: { name: "Demo" }, projectRoot: "/demo" });
    const cold = await paint();
    expect(cold.querySelector(".empty-state-action")?.hasAttribute("disabled")).toBe(true);

    publish([stub("settings.open", { level: "project" })]);
    const live = await paint();
    const action = live.querySelector(".empty-state-action") as HTMLElement;
    expect(action.hasAttribute("disabled")).toBe(false);
    action.click();
    await flush();
    expect(ran).toEqual([{ args: {}, id: "settings.open" }]);
  });

  test("a bilingual project with nothing in it says so rather than drawing an empty table", async () => {
    installMockPlatform({}, {});
    const host = await paintSettled();
    expect(host.textContent).toContain("nothing to translate yet");
    expect(host.querySelector(".i18n-parity")).toBeNull();
  });
});

describe("the grid", () => {
  test("draws one column per declared locale and one row per key", async () => {
    const host = await paintSettled();
    const heads = [...host.querySelectorAll(".i18n-locale-head")].map((el) =>
      el.getAttribute("title"),
    );
    expect(heads).toEqual(["en", "fr"]);
    const keys = [...host.querySelectorAll(".i18n-key")].map((el) => el.textContent?.trim());
    expect(keys).toEqual(["content/blog/hello.md", "pages/about.json", "pages/index.json"]);
  });

  test("names the source column, so `stale` has a referent on screen", async () => {
    const host = await paintSettled();
    expect(host.querySelector(".i18n-default-mark")?.textContent).toBe("source");
  });

  test("its summary counts what is outstanding rather than only what exists", async () => {
    const host = await paintSettled();
    expect(host.querySelector(".i18n-summary")?.textContent).toContain("3 pages");
    expect(host.querySelector(".i18n-summary")?.textContent).toContain("not written");
  });

  test("a fully translated project's summary says so", async () => {
    installMockPlatform({}, { "pages/about.json": "{}", "pages/fr/about.json": "{}" });
    const host = await paintSettled();
    expect(host.querySelector(".i18n-summary")?.textContent).toContain(
      "translated into every declared language",
    );
  });
});

describe("a cell is a command, run by id", () => {
  /** The button in the row whose key is `key`, under the `index`-th locale column. */
  function cell(host: HTMLElement, key: string, index: number): HTMLButtonElement {
    const row = [...host.querySelectorAll(".i18n-row")].find(
      (candidate) => candidate.querySelector(".i18n-key")?.textContent?.trim() === key,
    );
    return [...(row?.querySelectorAll(".i18n-cell-button") ?? [])][index] as HTMLButtonElement;
  }

  test("an existing translation opens, addressed by the row's own file", async () => {
    const host = await paintSettled();
    cell(host, "pages/about.json", 1).click();
    await flush();
    expect(ran).toEqual([
      { args: { locale: "fr", path: "pages/about.json" }, id: "i18n.openTranslation" },
    ]);
  });

  test("a missing translation creates, at the path the cell named", async () => {
    const host = await paintSettled();
    const button = cell(host, "pages/index.json", 1);
    expect(button.getAttribute("title")).toBe("Create pages/fr/index.json");
    button.click();
    await flush();
    expect(ran).toEqual([
      { args: { locale: "fr", path: "pages/index.json" }, id: "i18n.createTranslation" },
    ]);
  });

  test("a row with no file at all is still addressed by its key", async () => {
    // Nothing on disk answers for `pages/only.json` in either language, so the key is the only
    // Address there is — and it is the one `translationPathFor` takes a locale out of anyway.
    installMockPlatform({}, {});
    refreshParityScan();
    const rows = parityRows([], EN_FR);
    expect(rows).toEqual([]);
    const host = await paintSettled();
    expect(host.querySelector(".i18n-parity")).toBeNull();
  });

  test("a row the default locale has no file for is addressed by whichever file it does have", async () => {
    // The source column is empty here, so the row's address comes from the French copy — any
    // Sibling answers, because `translationPathFor` takes the locale out before it puts one back.
    installMockPlatform({}, { "pages/fr/contact.json": "{}" });
    const host = await paintSettled();
    cell(host, "pages/contact.json", 0).click();
    await flush();
    expect(ran).toEqual([
      { args: { locale: "en", path: "pages/fr/contact.json" }, id: "i18n.createTranslation" },
    ]);
  });

  test("a cell whose command this window has not registered is disabled, and says why", async () => {
    publish([]);
    const host = await paintSettled();
    const button = cell(host, "pages/about.json", 1);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toContain("has not registered");
    button.click();
    await flush();
    expect(ran).toEqual([]);
  });

  test("a cell whose command refuses carries the refusal as its tooltip", async () => {
    publish([
      stub("i18n.openTranslation", {
        requires: "an open document",
        when: () => false,
      }),
      stub("i18n.createTranslation"),
    ]);
    const host = await paintSettled();
    const button = cell(host, "pages/about.json", 1);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toContain("requires an open document");
  });

  test("a command that rejects is reported, not dropped", async () => {
    publish([
      stub("i18n.createTranslation", {
        run: () => Promise.reject(new Error("pages/fr/index.json already exists")),
      }),
      stub("i18n.openTranslation"),
    ]);
    const host = await paintSettled();
    cell(host, "pages/index.json", 1).click();
    await flush();
    expect([...problems, ...toasts].map((record) => record.message)).toContain(
      "pages/fr/index.json already exists",
    );
  });

  test("a key that cannot hold a locale directory refuses, naming what it needs", async () => {
    installMockPlatform({}, { "content/hello.md": "# hello" });
    const host = await paintSettled();
    const button = cell(host, "content/hello.md", 1);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toContain("No place for a");
  });

  test("a stale cell says what it is behind", async () => {
    installMockPlatform(
      {
        listDirectory: async (dir: string) =>
          dir === "pages"
            ? [
                {
                  modified: "2026-02-01T00:00:00.000Z",
                  name: "a.json",
                  path: "pages/a.json",
                  type: "file",
                },
                { name: "fr", path: "pages/fr", type: "directory" },
              ]
            : dir === "pages/fr"
              ? [
                  {
                    modified: "2026-01-01T00:00:00.000Z",
                    name: "a.json",
                    path: "pages/fr/a.json",
                    type: "file",
                  },
                ]
              : [],
      } as unknown as Partial<StudioPlatform>,
      {},
    );
    const host = await paintSettled();
    const button = host.querySelector(".i18n-cell-button--stale") as HTMLButtonElement;
    expect(button.getAttribute("title")).toBe("Open pages/fr/a.json — older than pages/a.json");
  });
});

describe("the scan", () => {
  test("says it is reading before it has read, rather than drawing an empty grid", async () => {
    const cold = await paint();
    expect(cold.textContent).toContain("Looking for translations");
  });

  test("Rescan re-reads the project", async () => {
    const host = await paintSettled();
    expect(host.querySelectorAll(".i18n-row")).toHaveLength(3);
    installMockPlatform({}, { "pages/index.json": "{}" });
    (host.querySelector(".i18n-rescan") as HTMLButtonElement).click();
    const after = await paintSettled();
    expect(after.querySelectorAll(".i18n-row")).toHaveLength(1);
  });

  test("a project switch re-reads rather than drawing the previous project's files", async () => {
    await paintSettled();
    installMockPlatform({}, { "pages/only.json": "{}" });
    resetStudioState({
      projectConfig: { i18n: { defaultLocale: "en", locales: ["en", "fr"] }, name: "Other" },
      projectRoot: "/other",
    });
    const host = await paintSettled();
    const keys = [...host.querySelectorAll(".i18n-key")].map((el) => el.textContent?.trim());
    expect(keys).toEqual(["pages/only.json"]);
  });

  test("a directory it could not read makes the grid a partial answer, and says so", async () => {
    installMockPlatform({
      listDirectory: async (dir: string) => {
        if (dir === "content") {
          throw new Error("EACCES");
        }
        return dir === "pages"
          ? [{ name: "index.json", path: "pages/index.json", type: "file" }]
          : [];
      },
    } as unknown as Partial<StudioPlatform>);
    const host = await paintSettled();
    expect(host.querySelector(".i18n-incomplete")?.textContent).toContain("content (EACCES)");
  });

  test("a window with no platform records the failure instead of throwing at render", async () => {
    registerPlatform(undefined as never);
    const host = await paintSettled();
    expect(host.querySelector(".i18n-incomplete")?.textContent).toContain("No platform registered");
    installMockPlatform({}, SEED);
  });

  test("it caps the grid and states the remainder rather than dropping it", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < PARITY_ROW_LIMIT + 3; i += 1) {
      many[`pages/p${String(i).padStart(4, "0")}.json`] = "{}";
    }
    installMockPlatform({}, many);
    const host = await paintSettled();
    expect(host.querySelectorAll(".i18n-row")).toHaveLength(PARITY_ROW_LIMIT);
    expect(host.querySelector(".i18n-truncated")?.textContent).toContain("3 more pages are not");
  });

  test("a remainder of one is said in the singular", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < PARITY_ROW_LIMIT + 1; i += 1) {
      many[`pages/p${String(i).padStart(4, "0")}.json`] = "{}";
    }
    installMockPlatform({}, many);
    const host = await paintSettled();
    expect(host.querySelector(".i18n-truncated")?.textContent).toContain("1 more page is not");
  });
});

describe("the record", () => {
  test("is off the rail, project-level, and gated on the project being multilingual", () => {
    registerI18nPanel();
    const panel = getPanel("i18n");
    expect(panel?.title).toBe("Languages");
    expect(panel?.level).toBe("project");
    expect(panel?.dock).toBe("navigator");
    // `rail: false` is what keeps the rail at four per group and leaves ⌘1-8 where they were.
    expect(panel?.rail).toBe(false);
    expect(panel?.when?.(emptyContext())).toBe(false);
    const multilingual = emptyContext();
    multilingual.project.isMultilingual = true;
    expect(panel?.when?.(multilingual)).toBe(true);
  });

  test("its render draws the panel body, and reads no document", async () => {
    registerI18nPanel();
    const panel = getPanel("i18n");
    const body = panel?.render(panelCtx()) as TemplateResult;
    const host = await renderInto(body);
    expect(host.textContent).toContain("Looking for translations");
  });
});
