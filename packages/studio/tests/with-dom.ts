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

/*
 * Anchor the bundle base, which only an ENTRY sets in production (`src/services/bundle-base.ts`).
 *
 * `bun test` imports modules directly, so no entry runs and `bundleUrl()` would throw — correctly,
 * but uselessly, in every suite that reaches a Monaco worker url or the default canvas url. Set the
 * url the repo dev server really serves the entry from, so those suites resolve exactly what a
 * browser at `http://localhost:3000/packages/studio/index.html` resolves.
 *
 * This file rather than `harness.ts`: `harness.ts` imports it, and 127 test files import `with-dom`
 * directly without the harness.
 */
const { setBundleBase } = await import("../src/services/bundle-base");
setBundleBase("http://localhost:3000/packages/studio/dist/studio.js");
