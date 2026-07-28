import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {}

/*
 * Don't let happy-dom actually navigate iframes.
 *
 * `mountIframeCanvas` gives its iframe a real `src` (the token-gated `canvas.html` on the loopback
 * origin). happy-dom takes that literally and issues an HTTP request, which fails with ECONNREFUSED
 * because no dev server runs under `bun test`. Nothing awaits those requests, so the rejections sat
 * unobserved — until a test yielded to the event loop long enough (awaiting a
 * `requestAnimationFrame`, say) for one to surface as an unhandled rejection and take the whole test
 * file down with it. The canvas bridge is exercised through `fakeChannelPair`, never through a real
 * page load, so the fetch was never wanted here.
 */
const { happyDOM } = globalThis as {
  happyDOM?: { settings?: { disableIframePageLoading?: boolean } };
};
if (happyDOM?.settings) {
  happyDOM.settings.disableIframePageLoading = true;
}
