import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  buildSecurityTxt,
  manifestHeadEntries,
  writeWellKnown,
} from "../src/site/well-known.ts";
import type { ProjectConfig } from "@jxsuite/schema/types";

const NOW = new Date("2026-08-15T00:00:00Z");
const project = (extra: Partial<ProjectConfig>): ProjectConfig =>
  ({ name: "Site", ...extra }) as ProjectConfig;

const icons = [
  { sizes: "192x192", src: "/i192.png" },
  { sizes: "512x512", src: "/i512.png" },
];

describe("buildManifest", () => {
  test("emits nothing unless declared", () => {
    expect(buildManifest(project({})).files).toEqual([]);
    expect(buildManifest(project({ manifest: { enabled: false, icons } })).files).toEqual([]);
  });

  // A project already has a name and a root; asking for them twice is how they drift apart.
  test("falls back to the project's own name and the site root", () => {
    const [file] = buildManifest(project({ manifest: { icons } })).files;
    const manifest = JSON.parse(file?.content ?? "{}") as Record<string, unknown>;
    expect(manifest.name).toBe("Site");
    expect(manifest.short_name).toBe("Site");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  test("maps camelCase config onto the standard's snake_case keys", () => {
    const [file] = buildManifest(
      project({ manifest: { backgroundColor: "#fff", icons, shortName: "S", themeColor: "#123" } }),
    ).files;
    const manifest = JSON.parse(file?.content ?? "{}") as Record<string, unknown>;
    expect(manifest.theme_color).toBe("#123");
    expect(manifest.background_color).toBe("#fff");
    expect(manifest.short_name).toBe("S");
  });

  test("omits keys the project did not set rather than writing nulls", () => {
    const [file] = buildManifest(project({ manifest: { icons } })).files;
    expect(file?.content).not.toContain("theme_color");
    expect(file?.content).not.toContain("null");
  });

  /*
   * A warning, not an error: the manifest is still valid and still supplies the name and colour a
   * browser shows. But installability is the reason most people add one, and it needs both sizes.
   */
  test("warns — and still emits — when the installability icons are missing", () => {
    const result = buildManifest(project({ manifest: { icons: [{ sizes: "64x64", src: "/i" }] } }));
    expect(result.files).toHaveLength(1);
    expect(result.warnings[0]).toContain("192px");
    expect(result.warnings[0]).toContain("512px");
  });

  test("is quiet when both sizes are present, in any order", () => {
    const reversed = icons.toReversed();
    expect(buildManifest(project({ manifest: { icons: reversed } })).warnings).toEqual([]);
  });

  test("reads every size in a multi-size icon", () => {
    const both = [{ sizes: "192x192 512x512", src: "/any.svg", type: "image/svg+xml" }];
    expect(buildManifest(project({ manifest: { icons: both } })).warnings).toEqual([]);
  });
});

describe("manifestHeadEntries", () => {
  test("nothing when the manifest is off", () => {
    expect(manifestHeadEntries(project({}))).toEqual([]);
  });

  test("a manifest link, and theme-color only when set", () => {
    expect(manifestHeadEntries(project({ manifest: { icons } }))).toEqual([
      { attributes: { href: "/manifest.webmanifest", rel: "manifest" }, tagName: "link" },
    ]);
    expect(manifestHeadEntries(project({ manifest: { icons, themeColor: "#123" } }))).toHaveLength(
      2,
    );
  });
});

describe("buildSecurityTxt", () => {
  const valid = {
    contact: ["mailto:security@example.com"],
    expires: "2027-01-01T00:00:00Z",
  };

  test("emits nothing unless declared", () => {
    expect(buildSecurityTxt(project({}), NOW).files).toEqual([]);
    expect(buildSecurityTxt(project({ securityTxt: { enabled: false } }), NOW).files).toEqual([]);
  });

  // RFC 9116 §3 makes .well-known canonical, and a second copy at the root is a second thing to
  // Forget to update.
  test("writes to .well-known and nowhere else", () => {
    const { files } = buildSecurityTxt(project({ securityTxt: valid }), NOW);
    expect(files.map((f) => f.path)).toEqual([".well-known/security.txt"]);
  });

  test("renders the fields in the standard's spelling", () => {
    const { files } = buildSecurityTxt(
      project({
        securityTxt: {
          ...valid,
          acknowledgments: ["https://example.com/thanks"],
          canonical: "https://example.com/.well-known/security.txt",
          encryption: ["https://example.com/pgp-key.txt"],
          hiring: ["https://example.com/jobs"],
          policy: ["https://example.com/policy"],
          preferredLanguages: ["EN", "fr-ca"],
        },
      }),
      NOW,
    );
    const text = files[0]?.content ?? "";
    expect(text).toContain("Contact: mailto:security@example.com");
    expect(text).toContain("Expires: 2027-01-01T00:00:00Z");
    // Canonicalized through the same BCP 47 implementation as i18n.locales.
    expect(text).toContain("Preferred-Languages: en, fr-CA");
    expect(text).toContain("Acknowledgments: https://example.com/thanks");
    expect(text).toContain("Canonical: https://example.com/.well-known/security.txt");
    expect(text).toContain("Encryption: https://example.com/pgp-key.txt");
    expect(text).toContain("Policy: https://example.com/policy");
    expect(text).toContain("Hiring: https://example.com/jobs");
  });

  /*
   * `Expires` is required by §2.5.5 and is the field everyone forgets. Both failures are errors
   * rather than warnings because an expired file is worse than a missing one: it advertises a
   * reporting channel and simultaneously says not to trust it.
   */
  test("a missing expires is a build error", () => {
    const { errors, files } = buildSecurityTxt(
      project({ securityTxt: { contact: valid.contact } }),
      NOW,
    );
    expect(errors[0]).toContain("required");
    expect(files).toEqual([]);
  });

  test("a past expires is a build error", () => {
    const { errors } = buildSecurityTxt(
      project({ securityTxt: { ...valid, expires: "2020-01-01T00:00:00Z" } }),
      NOW,
    );
    expect(errors[0]).toContain("in the past");
  });

  test("an unparseable expires is a build error", () => {
    const { errors } = buildSecurityTxt(
      project({ securityTxt: { ...valid, expires: "next tuesday" } }),
      NOW,
    );
    expect(errors[0]).toContain("not a valid date");
  });

  test("no contact is a build error", () => {
    const { errors } = buildSecurityTxt(project({ securityTxt: { expires: valid.expires } }), NOW);
    expect(errors.some((e) => e.includes("contact"))).toBe(true);
  });

  test("a malformed preferred language is a build error", () => {
    const { errors } = buildSecurityTxt(
      project({ securityTxt: { ...valid, preferredLanguages: ["en_US"] } }),
      NOW,
    );
    expect(errors[0]).toContain("en_US");
  });
});

describe("writeWellKnown", () => {
  test("writes files and reports the count", () => {
    const out = mkdtempSync(join(tmpdir(), "jx-wk-"));
    try {
      const { written } = writeWellKnown(
        [{ content: "x\n", path: ".well-known/security.txt" }],
        out,
        existsSync,
      );
      expect(written).toBe(1);
      expect(readFileSync(join(out, ".well-known/security.txt"), "utf8")).toBe("x\n");
    } finally {
      rmSync(out, { force: true, recursive: true });
    }
  });

  /*
   * The skip is a feature, not a guard. Clearsigning needs a private key at build time, so the
   * build cannot do it — but `public/.well-known/security.txt` is copied before this runs, and
   * shadowing costs zero code.
   */
  test("keeps a file the author already supplied", () => {
    const out = mkdtempSync(join(tmpdir(), "jx-wk-keep-"));
    try {
      const { skipped, written } = writeWellKnown(
        [{ content: "generated\n", path: "manifest.webmanifest" }],
        out,
        () => true,
      );
      expect(written).toBe(0);
      expect(skipped).toEqual(["manifest.webmanifest"]);
    } finally {
      rmSync(out, { force: true, recursive: true });
    }
  });
});
