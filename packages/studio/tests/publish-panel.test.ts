/**
 * Publish panel tests: drives the modal through its states — unsupported platform, credential
 * collection (token form vs hosted connect), the create-and-connect form with validation, the
 * connected status view with refresh/disconnect, and the Pages-GitHub-App error hint.
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { DeployConfig } from "@jxsuite/schema/types";

const { openPublishPanel } = await import("../src/publish/publish-panel");
const { initLayers } = await import("../src/ui/layers");
const { setCfToken } = await import("../src/services/cf-settings");

document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

const DEPLOY: DeployConfig = {
  provider: "cloudflare-pages",
  accountId: "a".repeat(32),
  projectName: "my-site",
  productionUrl: "https://my-site.pages.dev",
};

function panel(): HTMLElement | null {
  return document.querySelector("#layer-modal .publish-modal");
}

function bodyText(): string {
  return panel()?.textContent?.replaceAll(/\s+/g, " ") ?? "";
}

function button(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll("#layer-modal sp-button")].find((b) =>
      b.textContent?.includes(label),
    ) ?? null
  );
}

function closePanel() {
  const closeBtn = document.querySelector("#layer-modal sp-action-button");
  if (closeBtn) {
    pointer(closeBtn as HTMLElement, "click");
  }
}

/** Marker for routes that should reject (keeps the Error-throw lint rules happy). */
interface ErrorRoute {
  __error: string;
}

function isErrorRoute(value: unknown): value is ErrorRoute {
  return typeof value === "object" && value !== null && "__error" in value;
}

/** CfApi answering from a path-keyed table; ErrorRoute values are rejected. */
function cfApiMock(routes: Record<string, unknown>) {
  // Longest needle wins: "/deployments" paths also contain "/accounts".
  const entries = Object.entries(routes).toSorted((a, b) => b[0].length - a[0].length);
  return mock(async (path: string) => {
    for (const [needle, response] of entries) {
      if (path.includes(needle)) {
        if (isErrorRoute(response)) {
          throw new Error(response.__error);
        }
        return response;
      }
    }
    throw new Error(`no route: ${path}`);
  });
}

afterEach(() => {
  closePanel();
  setCfToken("");
});

