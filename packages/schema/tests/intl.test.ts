/**
 * The blessed-Intl list, and the two things that used to drift from it: the runtime's allow-set and
 * the `call` operator's JSON-Schema description.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FORMAT_LOCALE,
  DEFAULT_TIME_ZONE,
  INTL_HELPER_PATHS,
  INTL_HELPERS,
  intlHelpersClause,
} from "../src/intl.ts";
import { expressionNodeSchema } from "../defs/expression-node.schema.ts";

describe("INTL_HELPERS", () => {
  test("every helper names a path, an API, params and a summary", () => {
    for (const helper of INTL_HELPERS) {
      expect(helper.path).toStartWith("Intl/");
      expect(helper.api).toStartWith("Intl.");
      expect(helper.params.length).toBeGreaterThan(0);
      expect(helper.summary.length).toBeGreaterThan(10);
    }
    expect(new Set(INTL_HELPER_PATHS).size).toBe(INTL_HELPERS.length);
  });

  test("DurationFormat is deliberately absent", () => {
    // A blessed global that throws on a browser Jx claims to support is worse than its absence.
    expect(INTL_HELPER_PATHS).not.toContain("Intl/DurationFormat");
    expect(INTL_HELPER_PATHS.some((path) => path.includes("Duration"))).toBe(false);
  });

  test("the formatting defaults are fixed values, not the host's", () => {
    expect(DEFAULT_FORMAT_LOCALE).toBe("en-US");
    expect(DEFAULT_TIME_ZONE).toBe("UTC");
  });
});

describe("the JSON-Schema description", () => {
  test("names every helper, and is generated rather than typed out", () => {
    /*
     * This is the drift the shared list exists to stop: the description used to enumerate three
     * helpers by hand, with nothing checking it, so a fourth could ship while the schema went on
     * telling authors it did not exist.
     */
    const branches = expressionNodeSchema.oneOf as readonly {
      description?: string;
      title?: string;
    }[];
    const call = branches.find((branch) => branch.title?.startsWith("call —"));
    expect(call?.description).toBeString();
    for (const path of INTL_HELPER_PATHS) {
      expect(call!.description).toContain(path);
    }
    expect(call!.description).toContain(intlHelpersClause());
  });
});
