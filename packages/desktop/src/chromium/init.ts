import { registerPlatform } from "@jxsuite/studio/platform";
import { createDesktopPlatform } from "./platform";

// CreateDesktopPlatform reads ?token from the shell URL to authenticate its WS upgrade.
registerPlatform(createDesktopPlatform());

// Strip ?token from the address bar after boot so it never leaks (e.g. via a Referer header or a
// Copy-pasted URL). The platform already captured it above; the loopback bind + only-our-HTML-at-
// Origin invariant is the real boundary. Best-effort: guarded for non-browser (test) environments.
try {
  const url = new URL(location.href);
  if (url.searchParams.has("token")) {
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
} catch {}