describe("openPublishPanel — platform capability states", () => {
  test("explains the git-push path when the platform lacks cfApi", async () => {
    resetStudioState({ projectConfig: { name: "My Site" } });
    installMockPlatform();
    openPublishPanel();
    await flush();
    expect(bodyText()).toContain("cannot reach the Cloudflare API");
  });

  test("shows the token form when no credential is stored", async () => {
    resetStudioState({ projectConfig: { name: "My Site" } });
    installMockPlatform({
      cfApi: cfApiMock({}),
      cfConnection: () => Promise.resolve(null),
    });
    openPublishPanel();
    await flush();
    expect(bodyText()).toContain("Paste a Cloudflare API token");
    expect(document.querySelector("#cf-token-input")).toBeTruthy();
  });

  test("offers hosted connect and re-checks the connection after it", async () => {
    resetStudioState({ projectConfig: { name: "My Site" } });
    let connected = false;
    installMockPlatform({
      cfApi: cfApiMock({ "/accounts": [{ id: "a".repeat(32), name: "Acme" }] }),
      cfConnect: () => {
        connected = true;
        return Promise.resolve({ connected: true });
      },
      cfConnection: () =>
        Promise.resolve(connected ? { accountId: "a".repeat(32), connected: true } : null),
    });
    openPublishPanel();
    await flush();
    const connect = button("Connect Cloudflare");
    expect(connect).toBeTruthy();
    pointer(connect!, "click");
    await flush();
    expect(connected).toBe(true);
    expect(bodyText()).toContain("Create a Cloudflare Pages project");
  });

  test("verifies a pasted token and advances to the connect form", async () => {
    resetStudioState({ projectConfig: { name: "My Site" } });
    const { getCfToken } = await import("../src/services/cf-settings");
    installMockPlatform({
      cfApi: cfApiMock({ "/accounts": [{ id: "a".repeat(32), name: "Acme" }] }),
      cfConnection: () =>
        Promise.resolve(getCfToken() ? { accountId: "a".repeat(32), connected: true } : null),
    });
    openPublishPanel();
    await flush();
    const input = document.querySelector("#cf-token-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "cf_pasted";
    pointer(button("Verify & Connect")!, "click");
    await flush();
    expect(getCfToken()).toBe("cf_pasted");
    expect(bodyText()).toContain("Create a Cloudflare Pages project");
  });
});

describe("openPublishPanel — connect form", () => {
  function installConnected(routes: Record<string, unknown> = {}) {
    installMockPlatform({
      cfApi: cfApiMock({
        "/accounts": [{ id: DEPLOY.accountId, name: "Acme" }],
        ...routes,
      }),
      cfConnection: () =>
        Promise.resolve({ accountId: DEPLOY.accountId, accountName: "Acme", connected: true }),
    });
  }

  test("prefills the project name slug and validates required fields", async () => {
    resetStudioState({ projectConfig: { build: {}, name: "My Site" } });
    installConnected();
    openPublishPanel();
    await flush();
    const nameField = [...document.querySelectorAll("#layer-modal sp-textfield")].find(
      (el) => el.getAttribute("value") === "my-site",
    );
    expect(nameField).toBeTruthy();
    // Owner/repo are blank on non-cloud roots → validation error on submit.
    pointer(button("Create & Connect")!, "click");
    await flush();
    expect(bodyText()).toContain("owner/repo are all required");
  });

  test("connects end-to-end and lands on the status view", async () => {
    resetStudioState({ projectConfig: { build: {}, name: "My Site" } });
    installMockPlatform({
      cfApi: cfApiMock({
        "/accounts": [{ id: DEPLOY.accountId, name: "Acme" }],
        "/pages/projects/my-site": { name: "my-site", subdomain: "my-site.pages.dev" },
        "/deployments": [],
      }),
      cfConnection: () =>
        Promise.resolve({ accountId: DEPLOY.accountId, accountName: "Acme", connected: true }),
    });
    openPublishPanel();
    await flush();
    // Drive every field handler (owner/repo empty on non-cloud roots).
    const fields = [
      ...document.querySelectorAll("#layer-modal sp-textfield"),
    ] as HTMLInputElement[];
    const byValue = (v: string) => fields.find((f) => f.getAttribute("value") === v)!;
    const type = (el: HTMLInputElement, value: string) => {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    type(byValue("my-site"), "my-site");
    type(byValue(""), "octocat");
    type(fields.find((f) => f.getAttribute("value") === "" && f.value !== "octocat")!, "site");
    type(byValue("main"), "main");
    const picker = document.querySelector("#layer-modal sp-picker") as HTMLInputElement;
    picker.value = "a".repeat(32);
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    pointer(button("Create & Connect")!, "click");
    await flush();
    expect(bodyText()).toContain("Connected to Pages project");
    expect(bodyText()).toContain("my-site");
  });

  test("suggests installing the Pages GitHub App on the characteristic failure", async () => {
    resetStudioState({ projectConfig: { build: {}, name: "My Site" } });
    installMockPlatform({
      cfApi: cfApiMock({
        "/accounts": [{ id: DEPLOY.accountId, name: "Acme" }],
        "/pages/projects": { __error: "GitHub app is not installed on this repo source" },
      }),
      cfConnection: () =>
        Promise.resolve({ accountId: DEPLOY.accountId, accountName: "Acme", connected: true }),
      projectRoot: "octocat/site",
    });
    openPublishPanel();
    await flush();
    pointer(button("Create & Connect")!, "click");
    await flush();
    expect(bodyText()).toContain("GitHub app is not installed");
    expect(panel()?.querySelector('a[href*="cloudflare-pages/installations"]')).toBeTruthy();
  });
});

describe("openPublishPanel — connected status view", () => {
  test("shows the latest deployment and disconnect removes build.deploy", async () => {
    resetStudioState({
      projectConfig: { build: { adapter: "cloudflare-pages", deploy: DEPLOY }, name: "My Site" },
    });
    const { state } = installMockPlatform({
      cfApi: cfApiMock({
        "/accounts": [{ id: DEPLOY.accountId, name: "Acme" }],
        "/deployments": [
          {
            id: "d1",
            url: "https://abc.my-site.pages.dev",
            environment: "production",
            latest_stage: { name: "deploy", status: "success" },
            created_on: "2026-07-06T00:00:00Z",
          },
        ],
      }),
      cfConnection: () =>
        Promise.resolve({ accountId: DEPLOY.accountId, accountName: "Acme", connected: true }),
    });
    openPublishPanel();
    await flush();
    expect(bodyText()).toContain("deploy: success");
    expect(bodyText()).toContain("Publishing happens automatically on every commit");

    pointer(button("Disconnect")!, "click");
    await flush();
    const writes = state.calls.filter((c) => c[0] === "writeFile" && c[1] === "project.json");
    const config = JSON.parse(String(writes.at(-1)?.[2])) as { build: Record<string, unknown> };
    expect(config.build["deploy"]).toBeUndefined();
  });
});
