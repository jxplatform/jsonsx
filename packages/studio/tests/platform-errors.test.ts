/**
 * Reading a structured platform failure, from either shape a backend may send.
 *
 * The reconciliation this file pins: **a problem's `type` IS the code.** A backend answering `type:
 * ".../needs-installation-access"` says exactly what `code: "needs_installation_access"` said, so
 * every surface above this module keeps branching on `code` without knowing which shape arrived.
 * Getting that wrong would not throw — it would silently stop rendering the install link, and the
 * user would see flattened text with no way forward.
 */

import { describe, expect, test } from "bun:test";
import { installUrlOf, platformErrorInfo } from "../src/platform-errors";

const INSTALL_URL = "https://github.com/apps/jx/installations/new";

describe("platformErrorInfo", () => {
  test("derives the code from a problem type", () => {
    const error = Object.assign(new Error("blocked"), {
      installUrl: INSTALL_URL,
      type: "https://jxsuite.com/problems/needs-installation-access",
    });
    expect(platformErrorInfo(error)).toEqual({
      code: "needs-installation-access",
      installUrl: INSTALL_URL,
    });
  });

  /*
   * The two spellings exist because the type is a URI path segment and the code was a JS-ish
   * identifier. Normalizing one to the other is what lets a migrated and an unmigrated backend
   * reach the same branch, which is the whole point of keeping both readable for a release.
   */
  test("normalizes a legacy underscored code to the same slug", () => {
    const error = Object.assign(new Error("blocked"), {
      code: "needs_installation_access",
      installUrl: INSTALL_URL,
    });
    expect(platformErrorInfo(error).code).toBe("needs-installation-access");
  });

  test("a problem type wins over a legacy code", () => {
    const error = Object.assign(new Error("blocked"), {
      code: "something_else",
      type: "https://jxsuite.com/problems/forbidden",
    });
    expect(platformErrorInfo(error).code).toBe("forbidden");
  });

  // A `type` that is not one of ours says nothing about a Jx problem.
  test("ignores a type outside the Jx namespace", () => {
    const error = Object.assign(new Error("x"), { type: "https://example.com/errors/other" });
    expect(platformErrorInfo(error)).toEqual({});
  });

  test("an unstructured failure carries nothing", () => {
    expect(platformErrorInfo(new Error("plain"))).toEqual({});
    expect(platformErrorInfo("a string")).toEqual({});
    expect(platformErrorInfo(null)).toEqual({});
  });
});

describe("installUrlOf", () => {
  test("answers for either shape, and only with a URL to offer", () => {
    const shapes = [
      { installUrl: INSTALL_URL, type: "https://jxsuite.com/problems/needs-installation-access" },
      { code: "needs_installation_access", installUrl: INSTALL_URL },
    ];
    for (const structured of shapes) {
      const error = Object.assign(new Error("blocked"), structured);
      expect(installUrlOf(error)).toBe(INSTALL_URL);
    }

    // The right code with no URL is not an offer.
    const noUrl = Object.assign(new Error("blocked"), { code: "needs_installation_access" });
    expect(installUrlOf(noUrl)).toBeNull();

    // A different failure never renders an install link, however it is spelled.
    const otherFailure = Object.assign(new Error("nope"), {
      installUrl: INSTALL_URL,
      type: "https://jxsuite.com/problems/forbidden",
    });
    expect(installUrlOf(otherFailure)).toBeNull();
  });
});
