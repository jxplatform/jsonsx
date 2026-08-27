/**
 * The live preview origin: what it serves, what it refuses, and the two answers a caller acts on.
 *
 * Three properties here are the whole feature and each is a real regression risk: an overlay
 * published BEFORE the origin exists still reaches the first render; a burst of changes is one
 * reload rather than one per change; and a retarget reports whether a tab actually took it, because
 * a frozen tab looks connected and will not act.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clearLivePreviewOverlay,
  livePreviewClients,
  livePreviewOrigin,
  navigateLivePreview,
  notifyLivePreviewChange,
  setLivePreviewOverlay,
  startLivePreview,
  stopLivePreviews,
} from "../src/live-preview";

const TMP = resolve(import.meta.dir, "__test-live-preview__");
const OTHER = resolve(import.meta.dir, "__test-live-preview-other__");

function write(root: string, relPath: string, content: string | object) {
  const abs = resolve(root, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

const LAYOUT = {
  $head: [{ attributes: { href: "/styles/main.css", rel: "stylesheet" }, tagName: "link" }],
  children: [{ children: ["Site chrome"], tagName: "header" }, { tagName: "slot" }],
  tagName: "body",
};

const INDEX = {
  $elements: [{ $ref: "./components/card.json" }],
  $layout: "./layouts/base.json",
  children: [{ children: ["Hello from disk"], tagName: "h1" }],
  tagName: "main",
  title: "Home",
};

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  rmSync(OTHER, { force: true, recursive: true });
  write(TMP, "project.json", { name: "Probe Site", style: { "--brand": "rebeccapurple" } });
  write(TMP, "layouts/base.json", LAYOUT);
  write(TMP, "pages/index.json", INDEX);
  write(TMP, "pages/blog/[slug].json", {
    $layout: "./layouts/base.json",
    children: [{ children: ["A post"], tagName: "h1" }],
    tagName: "main",
  });
  write(TMP, "pages/404.json", { children: ["Nothing here"], tagName: "main" });
  write(TMP, "pages/orphan.json", { $layout: "./layouts/gone.json", tagName: "main" });
  write(TMP, "public/styles.css", "body { margin: 0 }");
  write(TMP, ".dev.vars", "SECRET=hunter2");
  write(OTHER, "project.json", { name: "Other" });
  write(OTHER, "pages/index.json", { children: ["Other site"], tagName: "main" });
});

afterEach(() => {
  clearLivePreviewOverlay(TMP);
  clearLivePreviewOverlay(OTHER);
});

afterAll(() => {
  stopLivePreviews();
  rmSync(TMP, { force: true, recursive: true });
  rmSync(OTHER, { force: true, recursive: true });
});

/** The status of a GET, without reaching into an awaited expression. */
async function statusOf(origin: string, path: string): Promise<number> {
  const page = await get(origin, path);
  return page.status;
}

/** The body of a GET. */
async function bodyOf(origin: string, path: string): Promise<string> {
  const page = await get(origin, path);
  return page.body;
}

/** The JSON payload the shell inlines for the runtime. */
function payloadOf(html: string): string {
  return html.split('id="jx-page-document">')[1]!.split("</script>")[0]!;
}

/** GET on the project's origin. */
async function get(origin: string, path: string) {
  const response = await fetch(origin + path);
  return {
    body: await response.text(),
    status: response.status,
    type: response.headers.get("Content-Type"),
  };
}

/** The client count once every pending cancel has reached the server. */
async function settledClients(): Promise<number> {
  let count = livePreviewClients(TMP);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(10);
    const next = livePreviewClients(TMP);
    if (next === count) {
      return count;
    }
    count = next;
  }
  return count;
}

/** Open the reload stream and return a reader plus a one-frame helper. */
async function openStream(origin: string, route = "/") {
  const response = await fetch(`${origin}/__jx_live__/reload?route=${encodeURIComponent(route)}`);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const frame = async () => {
    const chunk = await reader.read();
    return new TextDecoder().decode(chunk.value);
  };
  await frame(); // The `retry:` field, always first.
  return { frame, reader };
}

