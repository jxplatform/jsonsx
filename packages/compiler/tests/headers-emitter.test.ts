/**
 * Tests for `dist/_headers`.
 *
 * The rule that matters most here is negative — `/components/*` must never be marked immutable — so
 * it gets a test named after the consequence rather than after the code.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHeaderRules,
  contentTypeRules,
  IMMUTABLE_PATTERN,
  NEVER_IMMUTABLE,
  renderHeaders,
  writeHeaders,
  writeNoJekyll,
} from "../src/site/headers-emitter.ts";
import type { ProjectConfig } from "@jxsuite/schema/types";

type Build = ProjectConfig["build"];

function rulesFor(build: Build) {
  return buildHeaderRules(build);
}

function headersAt(build: Build, pattern: string): Record<string, string> | undefined {
  return rulesFor(build).rules.find((r) => r.pattern === pattern)?.headers;
}

const EMPTY: Build = {};

describe("the default rule set", () => {
  it("revalidates everything and marks only the content-addressed variants immutable", () => {
    const wide = headersAt(EMPTY, "/*")!;
    expect(wide["Cache-Control"]).toBe("public, max-age=0, must-revalidate");
    const immutable = headersAt(EMPTY, IMMUTABLE_PATTERN)!;
    expect(immutable["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  it("sets the four security headers", () => {
    const wide = headersAt(EMPTY, "/*")!;
    expect(wide["X-Content-Type-Options"]).toBe("nosniff");
    expect(wide["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(wide["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(wide["X-Frame-Options"]).toBe("SAMEORIGIN");
  });

  it("puts the immutable stanza AFTER the catch-all, because the later rule wins", () => {
    const { rules } = rulesFor(EMPTY);
    expect(rules.map((r) => r.pattern)).toEqual(["/*", IMMUTABLE_PATTERN]);
  });

  /*
   * THE GUARD. `/components/<tag>.js` is named after the tag, not after its content, so editing a
   * component reuses the URL. Marking it immutable is a year-long cache-poisoning bug visible only
   * to visitors who came before the edit. Content-hash those filenames first, then revisit this.
   */
  it("never marks a path that is not content-addressed immutable", () => {
    const { rules } = rulesFor(EMPTY);
    for (const pattern of NEVER_IMMUTABLE) {
      expect(rules.some((r) => r.pattern === pattern)).toBe(false);
    }
    const immutableRules = rules.filter((r) =>
      (r.headers["Cache-Control"] ?? "").includes("immutable"),
    );
    expect(immutableRules.map((r) => r.pattern)).toEqual([IMMUTABLE_PATTERN]);
  });
});

describe("configuration", () => {
  it("enabled: false emits nothing at all", () => {
    expect(rulesFor({ headers: { enabled: false } }).rules).toEqual([]);
  });

  it('cache: "off" drops both Cache-Control rules but keeps the security headers', () => {
    const { rules } = rulesFor({ headers: { cache: "off" } });
    expect(rules.map((r) => r.pattern)).toEqual(["/*"]);
    expect(rules[0]!.headers["Cache-Control"]).toBeUndefined();
    expect(rules[0]!.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("each security header can be switched off individually", () => {
    const off = headersAt(
      {
        headers: {
          security: {
            contentTypeOptions: false,
            frameOptions: false,
            permissionsPolicy: false,
            referrerPolicy: false,
          },
        },
      },
      "/*",
    )!;
    expect(Object.keys(off)).toEqual(["Cache-Control"]);
  });

  it("HSTS is off by default and opt-in by value", () => {
    expect(headersAt(EMPTY, "/*")!["Strict-Transport-Security"]).toBeUndefined();
    expect(
      headersAt({ headers: { security: { hsts: true } } }, "/*")!["Strict-Transport-Security"],
    ).toBe("max-age=31536000; includeSubDomains");
    expect(
      headersAt(
        { headers: { security: { hsts: { includeSubDomains: true, maxAge: 60, preload: true } } } },
        "/*",
      )!["Strict-Transport-Security"],
    ).toBe("max-age=60; includeSubDomains; preload");
  });

  /* The preload list refuses a header without includeSubDomains, so emitting one is a false claim. */
  it("preload without includeSubDomains is an error, and no header is emitted", () => {
    const { errors, rules } = rulesFor({
      headers: { security: { hsts: { includeSubDomains: false, preload: true } } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("includeSubDomains");
    expect(rules[0]!.headers["Strict-Transport-Security"]).toBeUndefined();
  });

  it("verbatim rules land after the generated ones", () => {
    const { rules } = rulesFor({
      headers: { rules: { "/downloads/*": { "X-Robots-Tag": "none" } } },
    });
    expect(rules.at(-1)).toEqual({
      headers: { "X-Robots-Tag": "none" },
      pattern: "/downloads/*",
    });
  });
});

describe("writing", () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), "jx-headers-"));
  }

  it("renders the Netlify / Cloudflare stanza format", () => {
    const text = renderHeaders([{ headers: { "X-A": "1", "X-B": "2" }, pattern: "/*" }]);
    expect(text).toContain("/*\n  X-A: 1\n  X-B: 2\n");
    expect(text.startsWith("# Generated by @jxsuite/compiler")).toBe(true);
  });

  it("keeps a hand-authored public/_headers BELOW the generated block, verbatim", () => {
    const dir = tmp();
    // The public/ copy has already put the author's file at this path by the time we run.
    writeFileSync(join(dir, "_headers"), "/secret/*\n  ! X-Frame-Options\n", "utf8");
    writeHeaders(dir, rulesFor(EMPTY).rules);
    const text = readFileSync(join(dir, "_headers"), "utf8");
    const generatedAt = text.indexOf("# Generated by");
    const authoredAt = text.indexOf("/secret/*");
    expect(generatedAt).toBeLessThan(authoredAt);
    // Verbatim: the removal extension is not something a structural merge could have preserved.
    expect(text).toContain("! X-Frame-Options");
    rmSync(dir, { force: true, recursive: true });
  });

  it("writes nothing when there are no rules", () => {
    const dir = tmp();
    expect(writeHeaders(dir, [])).toBe(0);
    expect(existsSync(join(dir, "_headers"))).toBe(false);
    rmSync(dir, { force: true, recursive: true });
  });

  it("names a content type only for output that exists", () => {
    const dir = tmp();
    expect(contentTypeRules(dir)).toEqual([]);
    // No host maps .xml to Atom, so the build has to say so.
    writeFileSync(join(dir, "feed.xml"), "", "utf8");
    const rules = contentTypeRules(dir);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
      pattern: "/feed.xml",
    });
    rmSync(dir, { force: true, recursive: true });
  });

  it("writes .nojekyll once, and leaves an existing one alone", () => {
    const dir = tmp();
    expect(writeNoJekyll(dir)).toBe(1);
    expect(existsSync(join(dir, ".nojekyll"))).toBe(true);
    expect(writeNoJekyll(dir)).toBe(0);
    rmSync(dir, { force: true, recursive: true });
  });
});
