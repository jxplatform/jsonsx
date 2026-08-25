/**
 * Preferences › Accounts, as data (src/settings/preferences-accounts.ts).
 *
 * The point of this module is that Studio can finally ENUMERATE and FORGET the three credentials it
 * holds. `clearGithubToken()` had zero callers before it; the Cloudflare token had no clear path at
 * all. Those are the assertions here — plus the one that matters most: no record ever carries the
 * secret it describes.
 */
import "./with-dom.js";
import { clearSeededSettings, seedSettings } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  listAccounts,
  notifyCredentialsChanged,
  onCredentialsChanged,
  resetCredentialListeners,
  revokeAccount,
} from "../src/settings/preferences-accounts";

const GITHUB_TOKEN = "gho_secretsecretsecret";
const AI_KEY = "sk-secretsecretsecret";
const CF_TOKEN = "cf_secretsecretsecret";

function connectEverything(): void {
  localStorage.setItem("jx_github_token", GITHUB_TOKEN);
  seedSettings({
    "jx.ai.openaiKey": AI_KEY,
    "jx.ai.model": "gpt-4o-mini",
    "jx.ai.baseUrl": "http://localhost:11434/v1",
    "jx.cf.token": CF_TOKEN,
    "jx.cf.accountId": "acc-1",
  });
}

function byId(id: string) {
  return listAccounts().find((account) => account.id === id);
}

beforeEach(() => {
  localStorage.clear();
  clearSeededSettings();
  resetCredentialListeners();
});

describe("listAccounts", () => {
  test("lists all three, connected or not — absence is information too", () => {
    expect(listAccounts().map((account) => account.id)).toEqual(["github", "ai", "cloudflare"]);
    expect(listAccounts().every((account) => account.connected)).toBe(false);
    for (const account of listAccounts()) {
      expect(account.detail).toBeTruthy();
    }
  });

  test("reports what is stored once each one is connected", () => {
    connectEverything();
    expect(listAccounts().every((account) => account.connected)).toBe(true);
    expect(byId("ai")!.detail).toContain("gpt-4o-mini");
    expect(byId("ai")!.detail).toContain("http://localhost:11434/v1");
    expect(byId("cloudflare")!.detail).toContain("acc-1");
  });

  test("never returns the secret itself", () => {
    connectEverything();
    const printed = listAccounts()
      .map((account) => `${account.label} ${account.detail}`)
      .join(" ");
    for (const secret of [GITHUB_TOKEN, AI_KEY, CF_TOKEN]) {
      expect(printed).not.toContain(secret);
    }
  });

  test("an AI key with no endpoint override says so without an empty ' via '", () => {
    seedSettings({ "jx.ai.openaiKey": AI_KEY });
    expect(byId("ai")!.detail).not.toContain("via");
  });

  test("a Cloudflare token with no account id still reads as connected", () => {
    seedSettings({ "jx.cf.token": CF_TOKEN });
    expect(byId("cloudflare")!.detail).toBe("Connected.");
  });
});

describe("revokeAccount", () => {
  test("GitHub — the call `clearGithubToken` never had", () => {
    connectEverything();
    expect(revokeAccount("github")).toBe(true);
    expect(localStorage.getItem("jx_github_token")).toBeNull();
    expect(byId("github")!.connected).toBe(false);
    // Only GitHub: revoking one account must not sign you out of the others.
    expect(byId("ai")!.connected).toBe(true);
    expect(byId("cloudflare")!.connected).toBe(true);
  });

  test("the AI provider — key, endpoint and model all go", () => {
    connectEverything();
    expect(revokeAccount("ai")).toBe(true);
    expect(localStorage.getItem("jx.ai.openaiKey")).toBeNull();
    expect(localStorage.getItem("jx.ai.baseUrl")).toBeNull();
    expect(localStorage.getItem("jx.ai.model")).toBeNull();
  });

  test("Cloudflare — token and account id together", () => {
    connectEverything();
    expect(revokeAccount("cloudflare")).toBe(true);
    expect(localStorage.getItem("jx.cf.token")).toBeNull();
    expect(localStorage.getItem("jx.cf.accountId")).toBeNull();
  });

  test("revoking a disconnected account is a no-op, not an error", () => {
    expect(revokeAccount("github")).toBe(true);
    expect(byId("github")!.connected).toBe(false);
  });

  test("an unknown id reports false rather than silently doing nothing", () => {
    expect(revokeAccount("bitbucket")).toBe(false);
  });
});

describe("the credentials-changed seam", () => {
  test("a revoke announces itself, and unsubscribing stops it", () => {
    const listener = mock(() => {});
    const off = onCredentialsChanged(listener);
    revokeAccount("ai");
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    revokeAccount("ai");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("notify reaches every subscriber", () => {
    const one = mock(() => {});
    const two = mock(() => {});
    onCredentialsChanged(one);
    onCredentialsChanged(two);
    notifyCredentialsChanged();
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });
});
