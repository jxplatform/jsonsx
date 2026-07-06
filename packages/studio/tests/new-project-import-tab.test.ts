/**
 * The New Project wizard's Import flow: the credentials gate and URL validation on the source step,
 * the Parameters hand-off, the streaming progress log, success/failure/cancel flows, and the
 * options threaded into platform.importSite.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ImportProgressEvent } from "../src/types";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
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

/** Source step: field(0) = Site URL. Parameters step: name(0), directory(1). */
function field(index: number): any {
  return document.querySelectorAll("#layer-modal sp-textfield")[index];
}

function typeInto(el: any, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
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
  typeInto(field(0), url);
  clickFooter("Next");
  return promise;
}

beforeEach(() => {
  captured = null;
  localStorage.clear();
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
    typeInto(field(0), "not a url");
    clickFooter("Next");
    expect(document.querySelector("#layer-modal .new-project-error")?.textContent).toContain(
      "valid URL",
    );
    // Still on the source step.
    expect(document.querySelector("#layer-modal sp-tabs")).toBeTruthy();
    expect(captured).toBeNull();
  });

  test("prefills the project name and directory from the hostname", () => {
    setKey();
    importPlatform();
    void reachParams("https://www.coffee-shop.example/menu");
    // Parameters step: name(0) and directory(1) carry the hostname prefill.
    expect(field(0).value).toBe("coffee-shop.example");
    expect(field(1).value).toBe("coffee-shop-example");
    // Import parameters are identity-only: no adapter picker, no design sections.
    expect(document.querySelector("#layer-modal sp-picker")).toBeNull();
    expect(document.querySelectorAll("#layer-modal .new-project-design-section")).toHaveLength(0);
  });
});

describe("Import — streaming flow", () => {
  test("threads options + stored credentials into importSite and streams the log", async () => {
    setKey();
    importPlatform();
    const promise = reachParams();
    typeInto(field(0), "Cloned Site");
    clickFooter("Import Site");
    await flush();

    expect(captured).not.toBeNull();
    expect(captured!.opts).toMatchObject({
      aiComponents: true,
      apiKey: "sk-import-test",
      baseUrl: "http://llm.local/v1",
      depth: 1,
      directory: "cloned-site",
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
    captured!.resolve({ config: { name: "Cloned Site" }, root: "/projects/cloned-site" });
    const result = await promise;
    expect(result).toEqual({
      config: { name: "Cloned Site" },
      root: "/projects/cloned-site",
    } as never);
    expect(modal()).toBeNull();
  });

  test("a failing import shows the error, keeps the log, and offers Retry", async () => {
    setKey();
    importPlatform();
    void reachParams();
    clickFooter("Import Site");
    await flush();

    captured!.onProgress({ message: "Launching browser...", phase: "launch" });
    captured!.reject(new Error("Chrome not found"));
    await flush();

    expect(modal()).toBeTruthy();
    expect(document.querySelector("#layer-modal .new-project-error")?.textContent).toContain(
      "Chrome not found",
    );
    const labels = footerButtons().map((b) => b.textContent?.trim());
    expect(labels.at(-1)).toContain("Retry Import");
  });

  test("Cancel Import aborts the signal and returns to the Parameters step", async () => {
    setKey();
    importPlatform();
    void reachParams();
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
});
