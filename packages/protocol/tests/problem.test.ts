/**
 * The problem contract: the document shape, the type registry, and the one reader.
 *
 * Two properties are worth more than the rest and are asserted directly rather than implied:
 * `detail` and `title` are never conflated (the standard's most common misuse, and the reason a
 * client cannot group failures), and the deprecated `error` alias is written from exactly one place
 * so deleting it is a one-line change rather than a search.
 */

import { describe, expect, test } from "bun:test";
import {
  PROBLEM_MEDIA_TYPE,
  PROBLEM_TYPE_BASE,
  isProblemDetails,
  problemDetail,
  problemMessage,
  problemSlug,
} from "../src/problem";
import { PROBLEM_TYPES, problemDetails, problemTypeByUri } from "../src/problems";

describe("the problem document", () => {
  test("carries type, title and status, and repeats the status in the body", () => {
    const body = problemDetails("notFound", "No such file");
    expect(body.type).toBe("https://jxsuite.com/problems/not-found");
    expect(body.title).toBe(PROBLEM_TYPES.notFound.title);
    expect(body.status).toBe(404);
  });

  /*
   * `title` describes the TYPE and must not vary between occurrences; `detail` describes THIS one.
   * Conflating them is what stops a client grouping two failures that are the same problem.
   */
  test("title describes the type and does not vary; detail does", () => {
    const first = problemDetails("invalidRequest", "Missing path param");
    const second = problemDetails("invalidRequest", "Missing name");
    expect(first.title).toBe(second.title);
    expect(first.detail).not.toBe(second.detail);
  });

  test("emits the deprecated error alias equal to detail, and only when there is a detail", () => {
    expect(problemDetails("forbidden", "Nope").error).toBe("Nope");
    expect(problemDetails("forbidden")).not.toHaveProperty("error");
    expect(problemDetails("forbidden")).not.toHaveProperty("detail");
  });

  test("carries the extension members a type documents", () => {
    const body = problemDetails("needsInstallationAccess", "Install the app", {
      installUrl: "https://example.test/install",
    });
    expect(body.installUrl).toBe("https://example.test/install");
    expect(PROBLEM_TYPES.needsInstallationAccess.extensions).toContain("installUrl");
  });

  // `instance` identifies one occurrence, and Jx has no per-occurrence resource to point at.
  test("never fabricates an instance", () => {
    expect(problemDetails("internalError", "boom")).not.toHaveProperty("instance");
  });
});

describe("PROBLEM_TYPES", () => {
  test("every type URI is absolute and inside the Jx namespace", () => {
    for (const declared of Object.values(PROBLEM_TYPES)) {
      expect(declared.type.startsWith(PROBLEM_TYPE_BASE)).toBe(true);
      expect(() => new URL(declared.type)).not.toThrow();
    }
  });

  test("every type URI is unique", () => {
    const uris = Object.values(PROBLEM_TYPES).map((d) => d.type);
    expect(new Set(uris).size).toBe(uris.length);
  });

  test("every status is a real failure status", () => {
    for (const declared of Object.values(PROBLEM_TYPES)) {
      expect(declared.status).toBeGreaterThanOrEqual(400);
      expect(declared.status).toBeLessThan(600);
    }
  });

  /*
   * 401 and 403 ask the client for different things — "authenticate and try again" versus "no" —
   * so a missing API key must not be indistinguishable from a refused project root.
   */
  test("unauthorized and forbidden are separate types at separate statuses", () => {
    expect(PROBLEM_TYPES.unauthorized.status).toBe(401);
    expect(PROBLEM_TYPES.forbidden.status).toBe(403);
    expect(PROBLEM_TYPES.unauthorized.type).not.toBe(PROBLEM_TYPES.forbidden.type);
  });

  test("problemTypeByUri round-trips, and refuses a foreign URI", () => {
    expect(problemTypeByUri(PROBLEM_TYPES.conflict.type)).toEqual(PROBLEM_TYPES.conflict);
    expect(problemTypeByUri("https://example.com/errors/other")).toBeNull();
    expect(problemTypeByUri(42)).toBeNull();
  });
});

describe("problemSlug", () => {
  test("is the last segment of a Jx type URI", () => {
    expect(problemSlug(PROBLEM_TYPES.needsInstallationAccess.type)).toBe(
      "needs-installation-access",
    );
  });

  test("is null for anything else", () => {
    expect(problemSlug("https://example.com/errors/x")).toBeNull();
    expect(problemSlug(PROBLEM_TYPE_BASE)).toBeNull();
    expect(problemSlug(null)).toBeNull();
  });
});

describe("isProblemDetails", () => {
  test("needs both a type and a status", () => {
    expect(isProblemDetails(problemDetails("notFound"))).toBe(true);
    expect(isProblemDetails({ status: 404 })).toBe(false);
    expect(isProblemDetails({ type: "x" })).toBe(false);
    expect(isProblemDetails(null)).toBe(false);
  });
});

/*
 * The reader that replaced five. Each case below is a shape some Jx backend actually sent, and the
 * defect it fixes is not a wrong message — it is an EMPTY one, because the reader that ran was not
 * the one for the shape that arrived.
 */
describe("problemDetail — one reader for every shape", () => {
  test("reads a problem document's detail", () => {
    expect(problemDetail(problemDetails("notFound", "No such file"))).toBe("No such file");
  });

  test("reads the pre-RFC-9457 body", () => {
    expect(problemDetail({ error: "Failed to list connections" })).toBe(
      "Failed to list connections",
    );
  });

  // A `title` describes the type, so it is the answer only when there is no `detail`.
  test("falls back to the title, but never over a detail", () => {
    expect(problemDetail({ status: 404, title: "Not here", type: "x" })).toBe("Not here");
    expect(problemDetail({ detail: "This one", title: "The type" })).toBe("This one");
  });

  test("reads a bare text body", () => {
    expect(problemDetail("Upgrade failed")).toBe("Upgrade failed");
  });

  test("answers null when a body says nothing, so a caller can use its own words", () => {
    expect(problemDetail({})).toBeNull();
    expect(problemDetail({ error: "   " })).toBeNull();
    expect(problemDetail(null)).toBeNull();
    expect(problemDetail(42)).toBeNull();
    expect(problemDetail("")).toBeNull();
  });
});

describe("problemMessage", () => {
  test("is problemDetail with a generic fallback", () => {
    expect(problemMessage({ detail: "Boom" })).toBe("Boom");
    expect(problemMessage({}, 500)).toBe("Request failed (500)");
    expect(problemMessage({})).toBe("Request failed");
  });
});

describe("the media type", () => {
  test("is the one RFC 9457 registers", () => {
    expect(PROBLEM_MEDIA_TYPE).toBe("application/problem+json");
  });
});
