/**
 * Preferences › Accounts, as data (src/settings/preferences-accounts.ts).
 *
 * The point of this module is that Studio can finally ENUMERATE and FORGET the three credentials it
 * holds. `clearGithubToken()` had zero callers before it; the Cloudflare token had no clear path at
 * all. Those are the assertions here — plus the one that matters most: no record ever carries the
 * secret it describes.
 */
import "./with-dom.js";
import { clearSeededSettings, flush, installMockPlatform, seedSettings } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CfConnection, StudioPlatform } from "../src/types";

/**
 * The picker is doubled: the Choose account action reaches it through a lazy `import()` (the static
 * one would close a cycle — the picker imports this module for `notifyCredentialsChanged`), so a
 * double is both the witness that it opened and the way two real imports never overlap.
 */
let pickerOpens = 0;
let pickerResult: { id: string; name: string } | null = { id: "acc-2", name: "Acme" };
void mock.module("../src/ui/cf-account-picker", () => ({
  openCfAccountPicker: async () => {
    pickerOpens += 1;
    return pickerResult;
  },
}));

const {
  ensureCfConnection,
  listAccounts,
  notifyCredentialsChanged,
  onCredentialsChanged,
  platformBrokersCf,
  refreshCfConnection,
  resetCfConnectionCache,
  resetCredentialListeners,
  revokeAccount,
} = await import("../src/settings/preferences-accounts");

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

/**
 * The Cloudflare row has two spellings, and this file used to know only one.
 *
 * Under hosted OAuth there is no local token to enumerate — `getCfToken()` is empty by design — so
 * the row said "Not connected" to every Jx Cloud user, named no account, and offered a Disconnect
 * that cleared nothing server-side. There was no reconnect entry point anywhere in Preferences.
 */
