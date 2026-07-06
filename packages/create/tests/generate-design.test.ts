/**
 * The design-quickstart options of generate.ts: colors/fonts/breakpoints applied to the blank
 * scaffold's style block, the best-effort token retheme of a cloned starter, the logo write with
 * its basename/extension guard, and the no-design byte-identity regression.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TOKENS_FIXTURE = resolve(tmpdir(), `jx-design-tokens-fixture-${Date.now()}`);
const PLAIN_FIXTURE = resolve(tmpdir(), `jx-design-plain-fixture-${Date.now()}`);
const TMP = resolve(tmpdir(), `jx-create-design-test-${Date.now()}`);
const TMP2 = resolve(tmpdir(), `jx-create-design-test2-${Date.now()}`);

// Stand in for @jxsuite/starters with two local fixtures: one following the shared token
// Conventions, one with only plain CSS properties.
void mock.module("@jxsuite/starters", () => ({
  getStarterDir: (id: string) => {
    if (id === "tokens") {
      return TOKENS_FIXTURE;
    }
    if (id === "plain") {
      return PLAIN_FIXTURE;
    }
    throw new Error(`Unknown starter: "${id}"`);
  },
}));

const { generateProject } = await import("../generate");

const LOGO_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readJson(...segments: string[]) {
  return JSON.parse(readFileSync(join(TMP, ...segments), "utf8"));
}

beforeAll(() => {
  for (const [fixture, project] of [
    [
      TOKENS_FIXTURE,
      {
        name: "Tokens Starter",
        style: {
          "--color-primary": "#0044cc",
          "--color-primary-hover": "#0033aa",
          "--color-text-primary": "#111111",
          "--font-body": "'Inter', sans-serif",
          "--font-heading": "'Sora', sans-serif",
          backgroundColor: "#fffdf8",
          color: "#111111",
          fontFamily: "'Inter', sans-serif",
        },
        url: "https://tokens.example",
      },
    ],
    [
      PLAIN_FIXTURE,
      {
        name: "Plain Starter",
        style: { color: "#222222", fontFamily: "Georgia, serif" },
        url: "https://plain.example",
      },
    ],
  ] as const) {
    mkdirSync(join(fixture, "pages"), { recursive: true });
    writeFileSync(join(fixture, "project.json"), JSON.stringify(project));
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "starter" }));
    writeFileSync(join(fixture, "pages", "index.md"), "# Home\n");
  }
});

afterEach(() => {
  rmSync(TMP, { force: true, recursive: true });
  rmSync(TMP2, { force: true, recursive: true });
});

describe("generateProject — design quickstart (blank)", () => {
  test("applies colors, fonts, breakpoints, and the logo to the blank scaffold", async () => {
    await generateProject(TMP, {
      design: {
        accent: "#ff5500",
        background: "#fafafa",
        bodyFont: "'Atkinson Hyperlegible', sans-serif",
        headingFont: "'Fraunces', serif",
        logo: { base64: LOGO_BYTES.toString("base64"), name: "logo.png" },
        media: { "--": "1440px", "--sm": "(max-width: 600px)" },
        text: "#0b1220",
      },
      name: "Designed",
    });

    const project = readJson("project.json");
    expect(project.style["--color-primary"]).toBe("#ff5500");
    expect(project.style.backgroundColor).toBe("#fafafa");
    // The default "#1a1a1a" body color is overridden.
    expect(project.style.color).toBe("#0b1220");
    expect(project.style.fontFamily).toBe("'Atkinson Hyperlegible', sans-serif");
    expect(project.style["--font-heading"]).toBe("'Fraunces', serif");
    // A non-empty media map replaces the template's $media entirely.
    expect(project.$media).toEqual({ "--": "1440px", "--sm": "(max-width: 600px)" });

    const logo = readFileSync(join(TMP, "public", "logo.png"));
    expect(logo.equals(LOGO_BYTES)).toBe(true);
  });

  test("no design / empty design leaves the output byte-identical", async () => {
    await generateProject(TMP, { name: "Plain Site" });
    const reference = readFileSync(join(TMP, "project.json"), "utf8");

    await generateProject(TMP2, { design: {}, name: "Plain Site" });
    expect(readFileSync(join(TMP2, "project.json"), "utf8")).toBe(reference);

    // An empty media map is treated as absent, not as "remove all breakpoints".
    rmSync(TMP2, { force: true, recursive: true });
    await generateProject(TMP2, { design: { media: {} }, name: "Plain Site" });
    expect(readFileSync(join(TMP2, "project.json"), "utf8")).toBe(reference);
    expect(existsSync(join(TMP2, "public", "logo.png"))).toBe(false);
  });
});

describe("generateProject — design quickstart (starter retheme)", () => {
  test("re-themes the shared token conventions, leaving --color-primary-hover alone", async () => {
    await generateProject(TMP, {
      design: {
        accent: "#ff5500",
        background: "#101418",
        bodyFont: "'Atkinson Hyperlegible', sans-serif",
        headingFont: "'Fraunces', serif",
        logo: { base64: LOGO_BYTES.toString("base64"), name: "mark.svg" },
        media: { "--": "1200px" },
        text: "#e8e8e8",
      },
      name: "Rethemed",
      starter: "tokens",
    });

    const project = readJson("project.json");
    expect(project.style["--color-primary"]).toBe("#ff5500");
    expect(project.style["--color-primary-hover"]).toBe("#0033aa");
    expect(project.style["--color-text-primary"]).toBe("#e8e8e8");
    // Token keys win over the plain CSS fallbacks, which stay untouched.
    expect(project.style.color).toBe("#111111");
    expect(project.style["--font-body"]).toBe("'Atkinson Hyperlegible', sans-serif");
    expect(project.style.fontFamily).toBe("'Inter', sans-serif");
    expect(project.style["--font-heading"]).toBe("'Fraunces', serif");
    // Background applies because the starter declares a top-level backgroundColor.
    expect(project.style.backgroundColor).toBe("#101418");
    expect(project.$media).toEqual({ "--": "1200px" });

    const logo = readFileSync(join(TMP, "public", "mark.svg"));
    expect(logo.equals(LOGO_BYTES)).toBe(true);
  });

  test("falls back to plain CSS properties and skips unmatched tokens", async () => {
    await generateProject(TMP, {
      design: {
        accent: "#ff5500",
        background: "#101418",
        bodyFont: "'Atkinson Hyperlegible', sans-serif",
        headingFont: "'Fraunces', serif",
        text: "#e8e8e8",
      },
      name: "Fallbacks",
      starter: "plain",
    });

    const { style } = readJson("project.json");
    // Text and body font land on the plain CSS properties the starter declares.
    expect(style.color).toBe("#e8e8e8");
    expect(style.fontFamily).toBe("'Atkinson Hyperlegible', sans-serif");
    // Accent, heading font, and background are skipped: no matching keys to re-theme.
    expect(style["--color-primary"]).toBeUndefined();
    expect(style["--font-heading"]).toBeUndefined();
    expect(style.backgroundColor).toBeUndefined();
  });
});

describe("generateProject — design logo guard", () => {
  test("rejects a logo without an image extension", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(
      generateProject(TMP, {
        design: { logo: { base64: LOGO_BYTES.toString("base64"), name: "evil.html" } },
        name: "Bad Logo",
      }),
    ).rejects.toThrow('Logo file type not allowed: "evil.html"');
  });

  test("flattens path segments in the logo name to its basename", async () => {
    await generateProject(TMP, {
      design: { logo: { base64: LOGO_BYTES.toString("base64"), name: "../../evil.svg" } },
      name: "Traversal",
    });

    expect(existsSync(join(TMP, "public", "evil.svg"))).toBe(true);
    expect(existsSync(resolve(TMP, "..", "evil.svg"))).toBe(false);
  });
});
