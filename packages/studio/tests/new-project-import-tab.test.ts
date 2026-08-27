/**
 * The New Project wizard's Import flow: the credentials gate and URL validation on the source step,
 * the Parameters hand-off (identity plus the destination the user chose), the streaming progress
 * log, success/failure/cancel flows, and the options threaded into platform.importSite.
 */
import {
  clearSeededSettings,
  flush,
  installMockPlatform,
  mountOverlayLayers,
  npFillLocation,
  npLocation,
  npName,
  npPreview,
  npSlug,
  npType,
  seedSettings,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetModelCache } from "../src/services/ai-models";
import type { ImportTabCtx } from "../src/new-project/import-tab";
import type { ImportProgressEvent } from "../src/types";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
const { handoffImport, importBriefFor, importButtonLabel } =
  await import("../src/new-project/import-tab");
const { clearPendingImportBrief, pendingImportBrief } = await import("../src/services/import-seed");
const { initLayers } = await import("../src/ui/layers");

mountOverlayLayers(document.body);
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

/** Every number field on the Import source step, in render order. */
function numberFields(): (HTMLElement & { value: string })[] {
  return [...document.querySelectorAll("#layer-modal sp-number-field")] as (HTMLElement & {
    value: string;
  })[];
}

/** The "Check fidelity against the original" switch — the second of the step's two. */
function verifySwitch(): HTMLElement & { checked: boolean } {
  return [...document.querySelectorAll("#layer-modal sp-switch")][1] as HTMLElement & {
    checked: boolean;
  };
}

/** The inline error rendered under the destination fields (or by a failed run). */
function inlineError(): string {
  return document.querySelector("#layer-modal .new-project-error")?.textContent?.trim() ?? "";
}

/**
 * A hand-built ImportTabCtx for driving handoffImport directly (the modal only ever hands it a
 * filesystem destination), paired with a counter for the rerenders it requests.
 */
function directCtx(resolveDestination: ImportTabCtx["resolveDestination"]) {
  const counter = { rerenders: 0 };
  const ctx: ImportTabCtx = {
    aiGateOpen: () => true,
    credsForm: { render: () => "" as never, startEdit: () => {} },
    form: { directory: "site", name: "Site" },
    managedConnect: { canOffer: () => false, render: () => "" },
    onHandoff: mock(() => {}),
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
  seedSettings({
    "jx.ai.openaiKey": "sk-import-test",
    "jx.ai.baseUrl": "http://llm.local/v1",
    "jx.ai.model": "test-model",
  });
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
  clearPendingImportBrief();
  captured = null;
  localStorage.clear();
  clearSeededSettings();
  proxyState = { configured: false, managed: false };
  resetModelCache(); // Re-arms the one-shot probe between tests.
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

  test("shows the URL, crawl options, model and brief once a key is stored", () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    expect(document.querySelector("#layer-modal .new-project-creds")).toBeNull();
    // Two textfields: the site URL, and the brief handed to the assistant afterwards.
    expect(document.querySelectorAll("#layer-modal sp-textfield")).toHaveLength(2);
    expect(document.querySelector("#layer-modal .new-project-import-prompt")).toBeTruthy();
    expect(document.querySelector("#layer-modal .new-project-import-model")).toBeTruthy();
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

describe("Import — the brief the form hands over", () => {
  test("an empty project name blocks the hand-off and shows the inline name error", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    npType(npName(), ""); // Clear the prefilled name.
    clickFooter("Import Site");
    await flush();
    expect(pendingImportBrief()).toBeNull();
    // The modal — not the tab — owns identity validation, so the message lands on the field.
    expect(nameError()).toBe("Project name is required");
  });

  test("a missing Location blocks the hand-off", async () => {
    setKey();
    importPlatform();
    void reachParams();
    // Location left empty: the name and slug are prefilled, so only the destination is missing.
    clickFooter("Import Site");
    await flush();
    expect(pendingImportBrief()).toBeNull();
    expect(inlineError()).toContain("Choose a location for the project folder");
    // Still on the Parameters step, ready for the user to choose one.
    expect(npLocation()).toBeTruthy();
    expect(importButtonLabel()).toBe("Import Site");
  });

  test("the brief carries the Location joined with the slug", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation("/home/dev/Sites");
    npType(npName(), "My Clone");
    npType(npSlug(), "clone-dir");
    expect(npPreview()).toContain("/home/dev/Sites/clone-dir");
    clickFooter("Import Site");
    await flush();
    expect(pendingImportBrief()!.directory).toBe("/home/dev/Sites/clone-dir");
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
    expect(pendingImportBrief()).toMatchObject({
      directory: "/home/dev/Sites/coffee-cream",
      name: "Coffee & Cream",
    });
  });

  test("crawl options, the AI-naming switch and the prompt all reach the brief", async () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    npType(urlField(), "https://clone.example/");

    const [depth, maxPages] = numberFields();
    depth!.value = "2";
    depth!.dispatchEvent(new Event("change", { bubbles: true }));
    maxPages!.value = "50";
    maxPages!.dispatchEvent(new Event("change", { bubbles: true }));
    const aiSwitch = document.querySelector("#layer-modal sp-switch") as HTMLElement & {
      checked: boolean;
    };
    aiSwitch.checked = false;
    aiSwitch.dispatchEvent(new Event("change", { bubbles: true }));
    npType(
      document.querySelector("#layer-modal .new-project-import-prompt") as HTMLInputElement,
      "Modernise the typography",
    );

    clickFooter("Next");
    npFillLocation();
    clickFooter("Import Site");
    await flush();
    expect(pendingImportBrief()).toMatchObject({
      aiComponents: false,
      depth: 2,
      maxPages: 50,
      prompt: "Modernise the typography",
      url: "https://clone.example/",
    });
  });

  /*
   * The fidelity bar (jxsuite/jx issue 232). It appears WITH the check it belongs to: a minimum
   * for a comparison nobody asked to run is a number with nothing to measure.
   */
  test("the fidelity minimum appears only once the fidelity check is on", async () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    // Crawl depth and max pages, and no third field while the check is off.
    expect(document.querySelectorAll("#layer-modal sp-number-field")).toHaveLength(2);

    verifySwitch().checked = true;
    verifySwitch().dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(document.querySelectorAll("#layer-modal sp-number-field")).toHaveLength(3);
    expect(document.querySelector("#layer-modal .new-project-hint")?.textContent).toContain(
      "did not match the original",
    );
  });

  test("the fidelity minimum reaches the brief", async () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    npType(urlField(), "https://clone.example/");
    verifySwitch().checked = true;
    verifySwitch().dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    const fidelity = numberFields()[2]!;
    fidelity.value = "60";
    fidelity.dispatchEvent(new Event("change", { bubbles: true }));

    clickFooter("Next");
    npFillLocation();
    clickFooter("Import Site");
    await flush();
    expect(pendingImportBrief()).toMatchObject({ minFidelity: 60, verify: true });
  });

  // A percentage is the only thing this number can be, so the field refuses to carry anything else.
  test("the fidelity minimum is clamped to a percentage", async () => {
    setKey();
    importPlatform();
    void openNewProjectModal();
    switchTab("import");
    npType(urlField(), "https://clone.example/");
    verifySwitch().checked = true;
    verifySwitch().dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    const fidelity = numberFields()[2]!;
    /* Read the brief directly rather than through the footer: handing off CLOSES the modal, so a
       loop that clicks Import Site could only ever check its first case. */
    const { ctx } = directCtx(() => ({ kind: "path", parent: "/home/dev/Sites" }));
    for (const [typed, expected] of [
      ["250", 100],
      ["-5", 0],
      ["", 0],
      ["60", 60],
    ] as const) {
      fidelity.value = typed;
      fidelity.dispatchEvent(new Event("change", { bubbles: true }));
      expect(importBriefFor(ctx)).toMatchObject({ minFidelity: expected });
    }
  });

  test("Import Site is a no-op when the platform lacks importSite", async () => {
    installMockPlatform();
    const { counter, ctx } = directCtx(() => ({ kind: "path", parent: "/home/dev/Sites" }));
    handoffImport(ctx);
    expect(counter.rerenders).toBe(0);
    expect(ctx.onHandoff).not.toHaveBeenCalled();
  });

  test("a repository destination never hands off", async () => {
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
    handoffImport(ctx);
    expect(ctx.onHandoff).not.toHaveBeenCalled();
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
    handoffImport(ctx);
    expect(ctx.onHandoff).not.toHaveBeenCalled();
    expect(counter.rerenders).toBe(1);

    // Parsable, but not an http(s) site.
    npType(urlField(), "ftp://files.example/");
    handoffImport(ctx);
    expect(ctx.onHandoff).not.toHaveBeenCalled();
    expect(counter.rerenders).toBe(2);
    expect(resolved).toBe(0);
  });
});

