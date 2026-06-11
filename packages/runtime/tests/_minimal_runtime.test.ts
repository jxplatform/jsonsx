import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { describe, test, expect } from "bun:test";
import { isSignal } from "../src/runtime";

try {
  GlobalRegistrator.register();
} catch {}

describe("sanity", () => {
  test("import works", () => {
    expect(typeof isSignal).toBe("function");
  });
});
