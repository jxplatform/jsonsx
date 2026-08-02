/**
 * The New Project wizard's Import flow: the credentials gate and URL validation on the source step,
 * the Parameters hand-off (identity plus the destination the user chose), the streaming progress
 * log, success/failure/cancel flows, and the options threaded into platform.importSite.
 */
import {
  flush,
  installMockPlatform,
  npFillLocation,
  npLocation,
  npName,
  npPreview,
  npSlug,
  npType,
} from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { invalidateModelCache } from "../src/services/ai-models";
import type { ImportTabCtx } from "../src/new-project/import-tab";
import type { ImportProgressEvent } from "../src/types";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
const { importButtonLabel, startImport } = await import("../src/new-project/import-tab");
const { initLayers } = await import("../src/ui/layers");

document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

function modal(): HTMLElement | null {
  return document.querySelector("#layer-modal .new-project-modal");
}

/** The Import source step's only textfield: Site URL. */
function urlField(): HTMLInputElement {
  return document.querySelector("#layer-modal sp-textfield") as HTMLInputElement;
}

/** The Project Name field's inline validation message (Spectrum's negative help text). */
function nameError(): string {
  return (
    document
      .querySelector('#layer-modal .new-project-name sp-help-text[slot="negative-help-text"]')
      ?.textContent?.trim() ?? ""
  );
}

/** The inline error rendered under the destination fields (or by a failed run). */
function inlineError(): string {
  return document.querySelector("#layer-modal .new-project-error")?.textContent?.trim() ?? "";
}

/**
 * A hand-built ImportTabCtx for driving startImport directly (the modal only ever hands it a
 * filesystem destination), paired with a counter for the rerenders it requests.
 */
function directCtx(resolveDestination: ImportTabCtx["resolveDestination"]) {
  const counter = { rerenders: 0 };
  const ctx: ImportTabCtx = {
    aiGateOpen: () => true,
    credsForm: { render: () => "" as never, startEdit: () => {} },
    form: { directory: "site", name: "Site" },
    managedConnect: { canOffer: () => false, render: () => "" },
    onDone: () => {},
    rerender: () => {
      counter.rerenders += 1;
    },
    resolveDestination,
  };
  return { counter, ctx };
}

function footerButtons(): any[] {
  return [...document.querySelectorAll("#layer-modal .new-project-modal-footer sp-button")];
}

function clickFooter(label: string) {
  const btn = footerButtons().find((b) => b.textContent?.includes(label));
  btn!.dispatchEvent(new Event("click", { bubbles: true }));
}

function switchTab(value: string) {
  const tabs: any = document.querySelector("#layer-modal sp-tabs");
  tabs.selected = value;
  tabs.dispatchEvent(new Event("change", { bubbles: true }));
}

function logLines(): string[] {
  return [...document.querySelectorAll("#layer-modal .new-project-import-log-line")].map(
    (el) => el.textContent?.replaceAll(/\s+/g, " ").trim() ?? "",
  );
}