describe("the brokered Cloudflare row", () => {
  function install(connection: CfConnection | null, extra: Partial<StudioPlatform> = {}) {
    return installMockPlatform({
      cfConnect: async () => ({
        connection: connection ?? { connected: true },
        status: "connected",
      }),
      cfConnection: async () => connection,
      ...extra,
    });
  }

  function cloudflare() {
    return listAccounts().find((account) => account.id === "cloudflare")!;
  }

  /** Run one of the row's own actions and let its async work settle. */
  async function act(id: string): Promise<void> {
    const action = cloudflare().actions?.find((candidate) => candidate.id === id);
    expect(action).toBeTruthy();
    await action!.run();
    await flush();
  }

  beforeEach(() => {
    pickerOpens = 0;
    pickerResult = { id: "acc-2", name: "Acme" };
    resetCfConnectionCache();
  });

  test("says it is checking before the broker has answered, and offers nothing yet", () => {
    install({ accountId: "acc-1", accountName: "Acme", connected: true });
    expect(platformBrokersCf()).toBe(true);
    expect(cloudflare().detail).toContain("Checking");
    expect(cloudflare().actions).toEqual([]);
  });

  test("names the connected account once the broker answers", async () => {
    install({ accountId: "acc-1", accountName: "Acme", connected: true });
    const announced = mock(() => {});
    onCredentialsChanged(announced);
    ensureCfConnection();
    await flush();
    expect(cloudflare().connected).toBe(true);
    expect(cloudflare().detail).toContain("Acme");
    // A repaint of every surface that shows the connection, not just this list.
    expect(announced).toHaveBeenCalled();
    expect(cloudflare().actions?.map((action) => action.id)).toEqual(["disconnect"]);
  });

  test("Disconnect goes through the broker, and the row re-reads what it said", async () => {
    let connection: CfConnection | null = {
      accountId: "acc-1",
      accountName: "Acme",
      connected: true,
    };
    const cfDisconnect = mock(async () => {
      connection = null;
    });
    installMockPlatform({
      cfConnect: async () => ({ connection: { connected: true }, status: "connected" }),
      cfConnection: async () => connection,
      cfDisconnect,
    });
    await refreshCfConnection();
    await act("disconnect");
    expect(cfDisconnect).toHaveBeenCalledTimes(1);
    expect(cloudflare().connected).toBe(false);
    expect(cloudflare().detail).toContain("Not connected");
  });

  test("a lapsed grant offers Reconnect, and says what expiring costs", async () => {
    let connection: CfConnection = {
      accountId: "acc-1",
      code: "cf_reconnect_required",
      connected: true,
      needsReconnect: true,
    };
    const cfConnect = mock(async () => {
      connection = { accountId: "acc-1", accountName: "Acme", connected: true };
      return { connection, status: "connected" as const };
    });
    installMockPlatform({ cfConnect, cfConnection: async () => connection });
    await refreshCfConnection();
    expect(cloudflare().detail).toContain("expired");
    expect(cloudflare().actions?.map((action) => action.id)).toEqual(["reconnect", "disconnect"]);

    await act("reconnect");
    expect(cfConnect).toHaveBeenCalledTimes(1);
    expect(cloudflare().detail).toContain("Acme");
  });

  test("connected with no account chosen offers the picker, and commits what it returns", async () => {
    let connection: CfConnection = { connected: true, needsAccount: true };
    installMockPlatform({
      cfConnect: async () => ({ connection, status: "connected" }),
      cfConnection: async () => connection,
    });
    await refreshCfConnection();
    expect(cloudflare().connected).toBe(true);
    expect(cloudflare().detail).toContain("no account is chosen");
    expect(cloudflare().actions?.map((action) => action.id)).toEqual([
      "choose-account",
      "disconnect",
    ]);

    connection = { accountId: "acc-2", accountName: "Acme", connected: true };
    await act("choose-account");
    expect(pickerOpens).toBe(1);
    expect(cloudflare().detail).toContain("Acme");
  });

  test("a connect that lands account-less opens the picker before the row settles", async () => {
    let connection: CfConnection | null = null;
    installMockPlatform({
      cfConnect: async () => {
        connection = { accountId: "acc-2", accountName: "Acme", connected: true };
        return { connection: { connected: true }, status: "connected" as const };
      },
      cfConnection: async () => connection,
    });
    await refreshCfConnection();
    await act("connect");
    expect(pickerOpens).toBe(1);
    expect(cloudflare().detail).toContain("Acme");
  });

  test("revokeAccount reaches the broker too — one verb, whoever holds the credential", async () => {
    let connection: CfConnection | null = { accountId: "acc-1", connected: true };
    const cfDisconnect = mock(async () => {
      connection = null;
    });
    installMockPlatform({
      cfConnect: async () => ({ connection: { connected: true }, status: "connected" }),
      cfConnection: async () => connection,
      cfDisconnect,
    });
    await refreshCfConnection();
    expect(revokeAccount("cloudflare")).toBe(true);
    await flush();
    expect(cfDisconnect).toHaveBeenCalledTimes(1);
  });

  test("revoking a connection the broker never confirmed is inert, not an error", async () => {
    const cfDisconnect = mock(async () => {});
    installMockPlatform({
      cfConnect: async () => ({ connection: { connected: true }, status: "connected" }),
      cfConnection: async () => null,
      cfDisconnect,
    });
    // Still "checking": nothing has been read, so there is nothing to forget.
    expect(revokeAccount("cloudflare")).toBe(true);
    await refreshCfConnection();
    expect(revokeAccount("cloudflare")).toBe(true);
    await flush();
    expect(cfDisconnect).not.toHaveBeenCalled();
  });

  test("an unreachable broker reads as not connected rather than throwing at the sheet", async () => {
    installMockPlatform({
      cfConnect: async () => ({ connection: { connected: true }, status: "connected" }),
      cfConnection: async () => {
        throw new Error("network down");
      },
    });
    await refreshCfConnection();
    expect(cloudflare().connected).toBe(false);
    expect(cloudflare().detail).toContain("Not connected");
  });

  test("a platform with no broker keeps the locally stored token row, unchanged", async () => {
    installMockPlatform();
    resetCfConnectionCache();
    expect(platformBrokersCf()).toBe(false);
    seedSettings({ "jx.cf.token": CF_TOKEN, "jx.cf.accountId": "acc-1" });
    expect(cloudflare().connected).toBe(true);
    expect(cloudflare().detail).toBe("Connected — account acc-1.");
    expect(cloudflare().actions).toBeUndefined();
    // And refreshing is inert rather than an error: there is no broker to ask.
    await refreshCfConnection();
    expect(cloudflare().detail).toBe("Connected — account acc-1.");
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
