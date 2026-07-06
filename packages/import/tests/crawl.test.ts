import { describe, test, expect } from "bun:test";
import { normalizeUrl, routeToFilePath } from "../src/crawl.ts";

describe("normalizeUrl", () => {
  test("strips trailing slash", () => {
    expect(normalizeUrl("https://example.com/about/")).toBe("https://example.com/about");
  });

  test("preserves root URL without double-stripping", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  test("strips hash fragments", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
  });

  test("strips tracking params (utm_source, fbclid, gclid)", () => {
    expect(
      normalizeUrl("https://example.com/page?utm_source=twitter&utm_medium=social&real=1"),
    ).toBe("https://example.com/page?real=1");
  });

  test("strips fbclid", () => {
    expect(normalizeUrl("https://example.com/page?fbclid=abc123&keep=yes")).toBe(
      "https://example.com/page?keep=yes",
    );
  });

  test("sorts remaining query params for consistent dedup", () => {
    expect(normalizeUrl("https://example.com/page?z=1&a=2")).toBe(
      "https://example.com/page?a=2&z=1",
    );
  });

  test("handles URL with no query or hash", () => {
    expect(normalizeUrl("https://example.com/about")).toBe("https://example.com/about");
  });

  test("returns original string for invalid URLs", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("routeToFilePath", () => {
  const origin = "https://example.com";

  test("root URL → pages/index.json", () => {
    expect(routeToFilePath("https://example.com/", origin)).toBe("pages/index.json");
  });

  test("root without trailing slash → pages/index.json", () => {
    expect(routeToFilePath("https://example.com", origin)).toBe("pages/index.json");
  });

  test("single segment → pages/<segment>.json", () => {
    expect(routeToFilePath("https://example.com/about", origin)).toBe("pages/about.json");
  });

  test("nested path → pages/<path>.json", () => {
    expect(routeToFilePath("https://example.com/blog/post-1", origin)).toBe(
      "pages/blog/post-1.json",
    );
  });

  test("strips .html extension", () => {
    expect(routeToFilePath("https://example.com/about.html", origin)).toBe("pages/about.json");
  });

  test("sanitizes special characters in segments", () => {
    expect(routeToFilePath("https://example.com/my%20page/hello world", origin)).toBe(
      "pages/my_20page/hello_20world.json",
    );
  });

  test("trailing slash is stripped", () => {
    expect(routeToFilePath("https://example.com/about/", origin)).toBe("pages/about.json");
  });
});
