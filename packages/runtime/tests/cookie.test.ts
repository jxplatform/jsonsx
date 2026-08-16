/**
 * The Cookie `$prototype`'s reader and writer. The reader's contract is that a cookie NAME is data,
 * never pattern syntax; the writer's is that the attributes a browser requires are applied, since a
 * browser that disagrees drops the cookie without saying so.
 */

import { describe, expect, test } from "bun:test";
import { readCookie, serializeCookie } from "../src/cookie.ts";

describe("readCookie", () => {
  test("finds a value among several pairs", () => {
    const header = "a=1; theme=dark; b=2";
    expect(readCookie(header, "theme")).toBe("dark");
    expect(readCookie(header, "a")).toBe("1");
    expect(readCookie(header, "b")).toBe("2");
  });

  test("returns null for a name that is not present", () => {
    expect(readCookie("a=1; b=2", "c")).toBeNull();
    expect(readCookie("", "a")).toBeNull();
  });

  test("a name is data, not a pattern", () => {
    /*
     * The old reader interpolated the name into a RegExp. `a.b` then matched `axb`, and a name with
     * an unbalanced bracket threw SyntaxError out of a document that validates.
     */
    expect(readCookie("axb=wrong; a.b=right", "a.b")).toBe("right");
    expect(readCookie("axb=wrong", "a.b")).toBeNull();
    expect(readCookie("s[1]=v", "s[1]")).toBe("v");
    expect(() => readCookie("x=1", "(unclosed")).not.toThrow();
    expect(readCookie("x=1", "(unclosed")).toBeNull();
  });

  test("does not match a name that merely ends with the one asked for", () => {
    expect(readCookie("not_theme=no; theme=yes", "theme")).toBe("yes");
  });

  test("tolerates a value containing '=' and a pair with none", () => {
    expect(readCookie("flag; token=a=b=c", "token")).toBe("a=b=c");
  });
});

describe("serializeCookie", () => {
  test("JSON-encodes then percent-encodes the value", () => {
    expect(serializeCookie("ck", { a: 1 }, {})).toBe(`ck=${encodeURIComponent('{"a":1}')}`);
  });

  test("writes the declared attributes", () => {
    expect(
      serializeCookie("ck", "v", {
        domain: "example.com",
        maxAge: 60,
        path: "/app",
        sameSite: "Lax",
        secure: true,
      }),
    ).toBe(
      `ck=${encodeURIComponent('"v"')}; Max-Age=60; Path=/app; Domain=example.com; Secure; SameSite=Lax`,
    );
  });

  test("__Host- forces Secure and Path=/, and drops Domain", () => {
    // Honoring the declared path/domain would produce a cookie no browser stores.
    const out = serializeCookie("__Host-sid", "v", { domain: "example.com", path: "/app" });
    expect(out).toContain("Path=/");
    expect(out).not.toContain("Path=/app");
    expect(out).not.toContain("Domain=");
    expect(out).toContain("Secure");
  });

  test("__Secure- forces Secure but leaves path and domain alone", () => {
    const out = serializeCookie("__Secure-sid", "v", { domain: "example.com", path: "/app" });
    expect(out).toContain("Secure");
    expect(out).toContain("Path=/app");
    expect(out).toContain("Domain=example.com");
  });

  test("SameSite=None forces Secure, in either spelling", () => {
    expect(serializeCookie("ck", "v", { sameSite: "None" })).toContain("Secure");
    expect(serializeCookie("ck", "v", { sameSite: "none" })).toContain("Secure");
    expect(serializeCookie("ck", "v", { sameSite: "Lax" })).not.toContain("Secure");
  });

  test("emits no attribute the author did not ask for", () => {
    const out = serializeCookie("ck", "v", {});
    expect(out).toBe(`ck=${encodeURIComponent('"v"')}`);
    // HttpOnly cannot be set from script and would make the value unreadable — never emitted.
    expect(out).not.toContain("HttpOnly");
    // Expires is unsupported: Max-Age wins wherever both appear (RFC 6265bis §5.5).
    expect(out).not.toContain("Expires");
  });

  test("Max-Age=0, which deletes the cookie, is not confused with absent", () => {
    expect(serializeCookie("ck", null, { maxAge: 0 })).toContain("Max-Age=0");
  });
});
