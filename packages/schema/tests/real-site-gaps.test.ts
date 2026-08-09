/**
 * Three schema faults found by driving Studio against a real production site, each proved against
 * ajv rather than by reading the generated JSON.
 *
 * A structural assertion — "the pattern key is present" — would pass on a pattern that matches the
 * wrong thing, and two of these three faults were the schema being confidently wrong about a shape,
 * not the schema lacking a key. So every case here compiles the real `schema.json` and validates a
 * real document fragment through it.
 *
 * All three were invisible to the whole suite because the suite only ever fed the schema documents
 * the schema already liked.
 */
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const schema = JSON.parse(readFileSync(join(import.meta.dir, "../schema.json"), "utf8")) as Record<
  string,
  unknown
>;

/*
 * COMPILED ONCE. Compiling this schema costs the better part of a second, and a per-call compile
 * put the seven-name case at ~5.1s — over Bun's 5s default, so it passed alone and timed out in the
 * full run. A test that fails only when its neighbours are present is worse than no test.
 */
const compiled = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(
  schema,
);

/** Validate a document fragment against the core document schema. */
function validate(doc: unknown): { ok: boolean; errors: string } {
  const ok = compiled(doc) as boolean;
  const errors = (compiled.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; ");
  return { errors, ok };
}

/** The smallest thing the document schema accepts, as a carrier for the fragment under test. */
const doc = (children: unknown, state?: unknown) => ({
  tagName: "x-card",
  ...(state === undefined ? {} : { state }),
  children,
});

describe("a tagName is a name, never an expression", () => {
  /*
   * `"${state.href ? 'a' : 'div'}"` validated, and then every consumer did something different and
   * silent with it: the runtime threw `InvalidCharacterError` from `createElement`, the compiler
   * spliced it into a lit template as a binding in tag position, and the static renderer emitted it
   * into the prerendered HTML and re-resolved that string against the PAGE scope — where the
   * component's own `state` does not exist — so a built page silently collapsed to the fallback
   * branch's tag carrying the other branch's attributes. A real site shipped that.
   */
  test("an expression in tagName is refused, and the message names the pattern", () => {
    const { errors, ok } = validate(doc([{ tagName: "${state.href ? 'a' : 'div'}" }]));
    expect(ok).toBe(false);
    expect(errors).toContain("pattern");
  });

  test("the names people actually write still pass", () => {
    for (const tagName of [
      "div",
      "a",
      "x-card",
      "sp-icon-alert",
      "annotation-xml",
      "h1",
      "my.el",
    ]) {
      expect(validate(doc([{ tagName }])).ok).toBe(true);
    }
  });

  test("and the root's own tagName is held to it too", () => {
    expect(validate({ children: [], tagName: "${state.tag}" }).ok).toBe(false);
  });
});

describe("a $switch child", () => {
  /*
   * `$defs.SwitchNode` was defined and referenced from NOWHERE, while the compiler rendered
   * `$switch` at three call sites. `ChildrenValue` admitted `ElementDef | ArrayNamespace | string |
   * number`, and `ElementDef` requires `tagName` — so a switch child with no container tag matched
   * nothing and every document using one failed `jx validate`.
   */
  const switchChild = {
    $switch: { $ref: "#/state/imageKey" },
    cases: { set: { attributes: { alt: "" }, tagName: "img" } },
  };

  test("validates without a container tagName — the form that was impossible", () => {
    const { errors, ok } = validate(doc([switchChild]));
    expect(errors).toBe("");
    expect(ok).toBe(true);
  });

  test("…and WITH one, which `oneOf` would have broken while fixing the first", () => {
    // With `oneOf`, adding the SwitchNode ref makes this form match two branches and fail
    // "exactly one" — trading a new break for the old one. `anyOf` is why both forms pass.
    expect(validate(doc([{ ...switchChild, tagName: "section" }])).ok).toBe(true);
  });

  test("a child object that is neither is still refused", () => {
    expect(validate(doc([{ notAnything: true }])).ok).toBe(false);
  });
});

describe("an extension class's own filter", () => {
  /*
   * `ExternalClassDef` is one flat grab-bag shared by every state `$prototype`, so the shape
   * `filter` needs for the built-in `Array` prototype — a reactive `$ref` — was imposed on every
   * extension class. `@jxsuite/parser`'s ContentCollection and `@jxsuite/connector`'s TableQuery
   * both declare `filter` as a rule ARRAY, so correct use of a documented parameter was rejected
   * with "must be object".
   */
  const state = (filter: unknown) => ({
    projects: {
      $prototype: "ContentCollection",
      $src: "@jxsuite/parser/ContentCollection.class.json",
      contentType: "projects",
      filter,
    },
  });

  test("a rule array validates — the shape the class itself declares", () => {
    const { errors, ok } = validate(doc([], state([{ field: "Slug", op: "not empty" }])));
    expect(errors).toBe("");
    expect(ok).toBe(true);
  });

  test("the object shorthand and the reactive $ref still validate", () => {
    const shorthand = doc([], state({ status: "published" }));
    const reactive = doc([], state({ $ref: "#/state/currentFilter" }));
    expect(validate(shorthand).ok).toBe(true);
    expect(validate(reactive).ok).toBe(true);
  });
});
