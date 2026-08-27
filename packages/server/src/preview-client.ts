/**
 * The script a live-preview page runs: reload when the tree changes, follow a retarget, and say so
 * when the origin is gone.
 *
 * It ships as a string rather than a file because it is served, not imported — the page that runs
 * it is on a different origin from anything in this package, and generating it is how the URLs it
 * needs stay a fact of the server that serves it.
 *
 * Three behaviours are here rather than in the page because only this side can know them:
 *
 * **A reload, not an in-place re-render.** The runtime cannot be re-run over a live document:
 * `Jx()` does not scope its effects, a custom element cannot be re-registered in a realm (so an
 * edited component would keep its old class forever), the document cache has no invalidation,
 * `$head` would be injected twice, and the shell renders the head server-side anyway. A document
 * load is the only thing that is actually correct, and it is cheap here because composing is
 * local.
 *
 * **Scroll is restored by hand.** The browser's own restoration runs against the document as it
 * exists at that moment, and a client-rendered page has an empty body then — so it restores to a
 * zero-height document and lands at the top. The shell turns it off; this puts it back after the
 * render, and keeps re-applying briefly because content resolved after mount changes the height.
 *
 * **A dead origin is distinguished from a restarting one.** EventSource retries forever and cannot
 * tell the two apart, so after enough consecutive failures this asks: one fetch that a live origin
 * always answers. A network error means the project closed, and then the stream is stopped rather
 * than left retrying every half-second for as long as the tab is open. The last render stays on
 * screen, because it is still what the reader was reading.
 */

/** Where the client's own surfaces live, so the page and the server cannot disagree about them. */
export const LIVE_NAMESPACE = "/__jx_live__";

/** Consecutive reconnect failures before the client asks whether the origin is gone at all. */
const PROBE_AFTER_FAILURES = 20;

/** How long the restore keeps re-applying, for content that resolves after the render. */
const SCROLL_SETTLE_MS = 1500;

/**
 * The reload client, as source.
 *
 * Written as one string with no build step: it is ~80 lines of DOM code that must run in a page
 * this package does not otherwise touch, and a bundler in the path would be a second thing to keep
 * working for no gain.
 */
export const PREVIEW_CLIENT_JS = `
const NS = ${JSON.stringify(LIVE_NAMESPACE)};
const KEY = "jx-preview-scroll";
let failures = 0;
let stopped = false;
let source = null;

/* The banner lives in a shadow root: the page around it is the project's own site, carrying the
   project's own CSS, which is free to style every div on the page. */
function banner(text, tone) {
  let host = document.getElementById("jx-preview-status");
  if (!host) {
    host = document.createElement("div");
    host.id = "jx-preview-status";
    document.documentElement.append(host);
    host.attachShadow({ mode: "open" });
  }
  host.shadowRoot.innerHTML = text
    ? '<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      "font:13px/1.4 system-ui,sans-serif;padding:8px 12px;color:#fff;background:" +
      (tone === "dead" ? "#8a1c1c" : "#444") + ';">' + text + "</div>"
    : "";
}

function saveScroll() {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ path: location.pathname, x: scrollX, y: scrollY }),
    );
  } catch {}
}

/* Restored after the render resolves, then re-applied for a moment: a page whose height depends on
   data fetched after mount is shorter at restore time than it will be a tick later. */
function restoreScroll() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
  } catch {}
  if (!saved || saved.path !== location.pathname || (saved.x === 0 && saved.y === 0)) {
    return;
  }
  const until = Date.now() + ${SCROLL_SETTLE_MS};
  const apply = () => {
    scrollTo(saved.x, saved.y);
    if (Date.now() < until) {
      requestAnimationFrame(apply);
    }
  };
  apply();
}

function reload() {
  saveScroll();
  location.reload();
}

function connect() {
  if (stopped) {
    return;
  }
  source = new EventSource(NS + "/reload?route=" + encodeURIComponent(location.pathname));
  source.onopen = () => {
    failures = 0;
    banner("");
  };
  source.onmessage = reload;
  source.addEventListener("navigate", (event) => {
    const message = JSON.parse(event.data);
    /* Acknowledge BEFORE navigating: the navigation tears this stream down, so an ack sent after
       it would never leave the tab, and the editor would open a second one. */
    fetch(NS + "/ack", {
      body: JSON.stringify({ gen: message.gen }),
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      method: "POST",
    }).catch(() => {});
    /* Best effort, and never advertised: a background tab cannot raise itself in Chrome, and
       under Wayland the compositor arbitrates. It costs one line and occasionally works. */
    try {
      window.focus();
    } catch {}
    if (message.route === location.pathname) {
      reload();
    } else {
      saveScroll();
      location.assign(message.route);
    }
  });
  source.onerror = () => {
    failures += 1;
    if (failures === 1) {
      /* A restart reconnects inside half a second, so saying anything now is noise. */
      setTimeout(() => {
        if (failures > 0 && !stopped) {
          banner("Preview disconnected — reconnecting…", "warn");
        }
      }, 2000);
    }
    if (failures >= ${PROBE_AFTER_FAILURES}) {
      probe();
    }
  };
}

/* EventSource cannot tell "restarting" from "gone", so ask something a live origin always answers. */
function probe() {
  fetch(NS + "/ping", { cache: "no-store" }).catch(() => {
    stopped = true;
    if (source) {
      source.close();
    }
    banner(
      "This preview is no longer live — Jx Studio closed this project. " +
        "The page below is the last render.",
      "dead",
    );
  });
}

addEventListener("pagehide", saveScroll);
/* A tab restored from the back/forward cache has a suspended stream and a stale document, and no
   reload will arrive to fix either. */
addEventListener("pageshow", (event) => {
  if (event.persisted) {
    location.reload();
  }
});
restoreScroll();
connect();
`;
