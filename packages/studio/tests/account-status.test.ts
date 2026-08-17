/**
 * Tests for src/account-status.ts — the synchronous render cache over the optional
 * `platform.getAccountStatus` PAL member, and src/platform-errors.ts — structured platform-error
 * recovery (the needs_installation_access install link).
 */
import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  getAccountStatus,
  getRepoAccessLinks,
  hydrateAccountStatus,
  needsAppInstall,
  resetAccountStatus,
} from "../src/account-status";
import { installUrlOf, platformErrorInfo } from "../src/platform-errors";

const INSTALL_URL = "https://github.com/apps/jx-suite/installations/new";

beforeEach(() => {
  resetAccountStatus();
});

describe("account-status cache", () => {
  test("hydrates from the platform and reports needsAppInstall on empty coverage", async () => {
    installMockPlatform({
      getAccountStatus: () => Promise.resolve({ appInstallUrl: INSTALL_URL, installations: [] }),
    });
    expect(getAccountStatus()).toBeNull();
    expect(needsAppInstall()).toBe(false);
    await hydrateAccountStatus();
    expect(getAccountStatus()?.appInstallUrl).toBe(INSTALL_URL);
    expect(needsAppInstall()).toBe(true);
  });

  test("an existing installation means no prompt", async () => {
    installMockPlatform({
      getAccountStatus: () =>
        Promise.resolve({
          appInstallUrl: INSTALL_URL,
          installations: [{ account: "octocat", id: 7 }],
        }),
    });
    await hydrateAccountStatus();
    expect(needsAppInstall()).toBe(false);
  });

  test("no install URL means no prompt even with zero installations", async () => {
    installMockPlatform({ getAccountStatus: () => Promise.resolve({ installations: [] }) });
    await hydrateAccountStatus();
    expect(needsAppInstall()).toBe(false);
  });

  test("unsupported platforms and failures resolve to unknown (null, never nags)", async () => {
    installMockPlatform();
    await hydrateAccountStatus();
    expect(getAccountStatus()).toBeNull();

    installMockPlatform({ getAccountStatus: () => Promise.reject(new Error("offline")) });
    await hydrateAccountStatus();
    expect(getAccountStatus()).toBeNull();
    expect(needsAppInstall()).toBe(false);
  });
});

describe("getRepoAccessLinks", () => {
  test("one manage link per installation that reports one, plus the install URL", async () => {
    installMockPlatform({
      getAccountStatus: () =>
        Promise.resolve({
          appInstallUrl: INSTALL_URL,
          installations: [
            { account: "octocat", id: 7, manageUrl: "https://github.com/settings/installations/7" },
            // No manageUrl: not linkable, so it contributes nothing.
            { account: "acme", id: 8 },
            {
              account: null,
              id: 9,
              manageUrl: "https://github.com/organizations/globex/settings/installations/9",
            },
          ],
        }),
    });
    await hydrateAccountStatus();
    expect(getRepoAccessLinks()).toEqual({
      manage: [
        { account: "octocat", url: "https://github.com/settings/installations/7" },
        {
          account: "Installation 9",
          url: "https://github.com/organizations/globex/settings/installations/9",
        },
      ],
      installUrl: INSTALL_URL,
    });
  });

  test("the install URL alone still offers a way to widen access", async () => {
    installMockPlatform({
      getAccountStatus: () =>
        Promise.resolve({ appInstallUrl: INSTALL_URL, installations: [{ account: "a", id: 1 }] }),
    });
    await hydrateAccountStatus();
    expect(getRepoAccessLinks()).toEqual({ manage: [], installUrl: INSTALL_URL });
  });

  test("unknown status, or nothing linkable, means no affordance at all", async () => {
    installMockPlatform();
    await hydrateAccountStatus();
    expect(getRepoAccessLinks()).toBeNull();

    installMockPlatform({
      getAccountStatus: () => Promise.resolve({ installations: [{ account: "a", id: 1 }] }),
    });
    await hydrateAccountStatus();
    expect(getRepoAccessLinks()).toBeNull();
  });
});

describe("platform-errors", () => {
  test("recovers structured fields from an augmented Error", () => {
    const error = Object.assign(new Error("blocked"), {
      code: "needs_installation_access",
      installUrl: INSTALL_URL,
    });
    // The underscored legacy code and the hyphenated problem-type slug are one code; normalizing
    // Is what lets a migrated and an unmigrated backend reach the same branch below.
    expect(platformErrorInfo(error)).toEqual({
      code: "needs-installation-access",
      installUrl: INSTALL_URL,
    });
    expect(installUrlOf(error)).toBe(INSTALL_URL);
  });

  test("plain errors and non-errors carry nothing", () => {
    expect(platformErrorInfo(new Error("boom"))).toEqual({});
    expect(platformErrorInfo("boom")).toEqual({});
    expect(platformErrorInfo(null)).toEqual({});
    expect(installUrlOf(new Error("boom"))).toBeNull();
    // A different structured code is not the install case.
    const otherCode = Object.assign(new Error("x"), { code: "other", installUrl: "u" });
    expect(installUrlOf(otherCode)).toBeNull();
  });
});
