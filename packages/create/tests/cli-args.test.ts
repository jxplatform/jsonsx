import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../cli-args";

describe("parseCliArgs", () => {
  test("takes the first non-flag argument as the destination", () => {
    expect(parseCliArgs(["my-site"])).toEqual({ dest: "my-site" });
  });

  test("reads --template <id> as a separate argument", () => {
    expect(parseCliArgs(["my-site", "--template", "restaurant"])).toEqual({
      dest: "my-site",
      template: "restaurant",
    });
  });

  test("reads the --template=<id> inline form", () => {
    expect(parseCliArgs(["--template=blog", "my-site"])).toEqual({
      dest: "my-site",
      template: "blog",
    });
  });

  test("returns an empty object when no destination is given", () => {
    expect(parseCliArgs([])).toEqual({});
    expect(parseCliArgs(["--template", "restaurant"])).toEqual({ template: "restaurant" });
  });
});