describe("Import — the model picker", () => {
  test("a chosen model reaches the brief without retargeting the assistant", async () => {
    /* The picker writes a DRAFT, not `jx.ai.model`: choosing a model for one import must not
       silently change which model every later chat turn runs on. */
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    npType(npName(), "Cloned Site");

    // Step back to the source step, where the picker lives, and choose.
    clickFooter("Back");
    const picker = document.querySelector(
      "#layer-modal .new-project-import-model",
    ) as HTMLElement & { value?: string };
    picker.value = "o3-import";
    picker.dispatchEvent(new Event("change", { bubbles: true }));

    clickFooter("Next");
    clickFooter("Import Site");
    await flush();

    expect(pendingImportBrief()!.model).toBe("o3-import");
    // The application preference is untouched.
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBe("test-model");
  });

  test("an untouched picker leaves the model empty, and the tool falls back", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    npType(npName(), "Cloned Site");
    clickFooter("Import Site");
    await flush();

    expect(pendingImportBrief()!.model).toBe("");
  });
});

describe("Import — the hand-off", () => {
  test("the wizard closes with no project, because it created none", async () => {
    /* `import_site` is `no-project` tiered and does the creating — including the git init every
       create path owes. The wizard's promise resolves null, the same as a dismissal. */
    setKey();
    importPlatform();
    const promise = reachParams();
    npFillLocation();
    npType(npName(), "Cloned Site");
    clickFooter("Import Site");

    expect(await promise).toBeNull();
    expect(modal()).toBeNull();
    // Nothing was imported by the wizard itself.
    expect(captured).toBeNull();
  });

  test("the brief is left for the tool to read, not consumed on hand-off", async () => {
    setKey();
    importPlatform();
    void reachParams();
    npFillLocation();
    npType(npName(), "Cloned Site");
    clickFooter("Import Site");
    await flush();

    expect(pendingImportBrief()).toMatchObject({
      depth: 1,
      directory: "/home/dev/Sites/cloned-site",
      maxPages: 20,
      name: "Cloned Site",
      url: "https://clone.example/",
    });
  });
});
