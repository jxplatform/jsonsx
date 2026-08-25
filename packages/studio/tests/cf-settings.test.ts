/**
 * Cf-settings: localStorage-backed Cloudflare token/account persistence for platforms without a
 * hosted OAuth broker.
 */
import { clearSeededSettings, installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";

const { clearCfConnection, getCfAccountId, getCfToken, setCfAccountId, setCfToken } =
  await import("../src/services/cf-settings");

beforeEach(() => {
  installMockPlatform();
  clearSeededSettings();
  localStorage.clear();
});

describe("cf token", () => {
  test("round-trips through localStorage", () => {
    expect(getCfToken()).toBe("");
    setCfToken("cf_secret");
    expect(getCfToken()).toBe("cf_secret");
    expect(localStorage.getItem("jx.cf.token")).toBe("cf_secret");
  });

  test("whitespace is trimmed, and a blank value stores blank rather than clearing", () => {
    setCfToken("  padded  ");
    expect(getCfToken()).toBe("padded");
    setCfToken("   ");
    expect(getCfToken()).toBe("");
    /* Stored, not removed. Blank used to mean DELETE across every credential setter, which read as
       a convenience until a form rendered an empty field into one. clearCfConnection is the only
       thing that forgets. */
    expect(localStorage.getItem("jx.cf.token")).toBe("");
  });

  test("clearCfConnection forgets the token and the account together", () => {
    setCfToken("cf_secret");
    setCfAccountId("0123456789abcdef0123456789abcdef");
    clearCfConnection();
    expect(getCfToken()).toBe("");
    expect(getCfAccountId()).toBe("");
    expect(localStorage.getItem("jx.cf.token")).toBeNull();
    expect(localStorage.getItem("jx.cf.accountId")).toBeNull();
  });
});

describe("cf account id", () => {
  test("round-trips and blanks independently of the token", () => {
    setCfToken("cf_secret");
    setCfAccountId("0123456789abcdef0123456789abcdef");
    expect(getCfAccountId()).toBe("0123456789abcdef0123456789abcdef");
    setCfAccountId("");
    expect(getCfAccountId()).toBe("");
    expect(getCfToken()).toBe("cf_secret");
  });
});