describe("the origin", () => {
  test("one per project root, reused — ten pages open one port", async () => {
    const first = await startLivePreview(TMP);
    const second = await startLivePreview(TMP);
    expect(second.origin).toBe(first.origin);
    expect(livePreviewOrigin(TMP)).toBe(first.origin);
  });

  test("a different project gets a different origin", async () => {
    const mine = await startLivePreview(TMP);
    const other = await startLivePreview(OTHER);
    expect(other.origin).not.toBe(mine.origin);
  });

  test("it is bound to loopback", async () => {
    const preview = await startLivePreview(TMP);
    expect(preview.origin).toStartWith("http://127.0.0.1:");
  });

  test("no origin exists for a project nobody previewed", () => {
    expect(livePreviewOrigin(resolve(TMP, "..", "never-previewed"))).toBeNull();
  });

  test("it counts the routes it can answer before it answers", async () => {
    // "0 pages" from a site with pages is a worse first impression than the walk costs.
    const preview = await startLivePreview(TMP);
    expect(preview.routes).toBe(4);
  });
});

describe("what it serves", () => {
  test("a page renders as a shell that hands the document to the runtime", async () => {
    const { origin } = await startLivePreview(TMP);
    const page = await get(origin, "/");
    expect(page.status).toBe(200);
    expect(page.type).toBe("text/html; charset=utf-8");
    expect(page.body).toContain('id="jx-page-document"');
    expect(page.body).toContain('{ base: "/" }');
  });

  test("the head is rendered server-side and removed from the document", async () => {
    const { origin } = await startLivePreview(TMP);
    const { body } = await get(origin, "/");
    expect(body.split("</head>")[0]).toContain("<title>Home</title>");
    expect(body.split("</head>")[0]).toContain("/styles/main.css");
    expect(JSON.parse(payloadOf(body)).$head).toBeUndefined();
  });

  test("a page-declared custom element survives the layout wrap", async () => {
    const { origin } = await startLivePreview(TMP);
    const { body } = await get(origin, "/");
    expect(JSON.parse(payloadOf(body)).$elements).toEqual([{ $ref: "./components/card.json" }]);
  });

  test("a dynamic route matches on demand — $paths is not expanded", async () => {
    const { origin } = await startLivePreview(TMP);
    expect(await statusOf(origin, "/blog/anything/")).toBe(200);
  });

  test("a public/ file is served at the site path a build would give it", async () => {
    const { origin } = await startLivePreview(TMP);
    const asset = await get(origin, "/styles.css");
    expect(asset.status).toBe(200);
    expect(asset.type).toBe("text/css; charset=utf-8");
  });

  test("the project's own 404 page answers a miss, at 404", async () => {
    const { origin } = await startLivePreview(TMP);
    const miss = await get(origin, "/nope");
    expect(miss.status).toBe(404);
    expect(miss.body).toContain("Nothing here");
  });

  test("project.json is readable by the composer and not by a reader", async () => {
    const { origin } = await startLivePreview(TMP);
    expect(await statusOf(origin, "/project.json")).toBe(404);
  });

  test("a secret in the project root is not servable", async () => {
    // The page running here is the project's own JavaScript, third-party script included.
    const { origin } = await startLivePreview(TMP);
    expect(await statusOf(origin, "/.dev.vars")).toBe(404);
  });

  test("the editor's own namespace does not exist on this origin", async () => {
    const { origin } = await startLivePreview(TMP);
    expect(await statusOf(origin, "/__studio__/canvas.html")).toBe(404);
  });

  test("traversal is refused rather than resolved", async () => {
    const { origin } = await startLivePreview(TMP);
    expect(await statusOf(origin, "/../../etc/passwd")).toBe(404);
  });
});

