import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import { computeRelativePath } from "../src/files/components.js";

// ─── computeRelativePath ────────────────────────────────────────────────────

describe("computeRelativePath", () => {
  test("same directory", () => {
    expect(computeRelativePath("pages/index.json", "pages/button.json")).toBe("./button.json");
  });

  test("child directory", () => {
    expect(computeRelativePath("pages/index.json", "pages/components/card.json")).toBe(
      "./components/card.json",
    );
  });

  test("parent directory", () => {
    expect(computeRelativePath("pages/about/index.json", "pages/button.json")).toBe(
      "../button.json",
    );
  });

  test("sibling directory", () => {
    expect(computeRelativePath("pages/about/index.json", "components/card.json")).toBe(
      "../../components/card.json",
    );
  });

  test("deeply nested to root", () => {
    expect(computeRelativePath("pages/a/b/c/index.json", "components/x.json")).toBe(
      "../../../../components/x.json",
    );
  });

  test("null fromDocPath returns ./ prefix", () => {
    expect(computeRelativePath(null, "components/button.json")).toBe("./components/button.json");
  });

  test("empty fromDocPath returns ./ prefix", () => {
    expect(computeRelativePath("", "components/button.json")).toBe("./components/button.json");
  });

  test("handles backslashes (Windows paths)", () => {
    expect(computeRelativePath("pages\\index.json", "pages\\button.json")).toBe("./button.json");
  });

  test("common prefix is computed correctly", () => {
    expect(computeRelativePath("src/pages/home.json", "src/components/nav.json")).toBe(
      "../components/nav.json",
    );
  });
});
