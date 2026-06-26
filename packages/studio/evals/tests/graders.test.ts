import "../../tests/with-dom.ts";
import { describe, expect, test } from "bun:test";
import { renderCritic } from "../render-critic.js";
import { schemaGrader } from "../schema-grader.js";

describe("render critic", () => {
  test("passes a clean document", async () => {
    const { pass, errors } = await renderCritic({
      tagName: "div",
      children: [{ tagName: "p", textContent: "Hello" }],
    });
    expect(pass).toBe(true);
    expect(errors).toEqual([]);
  });

  test("fails and reports a sensor message on a bad import map", async () => {
    // BuildScope warns when a $prototype import does not map to a *.class.json path.
    const { pass, errors } = await renderCritic({
      tagName: "div",
      imports: { Foo: "not-a-class" },
      state: { x: { $prototype: "Foo" } },
      children: [],
    });
    expect(pass).toBe(false);
    expect(errors.join("\n")).toContain(".class.json");
  });

  test("reports a template binding that references undefined state", async () => {
    // ${missingVar} has no matching state entry — the runtime surfaces an "is not defined"
    // Diagnostic, which the critic rephrases as a binding fix hint.
    const { pass, errors } = await renderCritic({
      tagName: "div",
      children: [{ tagName: "p", textContent: "${missingVar}" }],
    });
    expect(pass).toBe(false);
    expect(errors.join("\n").toLowerCase()).toContain("not defined");
  });
});

describe("schema grader", () => {
  test("passes a structurally valid document", async () => {
    const { pass } = await schemaGrader({
      tagName: "div",
      children: [{ tagName: "p", textContent: "ok" }],
    });
    expect(pass).toBe(true);
  });

  test("fails a structurally invalid document (style must be an object)", async () => {
    const { pass, errors } = await schemaGrader({
      tagName: "div",
      style: "red",
    });
    expect(pass).toBe(false);
    expect(errors.join("\n")).toContain("style");
  });
});
