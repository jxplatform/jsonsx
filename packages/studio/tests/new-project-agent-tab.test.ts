/**
 * The New Project wizard's Agent flow: the credentials gate and prompt validation on the source
 * step, then the scaffold-then-seed flow from the Parameters step (createProject with the blank
 * template + a pending agent prompt stored for the opening window's assistant).
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
const { initLayers } = await import("../src/ui/layers");

document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

/** Source step: field(0) = prompt. Parameters step: name(0), directory(1). */
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

beforeEach(() => {
  localStorage.clear();
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

  test("shows the prompt once a key is stored and requires it before Next", () => {
    localStorage.setItem("jx.ai.openaiKey", "sk-agent-test");
    installMockPlatform();
    void openNewProjectModal();
    switchTab("agent");
    expect(document.querySelector("#layer-modal .new-project-creds")).toBeNull();
    expect(document.querySelector("#layer-modal .new-project-agent-prompt")).toBeTruthy();

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
    typeInto(field(0), "A cozy site");
    clickFooter("Next");
    clickFooter("Create & Start Agent");
    await flush();
    // The message renders inline at the name field, not in the global strip.
    expect(
      document
        .querySelector('#layer-modal sp-textfield sp-help-text[slot="negative-help-text"]')
        ?.textContent?.trim(),
    ).toBe("Project name is required");
    expect(state.calls.filter((c) => c[0] === "createProject")).toHaveLength(0);
  });

  test("scaffolds a blank project and stores the pending agent prompt", async () => {
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
    typeInto(field(0), "A landing page for a coffee roastery");
    clickFooter("Next");
    // The agent scaffolds from the blank template; its breakpoint preset prefills the editor.
    expect(document.querySelector("#layer-modal .new-project-step-context")?.textContent).toContain(
      "Agent",
    );
    typeInto(field(0), "Agent Site");
    clickFooter("Create & Start Agent");

    const result = await promise;
    expect(result).toEqual({
      config: { name: "Agent Site" },
      root: "/projects/agent-site",
    } as never);

    expect(created[0]).toMatchObject({
      directory: "agent-site",
      name: "Agent Site",
      template: "blank",
    });
    // Untouched design prefills are not sent.
    expect((created[0] as { design?: unknown }).design).toBeUndefined();

    const stored = localStorage.getItem("jx.ai.pendingAgentPrompt:/projects/agent-site");
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).prompt).toBe("A landing page for a coffee roastery");
  });
});