describe("the host's own namespace", () => {
  test("the runtime bundle is served, and cached hard", async () => {
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/__jx_live__/runtime.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(await response.text()).toContain("Jx");
  });

  test("the reload client is served, and never cached", async () => {
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/__jx_live__/client.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(await response.text()).toContain("EventSource");
  });

  test("project.json's style is served as a stylesheet", async () => {
    const { origin } = await startLivePreview(TMP);
    const css = await get(origin, "/__jx_live__/site.css");
    expect(css.status).toBe(200);
    expect(css.type).toBe("text/css; charset=utf-8");
    expect(css.body).toContain("--brand: rebeccapurple");
  });

  test("a project with no style declared gets an empty sheet rather than an error", async () => {
    const { origin } = await startLivePreview(OTHER);
    const css = await get(origin, "/__jx_live__/site.css");
    expect(css.status).toBe(200);
    expect(css.body).toBe("");
  });

  test("ping is what a client asks when it cannot tell restarting from gone", async () => {
    const { origin } = await startLivePreview(TMP);
    expect(await statusOf(origin, "/__jx_live__/ping")).toBe(200);
  });

  test("an unknown surface in the namespace is a 404, not a page", async () => {
    const { origin } = await startLivePreview(TMP);
    expect(await statusOf(origin, "/__jx_live__/nope")).toBe(404);
  });

  test("ack refuses a body it cannot read", async () => {
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/__jx_live__/ack`, { body: "{oops", method: "POST" });
    expect(response.status).toBe(400);
  });
});

describe("the resolver, on this origin's own credential", () => {
  test("without the token it is forbidden", async () => {
    // The route does a dynamic import() of project code; the token is minted per origin so that
    // Compromising the editor's does not hand this one over.
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/__jx_resolve__`, { body: "{}", method: "POST" });
    expect(response.status).toBe(403);
  });

  test("the token the shell carries is the one that opens it", async () => {
    const { origin } = await startLivePreview(TMP);
    const { body } = await get(origin, "/");
    const token = /setResolveToken\("([^"]+)"\)/.exec(body)?.[1];
    expect(token).toBeTruthy();
    const response = await fetch(`${origin}/__jx_resolve__?token=${token}`, {
      body: JSON.stringify({}),
      method: "POST",
    });
    // Past the gate: a missing $src is the route's own complaint, not the gate's.
    expect(response.status).not.toBe(403);
  });

  test("server functions are gated the same way", async () => {
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/__jx_server__`, { body: "{}", method: "POST" });
    expect(response.status).toBe(403);
  });
});

describe("the overlay", () => {
  test("an overlay published BEFORE the origin exists reaches the first render", async () => {
    // The flush on the way to opening a tab publishes exactly here, so an overlay tied to the
    // Origin's lifetime would lose the newest edit on the one render the author is watching for.
    setLivePreviewOverlay(
      TMP,
      "pages/index.json",
      JSON.stringify({ children: ["Hello from the canvas"], tagName: "main" }),
    );
    const { origin } = await startLivePreview(TMP);
    const { body } = await get(origin, "/");
    expect(body).toContain("Hello from the canvas");
    expect(body).not.toContain("Hello from disk");
  });

  test("clearing one document falls back to what is on disk", async () => {
    const { origin } = await startLivePreview(TMP);
    setLivePreviewOverlay(
      TMP,
      "pages/index.json",
      JSON.stringify({ children: ["Unsaved"], tagName: "main" }),
    );
    expect(await bodyOf(origin, "/")).toContain("Unsaved");
    clearLivePreviewOverlay(TMP, "pages/index.json");
    expect(await bodyOf(origin, "/")).toContain("Hello from disk");
  });

  test("an unsaved LAYOUT changes the page that uses it", async () => {
    // The previewed page is not the only document that matters, and a layout lives in another tab.
    const { origin } = await startLivePreview(TMP);
    setLivePreviewOverlay(
      TMP,
      "layouts/base.json",
      JSON.stringify({
        children: [{ children: ["New chrome"], tagName: "header" }, { tagName: "slot" }],
        tagName: "body",
      }),
    );
    expect(payloadOf(await bodyOf(origin, "/"))).toContain("New chrome");
  });

  test("an unsaved page adds a route the disk does not have", async () => {
    const { origin } = await startLivePreview(TMP);
    expect(await statusOf(origin, "/brand-new/")).toBe(404);
    setLivePreviewOverlay(
      TMP,
      "pages/brand-new.json",
      JSON.stringify({ children: ["Brand new"], tagName: "main" }),
    );
    expect(await statusOf(origin, "/brand-new/")).toBe(200);
  });

  test("clearing everything returns the origin to the disk", async () => {
    const { origin } = await startLivePreview(TMP);
    setLivePreviewOverlay(
      TMP,
      "pages/index.json",
      JSON.stringify({ children: ["Unsaved"], tagName: "main" }),
    );
    clearLivePreviewOverlay(TMP);
    expect(await bodyOf(origin, "/")).toContain("Hello from disk");
  });

  test("one project's overlay does not reach another's origin", async () => {
    const mine = await startLivePreview(TMP);
    const other = await startLivePreview(OTHER);
    setLivePreviewOverlay(
      TMP,
      "pages/index.json",
      JSON.stringify({ children: ["Mine only"], tagName: "main" }),
    );
    expect(await bodyOf(mine.origin, "/")).toContain("Mine only");
    expect(await bodyOf(other.origin, "/")).not.toContain("Mine only");
  });

  test("clearing a project that never published anything is a no-op", () => {
    expect(() => {
      clearLivePreviewOverlay(resolve(TMP, "..", "never-published"));
    }).not.toThrow();
  });

  /*
   * Studio retracts per document, and it retracts documents it never published — a tab closed
   * without an edit runs the same path as one closed with unsaved bytes. Naming a document the
   * overlay does not hold must therefore leave the ones it DOES hold exactly where they were.
   */
  test("retracting a document that was never published leaves the others standing", async () => {
    const { origin } = await startLivePreview(TMP);
    setLivePreviewOverlay(
      TMP,
      "pages/index.json",
      JSON.stringify({ children: ["Unsaved"], tagName: "main" }),
    );
    clearLivePreviewOverlay(TMP, "pages/never-published.json");
    expect(await bodyOf(origin, "/")).toContain("Unsaved");
  });
});

describe("reading the tree", () => {
  test("an unsaved ASSET is served from the overlay, not from disk", async () => {
    // Not only documents: a stylesheet the author is editing is a file the page asks for by URL.
    const { origin } = await startLivePreview(TMP);
    setLivePreviewOverlay(TMP, "public/styles.css", "body { margin: 99px }");
    const css = await get(origin, "/styles.css");
    expect(css.body).toBe("body { margin: 99px }");
  });

  test("a document the tree does not have reads as absent rather than throwing", async () => {
    const { origin } = await startLivePreview(TMP);
    /* The route table names it — an overlay put it there — and then the overlay is dropped, so the
       composer asks for a file nothing can produce. */
    setLivePreviewOverlay(TMP, "pages/ghost.json", JSON.stringify({ tagName: "main" }));
    await get(origin, "/ghost/");
    clearLivePreviewOverlay(TMP, "pages/ghost.json");
    expect(await statusOf(origin, "/ghost/")).toBe(404);
  });

  test("a page whose layout is not there names the layout", async () => {
    // The read fails inside the layout loader, and the reader gets a sentence rather than a 500.
    const { origin } = await startLivePreview(TMP);
    const page = await get(origin, "/orphan/");
    expect(page.status).toBe(500);
    expect(page.body).toContain("./layouts/gone.json");
  });

  test("a request path that is not decodable is refused, not guessed at", async () => {
    const { origin } = await startLivePreview(TMP);
    const response = await fetch(`${origin}/%E0%A4%A`);
    expect(response.status).toBe(400);
  });
});

describe("live reload", () => {
  test("a change reaches a connected tab", async () => {
    const { origin } = await startLivePreview(TMP);
    const { frame, reader } = await openStream(origin);
    notifyLivePreviewChange(TMP);
    expect(await frame()).toBe("id: 1\ndata: reload\n\n");
    await reader.cancel();
  });

  test("a burst is ONE reload — a save fires the overlay clear and the watcher both", async () => {
    const { origin } = await startLivePreview(TMP);
    const { frame, reader } = await openStream(origin);
    setLivePreviewOverlay(TMP, "pages/index.json", JSON.stringify({ tagName: "main" }));
    setLivePreviewOverlay(TMP, "layouts/base.json", JSON.stringify(LAYOUT));
    notifyLivePreviewChange(TMP);
    expect(await frame()).toContain("data: reload");
    // Nothing else is queued behind it: the next frame is a NEW change, not a backlog.
    notifyLivePreviewChange(TMP);
    expect(await frame()).toContain("data: reload");
    await reader.cancel();
  });

  test("republishing identical bytes is not a change", async () => {
    const { origin } = await startLivePreview(TMP);
    const bytes = JSON.stringify({ children: ["Same"], tagName: "main" });
    setLivePreviewOverlay(TMP, "pages/index.json", bytes);
    const { frame, reader } = await openStream(origin);
    await frame(); // The reload the first publish scheduled.
    setLivePreviewOverlay(TMP, "pages/index.json", bytes);
    notifyLivePreviewChange(TMP);
    // One frame, from the notify — the identical republish contributed nothing.
    expect(await frame()).toContain("data: reload");
    await reader.cancel();
  });

  test("a change with nobody watching is not an error", () => {
    expect(() => {
      notifyLivePreviewChange(TMP);
    }).not.toThrow();
  });

  test("a change to a project with no origin is not an error", () => {
    expect(() => {
      notifyLivePreviewChange(resolve(TMP, "..", "no-origin"));
    }).not.toThrow();
  });
});

describe("retargeting the project's tab", () => {
  test("with no tab connected, the caller is told to open one", async () => {
    await startLivePreview(TMP);
    expect(await navigateLivePreview(TMP, "/blog/hello/")).toBe(false);
  });

  test("with no origin at all, the caller is told to open one", async () => {
    expect(await navigateLivePreview(resolve(TMP, "..", "no-origin"), "/")).toBe(false);
  });

  test("a tab that acknowledges takes the route, and the caller opens nothing", async () => {
    const { origin } = await startLivePreview(TMP);
    const { frame, reader } = await openStream(origin);
    const pending = navigateLivePreview(TMP, "/blog/hello/");
    const sent = await frame();
    const message = JSON.parse(sent.split("data: ")[1]!);
    expect(message.route).toBe("/blog/hello/");
    await fetch(`${origin}/__jx_live__/ack`, {
      body: JSON.stringify({ gen: message.gen }),
      method: "POST",
    });
    expect(await pending).toBe(true);
    await reader.cancel();
  });

  test("a tab that looks connected and does not answer times out", async () => {
    // A frozen or back/forward-cached tab is exactly this: the stream is open and nothing acts.
    const { origin } = await startLivePreview(TMP);
    const { reader } = await openStream(origin);
    expect(await navigateLivePreview(TMP, "/blog/hello/")).toBe(false);
    await reader.cancel();
  });

  test("a stale ack cannot answer for the current retarget", async () => {
    const { origin } = await startLivePreview(TMP);
    const { frame, reader } = await openStream(origin);
    const first = navigateLivePreview(TMP, "/a/");
    const sent = await frame();
    const { gen: firstGen } = JSON.parse(sent.split("data: ")[1]!);
    expect(await first).toBe(false);
    const second = navigateLivePreview(TMP, "/b/");
    await frame();
    await fetch(`${origin}/__jx_live__/ack`, {
      body: JSON.stringify({ gen: firstGen }),
      method: "POST",
    });
    expect(await second).toBe(false);
    await reader.cancel();
  });

  test("clientCount is what the decision reads, and a closed tab leaves", async () => {
    /* Measured as a delta, and settled for. A cancel reaches the server a tick after the reader
       returns, so an absolute count here would be reading another test's teardown. */
    const { origin } = await startLivePreview(TMP);
    const before = await settledClients();
    const { reader } = await openStream(origin);
    expect(livePreviewClients(TMP)).toBe(before + 1);
    await reader.cancel();
    expect(await settledClients()).toBe(before);
  });

  test("a project with no origin has no clients", () => {
    expect(livePreviewClients(resolve(TMP, "..", "no-origin"))).toBe(0);
  });
});
