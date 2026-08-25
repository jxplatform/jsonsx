/**
 * Tests for src/ui/ai-managed-connect.ts — the keyless "Connect Cloudflare" (Workers AI) option
 * every AI credentials gate embeds beside the key form.
 *
 * The regression this guards: a gate that renders only the key form strands managed-platform users,
 * who have no key and no way to obtain one from inside Studio.
 */
import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";
import { createManagedConnect } from "../src/ui/ai-managed-connect";
import { fetchAvailableModels, resetModelCache } from "../src/services/ai-models";

const { platform } = installMockPlatform();

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  Response.json({ models: [] }, { status: 200 });
const fetchCalls: string[] = [];
(globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
  fetchCalls.push(url);
  return fetchImpl(url, init);
};

async function flush(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** A controller wired to re-render itself into a dedicated container. */
function makeConnect() {
  const container = document.createElement("div");
  const mc = createManagedConnect({
    requestRender: () => {
      render(mc.render(), container);
    },
  });
  render(mc.render(), container);
  return { container, mc };
}

function connectButton(container: HTMLElement) {
  return [...container.querySelectorAll("sp-button")].find((b) =>
    b.textContent?.includes("Connect"),
  ) as HTMLElement | undefined;
}

/** Put the proxy into managed-but-unconfigured — the state that warrants the offer. */
async function probeManaged(managed: boolean, configured = false) {
  fetchImpl = async () => Response.json({ models: [], configured, managed }, { status: 200 });
  await fetchAvailableModels({ force: true });
}

beforeEach(() => {
  globalThis.localStorage.clear();
  resetModelCache();
  fetchCalls.length = 0;
  delete platform.cfConnect;
});

describe("canOffer", () => {
  test("only when the proxy is managed, unconfigured, and the platform can run the flow", async () => {
    const { mc } = makeConnect();
    // Nothing probed yet.
    expect(mc.canOffer()).toBe(false);

    await probeManaged(true);
    // Managed, but this platform has no hosted OAuth flow (desktop/dev server).
    expect(mc.canOffer()).toBe(false);

    platform.cfConnect = async () => ({ connected: true });
    expect(mc.canOffer()).toBe(true);

    // Already connected — the gate is open, so there is nothing to offer.
    await probeManaged(true, true);
    expect(mc.canOffer()).toBe(false);

    // Unmanaged backend (OSS dev server): BYOK is the only path.
    await probeManaged(false);
    expect(mc.canOffer()).toBe(false);
  });
});

describe("render", () => {
  test("renders nothing until the offer applies, then the CTA", async () => {
    const { container, mc } = makeConnect();
    expect(container.querySelector(".ai-managed-connect")).toBeNull();

    await probeManaged(true);
    platform.cfConnect = async () => ({ connected: true });
    render(mc.render(), container);

    const cta = container.querySelector(".ai-managed-connect");
    expect(cta).toBeTruthy();
    expect(cta!.textContent).toContain("Workers AI");
    expect(connectButton(container)!.textContent).toContain("Connect Cloudflare");
    // Both paths stay on offer — the CTA introduces the key form below it.
    expect(cta!.textContent).toContain("or bring your own key");
  });
});

describe("connect", () => {
  test("runs the platform flow, then re-probes so the gate opens", async () => {
    await probeManaged(true);
    const cfConnect = mock(async () => ({ accountId: "acc-1", connected: true }));
    platform.cfConnect = cfConnect;
    const { container, mc } = makeConnect();
    render(mc.render(), container);

    fetchCalls.length = 0;
    fetchImpl = async () =>
      Response.json(
        { models: [{ id: "@cf/meta/llama-4" }], configured: true, managed: true },
        {
          status: 200,
        },
      );
    connectButton(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(cfConnect).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    // Configured now, so the offer withdraws and the container empties.
    expect(mc.canOffer()).toBe(false);
    expect(container.querySelector(".ai-managed-connect")).toBeNull();
  });

  test("reports an abandoned flow without closing the offer", async () => {
    await probeManaged(true);
    platform.cfConnect = async () => null;
    const { container, mc } = makeConnect();
    render(mc.render(), container);

    connectButton(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(container.querySelector(".ai-managed-connect-error")?.textContent).toContain(
      "not completed",
    );
    expect(mc.canOffer()).toBe(true);
  });

  test("surfaces a thrown error and re-enables the button", async () => {
    await probeManaged(true);
    platform.cfConnect = async () => {
      throw new Error("popup blocked");
    };
    const { container } = makeConnect();

    connectButton(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(container.querySelector(".ai-managed-connect-error")?.textContent).toContain(
      "popup blocked",
    );
    expect(connectButton(container)!.hasAttribute("disabled")).toBe(false);
  });

  test("ignores a second click while a flow is in flight", async () => {
    await probeManaged(true);
    let resolveFlow: ((v: { connected: boolean }) => void) | null = null;
    const cfConnect = mock(
      async () =>
        await new Promise<{ connected: boolean }>((resolve) => {
          resolveFlow = resolve;
        }),
    );
    platform.cfConnect = cfConnect;
    const { container } = makeConnect();

    connectButton(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(1);
    // Busy: the button reads "Connecting…" and is disabled.
    expect(connectButton(container)!.textContent).toContain("Connecting");
    connectButton(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(1);
    expect(cfConnect).toHaveBeenCalledTimes(1);

    resolveFlow!({ connected: true });
    await flush();
  });
});

describe("ensureProbe", () => {
  test("fires the shared capability probe and repaints when it settles", async () => {
    fetchImpl = async () =>
      Response.json({ models: [], configured: false, managed: true }, { status: 200 });
    platform.cfConnect = async () => ({ connected: true });
    const { container, mc } = makeConnect();
    expect(container.querySelector(".ai-managed-connect")).toBeNull();

    mc.ensureProbe();
    await flush();

    // The repaint is the point: the offer must appear without any further user action.
    expect(fetchCalls).toHaveLength(1);
    expect(container.querySelector(".ai-managed-connect")).toBeTruthy();
  });
});

/**
 * The Cloudflare option is the RECOMMENDATION on a managed platform, and it has two moods.
 *
 * Both matter to the same outage. studio.jxsuite.com showed the BYOK key form alone, because
 * /ai/models answered 500, the probe threw, and `managed` stayed false — so the block below never
 * rendered at all. With the backend answering 200 and a reason, the block renders, and a lapsed
 * grant has to say so: "Connect Cloudflare" is an invitation, and this user already accepted it.
 */
describe("the recommendation, and its two moods", () => {
  /** Answer the probe exactly as the backend now does for a given state. */
  function probeAnswers(body: Record<string, unknown>) {
    fetchImpl = async () => Response.json(body, { status: 200 });
  }

  async function renderFresh() {
    /* The PAL half of canOffer(): a host that cannot run the hosted OAuth flow must not be offered
       it. Set in every case here, including the two that expect the block to stay hidden, so those
       prove the PROBE hid it rather than a missing platform method. */
    platform.cfConnect = async () => ({ connected: true });
    resetModelCache();
    const { container, mc } = makeConnect();
    mc.ensureProbe();
    await flush();
    return { container, mc };
  }

  test("a never-connected user is invited, with the Cloudflare button as the accent action", async () => {
    probeAnswers({ code: "cf_not_connected", configured: false, managed: true, models: [] });
    const { container, mc } = await renderFresh();
    expect(mc.canOffer()).toBe(true);
    const button = container.querySelector("sp-button");
    expect(button?.textContent?.trim()).toBe("Connect Cloudflare");
    // Accent is what makes it read as the recommendation rather than one of two equal choices.
    expect(button?.getAttribute("variant")).toBe("accent");
    expect(container.querySelector(".ai-managed-connect-lede")?.textContent).toContain(
      "Recommended",
    );
    // BYOK stays reachable — prioritised is not the same as exclusive.
    expect(container.querySelector(".ai-managed-connect-divider")?.textContent).toContain(
      "bring your own key",
    );
  });

  test("a lapsed grant is asked to RECONNECT, and told why", async () => {
    probeAnswers({ code: "cf_reconnect_required", configured: false, managed: true, models: [] });
    const { container } = await renderFresh();
    expect(container.querySelector("sp-button")?.textContent?.trim()).toBe("Reconnect Cloudflare");
    expect(container.querySelector(".ai-managed-connect-lede")?.textContent).toContain("expired");
  });

  test("a transient upstream error does NOT send the user round the OAuth flow", async () => {
    /* `cf_upstream_error` arrives with configured:true precisely so this block stays hidden —
       reconnecting fixes nothing when the fault is Cloudflare's, and offering it would teach the
       user that the button does not work. */
    probeAnswers({ code: "cf_upstream_error", configured: true, managed: true, models: [] });
    const { container, mc } = await renderFresh();
    expect(mc.canOffer()).toBe(false);
    expect(container.querySelector(".ai-managed-connect")).toBeNull();
  });

  test("a backend that sends no code still renders the plain invitation", async () => {
    // Older backends, and the dev server. No reason given is not an error state.
    probeAnswers({ configured: false, managed: true, models: [] });
    const { container } = await renderFresh();
    expect(container.querySelector("sp-button")?.textContent?.trim()).toBe("Connect Cloudflare");
  });

  test("a probe that fails outright leaves the option hidden — the shape of the outage", async () => {
    /* Pinned as the CONTRAST to the cases above: this is what the product actually did, and the
       reason the fix had to be a 200 with a code rather than a tidier error status. */
    fetchImpl = async () => Response.json({ error: "boom" }, { status: 500 });
    const { container, mc } = await renderFresh();
    expect(mc.canOffer()).toBe(false);
    expect(container.querySelector(".ai-managed-connect")).toBeNull();
  });
});
