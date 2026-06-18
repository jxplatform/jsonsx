import { describe, expect, test } from "bun:test";
import { validateDoc } from "../src/services/jx-validate";

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