interface CapturedImport {
  opts: Record<string, unknown>;
  onProgress: (evt: ImportProgressEvent) => void;
  signal: AbortSignal | undefined;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

let captured: CapturedImport | null = null;

function importPlatform() {
  return installMockPlatform({
    importSite: ((
      opts: Record<string, unknown>,
      onProgress: (evt: ImportProgressEvent) => void,
      signal?: AbortSignal,
    ) =>
      new Promise((resolve, reject) => {
        captured = { onProgress, opts, reject, resolve, signal };
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as never,
  });
}

function setKey() {
  localStorage.setItem("jx.ai.openaiKey", "sk-import-test");
  localStorage.setItem("jx.ai.baseUrl", "http://llm.local/v1");
  localStorage.setItem("jx.ai.model", "test-model");
}

/** Open the modal, switch to Import, fill the URL, and advance to the Parameters step. */
function reachParams(url = "https://clone.example/") {
  const promise = openNewProjectModal();
  switchTab("import");
  npType(urlField(), url);
  clickFooter("Next");
  return promise;
}

/* The credentials gate probes the AI proxy for backend-held credentials; default it to a plain
   BYOK-only backend, and let managed/env-keyed tests override. */
let proxyState: { configured: boolean; managed: boolean } = { configured: false, managed: false };
(globalThis as Record<string, unknown>).fetch = async () =>
  Response.json({ models: [], ...proxyState }, { status: 200 });

beforeEach(() => {
  captured = null;
  localStorage.clear();
  proxyState = { configured: false, managed: false };
  invalidateModelCache(); // Re-arms the one-shot probe between tests.
});

afterEach(async () => {
  // Unwind a running import so the close guard lets the modal close.
  const buttons = footerButtons();
  const cancelBtn = buttons.find((b) => b.textContent?.includes("Cancel Import"));
  if (cancelBtn) {
    cancelBtn.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
  }
  closeNewProjectModal();
});

describe("Import source step", () => {
  test("shows the AI credentials form when no key is stored, with no Next button", () => {
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    expect(document.querySelector("#layer-modal .new-project-creds")).toBeTruthy();
    // Only Cancel in the footer while gated.
    expect(footerButtons()).toHaveLength(1);
  });

  test("opens the gate for a backend holding its own credentials, with no key stored", async () => {
    /* Regression: gating on hasOpenAiKey() alone blocked env-keyed dev servers and managed cloud
       platforms, whose AI already works without anything stored in this browser. */
    proxyState = { configured: true, managed: false };
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    await flush();

    expect(localStorage.getItem("jx.ai.openaiKey")).toBeNull();
    expect(document.querySelector("#layer-modal .new-project-creds")).toBeNull();
    expect(footerButtons().map((b) => b.textContent?.trim())).toEqual(["Cancel", "Next"]);
  });

  test("shows the URL + crawl options once a key is stored", () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    expect(document.querySelector("#layer-modal .new-project-creds")).toBeNull();
    expect(document.querySelectorAll("#layer-modal sp-textfield")).toHaveLength(1);
    expect(document.querySelectorAll("#layer-modal sp-number-field")).toHaveLength(2);
    expect(document.querySelector("#layer-modal sp-switch")).toBeTruthy();
    const labels = footerButtons().map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Cancel", "Next"]);
  });

  test("rejects an invalid URL inline on Next", () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    npType(urlField(), "not a url");
    clickFooter("Next");
    expect(inlineError()).toContain("valid URL");
    // Still on the source step.
    expect(document.querySelector("#layer-modal sp-tabs")).toBeTruthy();
    expect(captured).toBeNull();
  });

  test("prefills the project name and directory from the hostname", () => {
    setKey();
    importPlatform();
    void reachParams("https://www.coffee-shop.example/menu");
    // Parameters step: name and slug carry the hostname prefill; the destination is never guessed,
    // So the Location field starts empty.
    expect(npName().value).toBe("coffee-shop.example");
    expect(npSlug().value).toBe("coffee-shop-example");
    expect(npLocation()).toBeTruthy();
    expect(npLocation().value).toBe("");
    // Import parameters are identity-only: no adapter picker, no design sections.
    expect(document.querySelector("#layer-modal sp-picker")).toBeNull();
    expect(document.querySelectorAll("#layer-modal .new-project-design-section")).toHaveLength(0);
  });
});

describe("Import — parameters validation", () => {
  test("an empty project name blocks the import and shows the inline name error", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    npType(npName(), ""); // Clear the prefilled name.
    clickFooter("Import Site");
    await flush();
    expect(captured).toBeNull();
    // The modal — not the tab — owns identity validation now, so the message lands on the field.
    expect(nameError()).toBe("Project name is required");
  });

  test("a missing Location blocks the import before importSite is called", async () => {
    setKey();
    importPlatform();
    void reachParams();
    // Location left empty: the name and slug are prefilled, so only the destination is missing.
    clickFooter("Import Site");
    await flush();
    expect(captured).toBeNull();
    expect(inlineError()).toContain("Choose a location for the project folder");
    // Still on the Parameters step, ready for the user to choose one.
    expect(npLocation()).toBeTruthy();
    expect(importButtonLabel()).toBe("Import Site");
  });

  test("importSite receives the Location joined with the slug", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation("/home/dev/Sites");
    npType(npName(), "My Clone");
    npType(npSlug(), "clone-dir");
    expect(npPreview()).toContain("/home/dev/Sites/clone-dir");
    clickFooter("Import Site");
    await flush();
    expect(captured!.opts.directory).toBe("/home/dev/Sites/clone-dir");
  });

  test("a blank directory defaults to the name's slug", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    npType(npName(), "Coffee & Cream");
    npType(npSlug(), ""); // Clear the derived directory.
    clickFooter("Import Site");
    await flush();
    expect(captured!.opts).toMatchObject({
      directory: "/home/dev/Sites/coffee-cream",
      name: "Coffee & Cream",
    });
  });

  test("crawl options and the AI-naming switch thread into importSite", async () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    npType(urlField(), "https://clone.example/");

    const numberFields = [
      ...document.querySelectorAll("#layer-modal sp-number-field"),
    ] as (HTMLElement & { value: string })[];
    numberFields[0]!.value = "2";
    numberFields[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    numberFields[1]!.value = "50";
    numberFields[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    const aiSwitch = document.querySelector("#layer-modal sp-switch") as HTMLElement & {
      checked: boolean;
    };
    aiSwitch.checked = false;
    aiSwitch.dispatchEvent(new Event("change", { bubbles: true }));

    clickFooter("Next");
    npFillLocation();
    clickFooter("Import Site");
    await flush();
    expect(captured!.opts).toMatchObject({ aiComponents: false, depth: 2, maxPages: 50 });
  });

  test("Import Site is a no-op when the platform lacks importSite", async () => {
    installMockPlatform();
    const { counter, ctx } = directCtx(() => ({ kind: "path", parent: "/home/dev/Sites" }));
    await startImport(ctx);
    expect(counter.rerenders).toBe(0);
  });

  test("a repository destination never starts an import", async () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    npType(urlField(), "https://clone.example/");
    // The pipeline writes to a folder; a repo destination is not a place it can clone into.
    const { counter, ctx } = directCtx(() => ({
      kind: "repo",
      owner: "acme",
      private: true,
      repo: "site",
    }));
    await startImport(ctx);
    expect(captured).toBeNull();
    expect(counter.rerenders).toBe(0);
  });

