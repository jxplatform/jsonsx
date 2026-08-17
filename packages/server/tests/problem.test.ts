/**
 * The server's failure responses, as the wire sees them.
 *
 * `packages/protocol` proves the document shape; this proves the response — status, media type, and
 * the compatibility alias that lets an unmigrated client keep working while the server moves.
 */

import { describe, expect, test } from "bun:test";
import { PROBLEM_TYPES } from "@jxsuite/protocol";
import { problem, problemTypeForStatus } from "../src/problem";

describe("problem()", () => {
  test("answers application/problem+json at the type's own status", async () => {
    const res = problem("notFound", "No such file");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({
      detail: "No such file",
      status: 404,
      type: "https://jxsuite.com/problems/not-found",
    });
  });

  /*
   * The whole sequencing unlock: every existing client reads `body.error`, so emitting both lets
   * the server land alone instead of in lockstep with ~160 client call sites.
   */
  test("carries the deprecated error alias equal to detail", async () => {
    const body = (await problem("invalidRequest", "Missing path param").json()) as {
      detail: string;
      error: string;
    };
    expect(body.error).toBe(body.detail);
  });

  test("carries the extension members a type documents", async () => {
    const res = problem("forbidden", "root not permitted", { ok: false });
    const body = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
  });

  // The status comes from the type: a type answerable with two statuses would be two types.
  test("the status is the type's, not the call site's", async () => {
    for (const [name, declared] of Object.entries(PROBLEM_TYPES)) {
      const res = problem(name as keyof typeof PROBLEM_TYPES, "x");
      expect({ name, status: res.status }).toEqual({ name, status: declared.status });
    }
  });
});

/*
 * Two files compute a status before they know the type — `data-api`'s `ApiError`, which predates the
 * registry, and `ai-api`, which forwards an upstream provider's status because collapsing it would
 * discard information. Everywhere else names the type directly.
 */
describe("problemTypeForStatus", () => {
  test("maps each status to a type that answers with that same status", () => {
    for (const status of [400, 401, 403, 404, 405, 409, 413, 500, 501, 502]) {
      const name = problemTypeForStatus(status);
      expect({ status, typeStatus: PROBLEM_TYPES[name].status }).toEqual({
        status,
        typeStatus: status,
      });
    }
  });

  // 401 and 403 must not collapse: one says "authenticate", the other says "no".
  test("keeps unauthorized and forbidden apart", () => {
    expect(problemTypeForStatus(401)).toBe("unauthorized");
    expect(problemTypeForStatus(403)).toBe("forbidden");
  });

  test("an unmapped status falls to the right side of the 4xx/5xx line", () => {
    expect(problemTypeForStatus(418)).toBe("invalidRequest");
    expect(problemTypeForStatus(507)).toBe("internalError");
    expect(problemTypeForStatus(503)).toBe("upstreamFailure");
  });
});
