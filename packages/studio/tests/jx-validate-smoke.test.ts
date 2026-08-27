import { afterEach, describe, expect, test } from "bun:test";
import {
  applyProjectSchemas,
  resetProjectSchemas,
  validateDoc,
  validateDocOrNull,
  validateProjectConfig,
} from "../src/services/jx-validate";

afterEach(() => {
  resetProjectSchemas();
});

describe("jx-validate (real @jxsuite/schema)", () => {
  // Schema compilation loads @webref/* packages and compiles ajv — give it plenty of time.
  test("valid document yields no errors", async () => {
    const errs = await validateDoc({
      tagName: "div",
      children: [{ tagName: "p", textContent: "hi" }],
    });
    expect(errs).toEqual([]);
  }, 30_000);

  test("malformed style (string not object) is flagged", async () => {
    const errs = await validateDoc({ tagName: "div", style: "color: red" });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toContain("style");
  }, 30_000);
});

/**
 * The three-state answer, and why one exists.
 *
 * {@link validateDoc} fails OPEN — an unavailable validator answers `[]`, indistinguishable from "no
 * errors". That is right where validation decorates an editor and wrong where it GATES a
 * destructive step: `format/convert-file.ts` would tell the reader their conversion produces a
 * valid document on the strength of a schema it never compiled.
 */
describe("validateDocOrNull", () => {
  test("distinguishes valid from invalid, exactly as validateDoc does", async () => {
    expect(await validateDocOrNull({ children: [], tagName: "div" })).toEqual([]);
    const errs = await validateDocOrNull({ style: "color: red", tagName: "div" });
    expect(errs?.length ?? 0).toBeGreaterThan(0);
  }, 30_000);
});

/**
 * A payload half that is not a schema OBJECT must fall back to core.
 *
 * `ajv.compile({})` succeeds and accepts everything, so a backend answering `null`, a string or an
 * error envelope under `document` would not fail loudly — it would install a validator that calls
 * every document valid, and every consumer would go on trusting it.
 */
describe("applyProjectSchemas guards its payload", () => {
  test("a non-object half is not applied, and the answer says so", async () => {
    expect(applyProjectSchemas({ document: "boom" as never })).toBe(false);
    // Core is still in force: the malformed style is still caught.
    const errs = await validateDoc({ style: "color: red", tagName: "div" });
    expect(errs.length).toBeGreaterThan(0);
  }, 30_000);

  test("an empty object is not a schema either — it would accept everything", () => {
    expect(applyProjectSchemas({ document: {}, project: {} })).toBe(false);
  });

  test("a real schema IS applied", () => {
    expect(applyProjectSchemas({ document: { type: "object" } })).toBe(true);
  });
});

describe("jx-validate — project.json gate", () => {
  test("a well-formed config passes the core project schema", async () => {
    expect(await validateProjectConfig({ name: "Demo" })).toEqual([]);
  }, 30_000);

  test("a structurally wrong core field is flagged", async () => {
    const errs = await validateProjectConfig({ name: 42 });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toContain("name");
  }, 30_000);
});

/* The per-project entry documents are what close the composition over the enabled extensions
   (extensions.md §5.2). Before they were wired in here the assistant judged every write by the
   OPEN core schema, so a typo'd section key — exactly what `unevaluatedProperties: false` exists to
   catch — came back clean from the tool and red in the editor a moment later. */
describe("jx-validate — per-project entry documents", () => {
  const PROJECT_ENTRY = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    allOf: [{ $ref: "#/$defs/core" }],
    unevaluatedProperties: false,
    $defs: {
      core: {
        type: "object",
        properties: { $schema: { type: "string" }, name: { type: "string" } },
        required: ["name"],
      },
    },
  };
  const DOCUMENT_ENTRY = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { tagName: { type: "string" } },
    required: ["tagName"],
    additionalProperties: false,
  };

  test("applyProjectSchemas swaps both validators and reports the upgrade", async () => {
    expect(applyProjectSchemas({ document: DOCUMENT_ENTRY, project: PROJECT_ENTRY })).toBe(true);

    // Accepted by the OPEN core project schema, rejected by the closed entry document.
    const errs = await validateProjectConfig({ name: "Demo", typodSection: {} });
    expect(errs.length).toBeGreaterThan(0);
    expect(await validateProjectConfig({ name: "Demo" })).toEqual([]);

    expect(await validateDoc({ tagName: "div", nope: 1 })).not.toEqual([]);
    expect(await validateDoc({ tagName: "div" })).toEqual([]);
  }, 30_000);

  test("a partial payload upgrades only the half it carries", async () => {
    expect(applyProjectSchemas({ project: PROJECT_ENTRY })).toBe(true);
    expect(await validateProjectConfig({ name: "Demo", typodSection: {} })).not.toEqual([]);
    // Document validation falls back to core, which still accepts a real Jx document.
    expect(await validateDoc({ tagName: "div", children: [] })).toEqual([]);
  }, 30_000);

  test("an empty or null payload keeps the core schemas", async () => {
    expect(applyProjectSchemas(null)).toBe(false);
    expect(applyProjectSchemas({})).toBe(false);
    expect(await validateProjectConfig({ name: "Demo", anythingGoes: true })).toEqual([]);
  }, 30_000);

  test("resetProjectSchemas restores the core pair", async () => {
    applyProjectSchemas({ document: DOCUMENT_ENTRY, project: PROJECT_ENTRY });
    resetProjectSchemas();
    expect(await validateProjectConfig({ name: "Demo", typodSection: {} })).toEqual([]);
    expect(await validateDoc({ tagName: "div", children: [] })).toEqual([]);
  }, 30_000);
});