  test("a missing or non-web URL is refused before the destination is resolved", async () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    let resolved = 0;
    const { counter, ctx } = directCtx(() => {
      resolved += 1;
      return { kind: "path", parent: "/home/dev/Sites" };
    });

    // No URL at all (the source step never validated one).
    await startImport(ctx);
    expect(captured).toBeNull();
    expect(counter.rerenders).toBe(1);

    // Parsable, but not an http(s) site.
    npType(urlField(), "ftp://files.example/");
    await startImport(ctx);
    expect(captured).toBeNull();
    expect(counter.rerenders).toBe(2);
    expect(resolved).toBe(0);
  });
});

describe("Import — streaming flow", () => {
  test("threads options + stored credentials into importSite and streams the log", async () => {
    setKey();
    importPlatform();
    const promise = reachParams();
    npFillLocation();
    npType(npName(), "Cloned Site");
    clickFooter("Import Site");
    await flush();

    expect(captured).not.toBeNull();
    expect(captured!.opts).toMatchObject({
      aiComponents: true,
      apiKey: "sk-import-test",
      baseUrl: "http://llm.local/v1",
      depth: 1,
      directory: "/home/dev/Sites/cloned-site",
      maxPages: 20,
      model: "test-model",
      name: "Cloned Site",
      url: "https://clone.example/",
    });

    // Progress lines stream into the log; the footer swaps to Cancel Import.
    captured!.onProgress({ message: "Capturing page...", phase: "capture" });
    captured!.onProgress({ message: "Wrote 12 files", phase: "emit" });
    await flush();
    expect(logLines()).toEqual(["capture Capturing page...", "emit Wrote 12 files"]);
    const labels = footerButtons().map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Cancel Import"]);

    // Success resolves the modal promise with the imported project.
    captured!.resolve({ config: { name: "Cloned Site" }, root: "/home/dev/Sites/cloned-site" });
    const result = await promise;
    expect(result).toEqual({
      config: { name: "Cloned Site" },
      root: "/home/dev/Sites/cloned-site",
    } as never);
    expect(modal()).toBeNull();
  });

  test("the primary-button label reads Importing… while a run is active", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    expect(importButtonLabel()).toBe("Import Site");
    clickFooter("Import Site");
    await flush();
    expect(importButtonLabel()).toBe("Importing…");
  });

  test("a failing import shows the error, keeps the log, and offers Retry", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    clickFooter("Import Site");
    await flush();

    captured!.onProgress({ message: "Launching browser...", phase: "launch" });
    captured!.reject(new Error("Chrome not found"));
    await flush();

    expect(modal()).toBeTruthy();
    expect(inlineError()).toContain("Chrome not found");
    const labels = footerButtons().map((b) => b.textContent?.trim());
    expect(labels.at(-1)).toContain("Retry Import");
    expect(importButtonLabel()).toBe("Retry Import");

    // Back on the Import source step, the error and the retained log both render.
    clickFooter("Back");
    expect(inlineError()).toContain("Chrome not found");
    expect(logLines()).toEqual(["launch Launching browser..."]);
  });

  test("Cancel Import aborts the signal and returns to the Parameters step", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    clickFooter("Import Site");
    await flush();

    const [cancelBtn] = footerButtons();
    expect(cancelBtn.textContent).toContain("Cancel Import");
    cancelBtn.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(captured!.signal?.aborted).toBe(true);
    expect(modal()).toBeTruthy();
    // Back at the idle Parameters step (no error shown for a user-initiated cancel).
    const labels = footerButtons().map((b) => b.textContent?.trim());
    expect(labels.at(-1)).toContain("Import Site");
    expect(document.querySelector("#layer-modal .new-project-error")).toBeNull();
  });

  test("dismissing the modal mid-import aborts the run instead of trapping the user", async () => {
    setKey();
    importPlatform();
    const promise = reachParams();
    npFillLocation();
    clickFooter("Import Site");
    await flush();
    expect(captured!.signal?.aborted).toBe(false);

    closeNewProjectModal();
    expect(captured!.signal?.aborted).toBe(true);
    expect(modal()).toBeNull();
    expect(await promise).toBeNull();
  });
});
