/**
 * Link relation checking (RFC 8288 §2.1): which `rel` values are recognized, which are reported,
 * and — the part that decides whether this is useful or noise — which are deliberately not.
 */
import { describe, expect, test } from "bun:test";
import {
  IANA_LINK_RELATIONS,
  unregisteredHeadRelations,
  unregisteredRelations,
} from "../src/site/link-relations.ts";

describe("unregisteredRelations", () => {
  test("registered relations are recognized", () => {
    for (const rel of [
      "canonical",
      "stylesheet",
      "alternate",
      "icon",
      "manifest",
      "preconnect",
      "modulepreload",
      "apple-touch-icon",
      "mask-icon",
      "license",
      "search",
    ]) {
      expect(unregisteredRelations(rel)).toEqual([]);
    }
  });

  /*
   * The whole reason this check exists. Every one of these produces valid HTML that renders and
   * silently does nothing — no console error, no visual difference, no other check in the build
   * that would catch it.
   */
  test("a typo is reported", () => {
    expect(unregisteredRelations("stylshet")).toEqual(["stylshet"]);
    expect(unregisteredRelations("canonicial")).toEqual(["canonicial"]);
    expect(unregisteredRelations("alternative")).toEqual(["alternative"]);
  });

  test("rel is a space-separated set, judged token by token", () => {
    expect(unregisteredRelations("noopener noreferrer")).toEqual([]);
    expect(unregisteredRelations("shortcut icon")).toEqual([]);
    expect(unregisteredRelations("stylesheet nonsense")).toEqual(["nonsense"]);
    expect(unregisteredRelations("  next   nixt  ")).toEqual(["nixt"]);
  });

  // The HTML Standard matches link types ASCII-case-insensitively.
  test("comparison is case-insensitive", () => {
    expect(unregisteredRelations("Canonical")).toEqual([]);
    expect(unregisteredRelations("STYLESHEET")).toEqual([]);
  });

  /*
   * RFC 8288 §2.1.2: a relation the registry does not carry is expressed as an absolute URI. Any
   * check that rejected these would be wrong about the one mechanism the standard provides for
   * saying something it did not anticipate.
   */
  test("extension relation types are accepted", () => {
    expect(unregisteredRelations("https://example.com/rel/thing")).toEqual([]);
    expect(unregisteredRelations("http://ns.example/vocab#feed")).toEqual([]);
    expect(unregisteredRelations("stylesheet https://example.com/rel/x")).toEqual([]);
  });

  // A registered name can never contain a colon, so the URI escape hatch cannot swallow a typo.
  test("something colon-shaped but unparseable is still reported", () => {
    expect(unregisteredRelations("canonical:")).toEqual(["canonical:"]);
    expect(unregisteredRelations("://nope")).toEqual(["://nope"]);
  });

  test("an absent or non-string rel reports nothing", () => {
    expect(unregisteredRelations(({} as { rel?: string }).rel)).toEqual([]);
    expect(unregisteredRelations(null)).toEqual([]);
    expect(unregisteredRelations(42)).toEqual([]);
    expect(unregisteredRelations("")).toEqual([]);
    expect(unregisteredRelations("   ")).toEqual([]);
  });
});

describe("IANA_LINK_RELATIONS", () => {
  /*
   * Provenance, asserted rather than trusted: these are relations that could not plausibly be
   * written from memory and are not the ones Jx itself emits, so their presence is evidence the
   * snapshot came off the registry CSV rather than out of somebody's head.
   */
  test("is the registry, not a hand-written shortlist", () => {
    expect(IANA_LINK_RELATIONS.size).toBeGreaterThan(120);
    for (const obscure of [
      "intervaloverlappedby",
      "sip-trunking-capability",
      "openid2.local_id",
      "rdap-bottom",
      "convertedfrom",
      "p3pv1",
    ]) {
      expect(IANA_LINK_RELATIONS.has(obscure)).toBe(true);
    }
  });

  test("holds every relation the build itself emits", () => {
    // Everything site-build, head-merger, feeds and the manifest phase put in a `rel`.
    for (const emitted of [
      "canonical",
      "alternate",
      "stylesheet",
      "icon",
      "manifest",
      "preconnect",
      "modulepreload",
      "preload",
      "next",
      "prev",
    ]) {
      expect(IANA_LINK_RELATIONS.has(emitted)).toBe(true);
    }
  });

  test("is lower-case throughout, since lookups are", () => {
    for (const name of IANA_LINK_RELATIONS) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe("unregisteredHeadRelations", () => {
  test("reads only link entries, and deduplicates across them", () => {
    const entries = [
      { attributes: { href: "/a.css", rel: "stylshet" }, tagName: "link" },
      { attributes: { href: "/b.css", rel: "stylshet" }, tagName: "link" },
      { attributes: { href: "/", rel: "canonical" }, tagName: "link" },
      // Not a <link>: `rel` on an <a> or a <meta> is not this function's business.
      { attributes: { rel: "made-up" }, tagName: "meta" },
      { tagName: "title" },
    ];
    expect(unregisteredHeadRelations(entries)).toEqual(["stylshet"]);
  });

  test("a clean head reports nothing", () => {
    expect(
      unregisteredHeadRelations([
        { attributes: { href: "/", rel: "canonical" }, tagName: "link" },
        { attributes: { href: "/fr/", hreflang: "fr", rel: "alternate" }, tagName: "link" },
        { attributes: { href: "/app.webmanifest", rel: "manifest" }, tagName: "link" },
      ]),
    ).toEqual([]);
  });

  test("a link with no rel at all is not a finding", () => {
    expect(unregisteredHeadRelations([{ attributes: { href: "/x" }, tagName: "link" }])).toEqual(
      [],
    );
    expect(unregisteredHeadRelations([{ tagName: "link" }])).toEqual([]);
  });
});
