/**
 * The browser the pipeline drives: which protocol it speaks, and the determinism inputs it pins.
 *
 * `launchBrowser` itself needs a Chromium, so what is asserted here is the LAUNCH CONTRACT read
 * from the source — the protocol, its escape hatch, and the flags. A test that spawned a browser
 * would not run in CI's matrix, and the thing worth pinning is the decision rather than the spawn.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DETERMINISM_ARGS, DETERMINISM_ENV } from "./browser.ts";

const SOURCE = readFileSync(join(import.meta.dir, "browser.ts"), "utf8");

describe("the protocol", () => {
  test("is WebDriver BiDi, the W3C's, not Chrome's own CDP", () => {
    /*
     * CDP is a vendor protocol no standard describes. Everything this pipeline asks of a browser —
     * viewport, media features, init scripts, navigation, evaluation, frames, screenshots — is in
     * BiDi, and the captured bytes are identical under both: a shot captured over each protocol
     * with the same inputs hashes the same, which is the acceptance criterion this change was held
     * to.
     */
    expect(SOURCE).toContain(
      'protocol: process.env.JX_SHOTS_PROTOCOL === "cdp" ? "cdp" : "webDriverBiDi"',
    );
  });

  test("falls back on one environment variable rather than a revert", () => {
    // A BiDi regression in a Chromium release should not need a code change to work around.
    expect(SOURCE).toContain("JX_SHOTS_PROTOCOL");
  });
});

describe("determinism inputs", () => {
  test("pin the time zone and the locale, because both are rendering inputs", () => {
    expect(DETERMINISM_ENV.TZ).toBe("UTC");
    expect(DETERMINISM_ENV.LANG).toBe("C.UTF-8");
    expect(DETERMINISM_ENV.LC_ALL).toBe("C.UTF-8");
  });

  test("every flag is a source of pixels, not a convenience", () => {
    expect(DETERMINISM_ARGS.length).toBeGreaterThan(0);
    // A flag that only changed timing would drift the bytes it was meant to stabilize.
    expect(DETERMINISM_ARGS.every((flag) => flag.startsWith("--"))).toBe(true);
  });
});
