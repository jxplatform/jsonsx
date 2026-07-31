/**
 * The New Project wizard's Agent flow: the credentials gate and prompt validation on the source
 * step, then the scaffold-then-seed flow from the Parameters step (createProject with the blank
 * template + a pending agent prompt stored for the opening window's assistant).
 *
 * The Agent submit runs the same destination validation as a normal create, so a project is only
 * ever scaffolded under the Location the user chose.
 */
import { flush, installMockPlatform, npFillLocation, npName, npPreview, npType } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { invalidateModelCache } from "../src/services/ai-models";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
const { initLayers } = await import("../src/ui/layers");

document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

/** The multiline prompt field on the Agent source step. */
function promptField(): any {
  return document.querySelector("#layer-modal .new-project-agent-prompt");
}

/** The inline destination validation message rendered under the Location fields. */
function inlineError(): string {
  return (
    document
      .querySelector("#layer-modal .new-project-error:not(.new-project-error--global)")
      ?.textContent?.trim() ?? ""
  );
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

/* The credentials gate probes the AI proxy for backend-held credentials. Stub it: the default is an
   unmanaged, unconfigured backend (BYOK-only), and managed tests override `proxyState`. */
let proxyState: { configured: boolean; managed: boolean } = { configured: false, managed: false };
(globalThis as Record<string, unknown>).fetch = async () =>
  Response.json({ models: [], ...proxyState }, { status: 200 });

beforeEach(() => {
  localStorage.clear();
  proxyState = { configured: false, managed: false };
  invalidateModelCache(); // Re-arms the one-shot probe between tests.
});

afterEach(() => {
  closeNewProjectModal();
});

describe("Agent flow", () => {
  test("shows the AI credentials form when no key is stored, with no Next button", () => {
    installMockPlatform();
    void openNewProjectModal();
    switchTab("agent");
    expect(document.querySelector("#layer-modal .new-project-creds")).toBeTruthy();
    expect(footerButtons()).toHaveLength(1); // Cancel only
  });

  test("offers Connect Cloudflare beside the key form on a managed platform", async () => {
    /* Regression: the cloud SaaS brokers Workers AI on the user's own account, so a gate that
       renders only the BYOK form leaves them with no key and no way to get one. */
    proxyState = { configured: false, managed: true };
    const { platform } = installMockPlatform();
    platform.cfConnect = async () => ({ connected: true });
    void openNewProjectModal();
    switchTab("agent");
    await flush();

    const gate = document.querySelector("#layer-modal .new-project-creds");
    expect(gate?.querySelector(".ai-managed-connect")).toBeTruthy();
    expect(gate!.textContent).toContain("Connect Cloudflare");
    // The BYOK form stays — both are real paths.
    expect(gate!.querySelector(".ai-creds-form")).toBeTruthy();
    expect(document.querySelector("#layer-modal .new-project-tab-intro")?.textContent).toContain(
      "Connect Cloudflare, or add an OpenAI-compatible API key",
    );
  });

  test("lets a managed platform with AI already connected past the gate without a key", async () => {
    /* Regression: gating on hasOpenAiKey() alone suppressed the Next button for users whose
       Cloudflare account was already brokering working AI. */
    proxyState = { configured: true, managed: true };
    installMockPlatform();
    void openNewProjectModal();
    switchTab("agent");
    await flush();

    expect(localStorage.getItem("jx.ai.openaiKey")).toBeNull();
    expect(document.querySelector("#layer-modal .new-project-creds")).toBeNull();
    expect(promptField()).toBeTruthy();
    expect(footerButtons().map((b) => b.textContent?.trim())).toContain("Next");
  });

  test("shows the prompt once a key is stored and requires it before Next", () => {
    localStorage.setItem("jx.ai.openaiKey", "sk-agent-test");
    installMockPlatform();
    void openNewProjectModal();
    switchTab("agent");
    expect(document.querySelector("#layer-modal .new-project-creds")).toBeNull();
    expect(promptField()).toBeTruthy();

    clickFooter("Next");
    expect(document.querySelector("#layer-modal .new-project-error")?.textContent).toContain(
      "Describe the site",
    );
    // Still on the source step.
    expect(document.querySelector("#layer-modal sp-tabs")).toBeTruthy();
  });

  test("requires a name on the Parameters step", async () => {
    localStorage.setItem("jx.ai.openaiKey", "sk-agent-test");
    const { state } = installMockPlatform();
    void openNewProjectModal();
    switchTab("agent");
    npType(promptField(), "A cozy site");
    clickFooter("Next");
    npFillLocation();
    clickFooter("Create & Start Agent");
    await flush();
    // The message renders inline at the name field, not in the global strip.
    expect(
      document
        .querySelector('#layer-modal .new-project-name sp-help-text[slot="negative-help-text"]')
        ?.textContent?.trim(),
    ).toBe("Project name is required");
    expect(state.calls.filter((c) => c[0] === "createProject")).toHaveLength(0);
  });

  test("blocks the agent create until a Location is chosen", async () => {
    localStorage.setItem("jx.ai.openaiKey", "sk-agent-test");
    const { state } = installMockPlatform();
    void openNewProjectModal();
    switchTab("agent");
    npType(promptField(), "A cozy site");
    clickFooter("Next");
    // Everything but the destination is filled in — the modal never guesses where to write.
    npType(npName(), "Agent Site");
    clickFooter("Create & Start Agent");
    await flush();

    expect(inlineError()).toBe("Choose a location for the project folder");
    expect(state.calls.filter((c) => c[0] === "createProject")).toHaveLength(0);
    // The prompt is only stored once a project exists to key it on.
    expect(
      Object.keys(localStorage).filter((k) => k.startsWith("jx.ai.pendingAgentPrompt:")),
    ).toHaveLength(0);
  });

  test("scaffolds a blank project at the chosen location and stores the pending agent prompt", async () => {
    localStorage.setItem("jx.ai.openaiKey", "sk-agent-test");
    const created: Record<string, unknown>[] = [];
    installMockPlatform({
      createProject: (async (opts: Record<string, unknown>) => {
        created.push(opts);
        return { config: { name: "Agent Site" }, root: "/projects/agent-site" };
      }) as never,
    });

    const promise = openNewProjectModal();
    switchTab("agent");
    npType(promptField(), "A landing page for a coffee roastery");
    clickFooter("Next");
    // The agent scaffolds from the blank template; its breakpoint preset prefills the editor.
    expect(document.querySelector("#layer-modal .new-project-step-context")?.textContent).toContain(
      "Agent",
    );
    npType(npName(), "Agent Site");
    npFillLocation("/home/dev/Sites");
    expect(npPreview()).toBe("Creates: /home/dev/Sites/agent-site");
    clickFooter("Create & Start Agent");

    const result = await promise;
    expect(result).toEqual({
      config: { name: "Agent Site" },
      root: "/projects/agent-site",
    } as never);

    expect(created[0]).toMatchObject({
      destination: { kind: "path", parent: "/home/dev/Sites" },
      directory: "agent-site",
      name: "Agent Site",
      template: "blank",
    });
    // Untouched design prefills are not sent.
    expect((created[0] as { design?: unknown }).design).toBeUndefined();

    // The prompt is keyed on the root the platform reported, not on the destination the modal sent.
    const stored = localStorage.getItem("jx.ai.pendingAgentPrompt:/projects/agent-site");
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).prompt).toBe("A landing page for a coffee roastery");
  });
});
