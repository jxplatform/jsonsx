/**
 * Cf-settings: localStorage-backed Cloudflare token/account persistence for platforms without a
 * hosted OAuth broker.
 */
import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";

const { getCfAccountId, getCfToken, setCfAccountId, setCfToken } =
  await import("../src/services/cf-settings");

beforeEach(() => {
  installMockPlatform();
  localStorage.removeItem("jx.cf.token");
  localStorage.removeItem("jx.cf.accountId");
});

describe("cf token", () => {
  test("round-trips through localStorage", () => {
    expect(getCfToken()).toBe("");
    setCfToken("cf_secret");
    expect(getCfToken()).toBe("cf_secret");
    expect(localStorage.getItem("jx.cf.token")).toBe("cf_secret");
  });

  test("blank values clear the entry and whitespace is trimmed", () => {
    setCfToken("  padded  ");
    expect(getCfToken()).toBe("padded");
    setCfToken("   ");
    expect(getCfToken()).toBe("");
    expect(localStorage.getItem("jx.cf.token")).toBeNull();
  });
});

describe("cf account id", () => {
  test("round-trips and clears independently of the token", () => {
    setCfToken("cf_secret");
    setCfAccountId("0123456789abcdef0123456789abcdef");
    expect(getCfAccountId()).toBe("0123456789abcdef0123456789abcdef");
    setCfAccountId("");
    expect(getCfAccountId()).toBe("");
    expect(getCfToken()).toBe("cf_secret");
  });
});
