/**
 * Tests for src/ui/cf-account-picker.ts — "which Cloudflare account?", the question nothing in
 * Studio asked.
 *
 * The state this closes: a grant that reaches several accounts leaves the broker with no account id
 * stored, every Cloudflare-backed call answering `cf_account_required`, and a UI that reads as
 * connected. `/cf/accounts` and `/cf/select-account` had existed the whole time with no caller.
 */
import { flush, installMockPlatform } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const { openCfAccountPicker } = await import("../src/ui/cf-account-picker");
const { initLayers } = await import("../src/ui/layers");
const { onCredentialsChanged, resetCredentialListeners } =
  await import("../src/settings/preferences-accounts");

const ACCOUNTS = [
  { id: "acc-1", name: "Personal" },
  { id: "acc-2", name: "Acme Corp" },
];

function d<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector(`#layer-dialog ${sel}`) as T | null;
}

function row(id: string): HTMLElement | null {
  return d(`.prefs-account[data-account="${id}"]`);
}

/** The button inside one account's row, or the picker's single retry button. */
function button(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("#layer-dialog sp-button")].find((el) =>
      el.textContent?.includes(label),
    ) ?? null
  );
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = `<div id="layer-modal"></div><div id="layer-dialog"></div>`;
  initLayers();
  resetCredentialListeners();
});

describe("openCfAccountPicker", () => {
  test("lists what the grant reaches, and a pick commits it through the PAL", async () => {
    const cfSelectAccount = mock(async () => {});
    installMockPlatform({
      cfAccounts: async () => ACCOUNTS,
      cfSelectAccount,
    });
    const announced = mock(() => {});
    onCredentialsChanged(announced);

    const choice = openCfAccountPicker();
    await flush(3);
    expect(row("acc-1")?.textContent).toContain("Personal");
    // The id is shown beside the name: two accounts can share a name, and the id is what is stored.
    expect(row("acc-2")?.textContent).toContain("acc-2");

    click(row("acc-2")!.querySelector("sp-button")!);
    expect(await choice).toEqual({ id: "acc-2", name: "Acme Corp" });
    expect(cfSelectAccount).toHaveBeenCalledWith({ id: "acc-2", name: "Acme Corp" });
    // A chosen account is a credential change: the assistant gate and Preferences both re-read.
    expect(announced).toHaveBeenCalledTimes(1);
    await flush(2);
    expect(d(".cf-account-picker")).toBeNull();
  });

  test("dismissing resolves null — nothing was chosen and nothing was stored", async () => {
    const cfSelectAccount = mock(async () => {});
    installMockPlatform({ cfAccounts: async () => ACCOUNTS, cfSelectAccount });

    const choice = openCfAccountPicker();
    await flush(3);
    d("sp-dialog-wrapper")!.dispatchEvent(new Event("cancel", { bubbles: true }));
    expect(await choice).toBeNull();
    expect(cfSelectAccount).not.toHaveBeenCalled();
  });

  test("a failed listing says so and offers a retry that succeeds", async () => {
    let fail = true;
    installMockPlatform({
      cfAccounts: async () => {
        if (fail) {
          throw new Error("Cloudflare API: 502");
        }
        return ACCOUNTS;
      },
      cfSelectAccount: async () => {},
    });

    const choice = openCfAccountPicker();
    await flush(3);
    expect(d(".cf-account-picker")?.textContent).toContain("Cloudflare API: 502");
    expect(row("acc-1")).toBeNull();

    fail = false;
    click(button("Try again")!);
    await flush(3);
    expect(row("acc-1")).not.toBeNull();

    d("sp-dialog-wrapper")!.dispatchEvent(new Event("close", { bubbles: true }));
    expect(await choice).toBeNull();
  });

  test("a grant that reaches nothing is said out loud rather than shown as an empty list", async () => {
    installMockPlatform({ cfAccounts: async () => [], cfSelectAccount: async () => {} });
    const choice = openCfAccountPicker();
    await flush(3);
    expect(d(".cf-account-picker")?.textContent).toContain("reaches no accounts");
    d("sp-dialog-wrapper")!.dispatchEvent(new Event("cancel", { bubbles: true }));
    expect(await choice).toBeNull();
  });

  test("a refused commit keeps the dialog up with the reason", async () => {
    installMockPlatform({
      cfAccounts: async () => ACCOUNTS,
      cfSelectAccount: async () => {
        throw new Error("account is suspended");
      },
    });

    const choice = openCfAccountPicker();
    await flush(3);
    click(row("acc-1")!.querySelector("sp-button")!);
    await flush(3);
    expect(d(".cf-account-picker-error")?.textContent).toContain("account is suspended");
    // The list survives: listing again is not what would fix a refused commit.
    expect(row("acc-2")).not.toBeNull();
    d("sp-dialog-wrapper")!.dispatchEvent(new Event("cancel", { bubbles: true }));
    expect(await choice).toBeNull();
  });

  test("a platform that brokers nothing resolves null without opening anything", async () => {
    /* Desktop and the dev server hold a pasted API token and a local account field. Opening a
       picker over a PAL that cannot answer it would be a dialog with one honest state: empty. */
    installMockPlatform();
    expect(await openCfAccountPicker()).toBeNull();
    expect(d("sp-dialog-wrapper")).toBeNull();
  });
});
