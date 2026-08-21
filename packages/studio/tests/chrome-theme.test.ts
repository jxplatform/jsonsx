/**
 * The chrome theme, end to end — Preferences → Appearance → Light used to be a setting that did
 * nothing, and this file is the three-part reason it could.
 *
 * 1. `<sp-theme>` adopts the colour fragment REGISTERED UNDER the `color` it is given, and adopts none
 *    at all for a name it does not know. Only "dark" was registered, so `color="light"` was a valid
 *    attribute over an empty palette: every `--spectrum-*` colour token went undefined, the studio
 *    semantic layer fell through to its dark hex fallbacks, and the chrome did not move. So the
 *    first test counts the ADOPTED FRAGMENTS per declared theme — the observable that was wrong —
 *    and pins an unregistered Spectrum colour as the negative control, because an assertion about a
 *    registry that cannot fail is not a test.
 * 2. The Jx brand fragment re-values the palette and is adopted for EVERY colour, so a stop it
 *    overrides in one ramp and forgets in the other silently paints the wrong theme's brand value.
 *    The second test holds the two ramps to the same stop set.
 * 3. Monaco paints from its own registry and cannot read a CSS custom property, so it is the one
 *    surface the Spectrum theme does not reach: both editors were created with a literal "vs-dark".
 *    The rest of the file covers the projection that now carries the record to it.
 */
import "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

/** What `applyChromeTheme` asked Monaco to paint, in call order. */
const setThemeCalls: string[] = [];
let editorLoaded = true;

const fakeMonaco = {
  editor: {
    setTheme: (id: string) => {
      setThemeCalls.push(id);
    },
  },
};

void mock.module("../src/services/monaco-lazy", () => ({
  isMonacoLoaded: () => editorLoaded,
  loadedMonaco: () => (editorLoaded ? fakeMonaco : null),
  loadMonaco: async () => fakeMonaco,
  mountStillWanted: () => false,
  resetMonacoLazy: () => {},
  setProjectSchemasForMonaco: () => {},
}));

// Registers the component manifest AND the theme fragments — the subject of the first test.
await import("../src/ui/spectrum");
const { applyChromeTheme, CHROME_THEMES, monacoTheme, setChromeTheme, shell } =
  await import("../src/shell");
const { jxTheme } = await import("../src/ui/jx-theme");

/**
 * The fragments `<sp-theme color=…>` would adopt.
 *
 * Read through the element's own public `styles` getter rather than Spectrum's private registry,
 * because adopting is what the app depends on and a fragment registered under a name nothing asks
 * for is not registered at all as far as the chrome is concerned.
 */
function adoptedFragmentCount(color: string): number {
  const theme = document.createElement("sp-theme") as HTMLElement & { styles: unknown[] };
  theme.setAttribute("system", "spectrum");
  theme.setAttribute("scale", "medium");
  theme.setAttribute("color", color);
  return theme.styles.length;
}

beforeEach(() => {
  setThemeCalls.length = 0;
  editorLoaded = true;
  shell.theme = "dark";
  delete document.documentElement.dataset.theme;
});

describe("every declared chrome theme has a Spectrum colour fragment", () => {
  test("each of CHROME_THEMES adopts the same four fragments", () => {
    // System + colour + scale + the Jx brand 'app' fragment. A theme missing its colour fragment
    // Adopts three, which is exactly what `color="light"` did.
    for (const color of CHROME_THEMES) {
      expect(adoptedFragmentCount(color), color).toBe(4);
    }
  });

  test("a Spectrum colour Studio does not declare adopts one fewer — the failure mode itself", () => {
    /* "lightest" is a colour `<sp-theme>` ACCEPTS (it is in Spectrum's COLOR_VALUES) and Studio has
       no fragment for, so it reproduces the bug on demand: a valid attribute, a silent absence, and
       a palette that never arrives. Without this the test above would pass over an app that
       registered nothing at all. */
    expect(adoptedFragmentCount("lightest")).toBe(3);
  });
});

describe("the brand fragment values both ramps", () => {
  /** Every `--spectrum-*-rgb` stop declared inside one selector block of the brand fragment. */
  function stopsUnder(selector: string): string[] {
    const css = jxTheme.cssText;
    const start = css.indexOf(selector);
    expect(start, `${selector} is not in the brand fragment`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    const block = css.slice(open, close);
    return [...block.matchAll(/(--spectrum-[a-z]+-\d+-rgb):/g)]
      .map((m) => m[1] as string)
      .toSorted();
  }

  test("the light ramp overrides exactly the stops the dark ramp does", () => {
    /* The 'app' fragment is registered once and adopted whatever `color` is, so an override the
       light block forgets is not "unbranded" — it inherits the DARK brand value and paints a
       near-black surface into a light theme. Set equality is the only assertion that catches it. */
    const dark = stopsUnder(":host {");
    const light = stopsUnder(':host([color="light"])');
    expect(light).toEqual(dark);
    expect(dark.length).toBeGreaterThan(20);
  });

  test("the two ramps disagree on the stops they share, or one of them is not a theme", () => {
    const css = jxTheme.cssText;
    // Gray-50 is the darkest surface in the dark ramp and the lightest in the light one — the ends
    // Swap, which is why the light ramp cannot be authored by reversing the dark one.
    expect(css).toContain("--spectrum-gray-50-rgb: 10, 10, 10");
    expect(css).toContain("--spectrum-gray-50-rgb: 255, 255, 255");
  });
});

describe("monacoTheme", () => {
  test("maps each chrome theme to Monaco's own counterpart", () => {
    expect(monacoTheme("dark")).toBe("vs-dark");
    expect(monacoTheme("light")).toBe("vs");
  });

  test("reads the shell record when asked for no theme in particular", () => {
    setChromeTheme("light");
    expect(monacoTheme()).toBe("vs");
    setChromeTheme("dark");
    expect(monacoTheme()).toBe("vs-dark");
  });

  test("covers every declared theme — a new one cannot default to the dark editor by omission", () => {
    for (const theme of CHROME_THEMES) {
      expect(["vs", "vs-dark"]).toContain(monacoTheme(theme));
    }
    expect(new Set(CHROME_THEMES.map((t) => monacoTheme(t))).size).toBe(CHROME_THEMES.length);
  });
});

describe("applyChromeTheme projects the record", () => {
  test("paints <sp-theme>, stamps <html>, and repaints a live editor", () => {
    const theme = document.createElement("sp-theme");
    theme.setAttribute("color", "dark");
    document.body.append(theme);
    try {
      shell.theme = "light";
      applyChromeTheme();

      expect(theme.getAttribute("color")).toBe("light");
      // The one channel that reaches the html/body backdrop: <html> is an ANCESTOR of <sp-theme>,
      // So `styles/tokens.css` cannot read a --spectrum-* token up there.
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(setThemeCalls).toEqual(["vs"]);

      shell.theme = "dark";
      applyChromeTheme();
      expect(theme.getAttribute("color")).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(setThemeCalls).toEqual(["vs", "vs-dark"]);
    } finally {
      theme.remove();
    }
  });

  test("does not reach for Monaco when no code surface has opened it", () => {
    /* The theme is not allowed to be the thing that pulls 12.6 MB of editor into a session that
       never opened one — `loadedMonaco()`, never `loadMonaco()`. */
    editorLoaded = false;
    shell.theme = "light";
    expect(() => applyChromeTheme()).not.toThrow();
    expect(setThemeCalls).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
