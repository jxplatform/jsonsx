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
