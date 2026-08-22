---
title: "Hosting the Studio assets"
description: "Serve the Jx Studio bundle from your own host: the asset manifest, the two layout modes, generated documents, and where your platform adapter plugs in."
spec:
  - studio.md#11.2 # the host contract
  - studio.md#11.1 # entry names and the entry-rooted asset rule
  - desktop.md#3.3 # the runtime half of the boot handshake
code:
  - packages/studio/src/hosting/layout.ts
  - packages/studio/src/hosting/document.ts
  - packages/studio/src/hosting/stage.ts
---

# Hosting the Studio assets

[Writing a platform adapter](/docs/extending/embedding/platform-adapter) covers the half of embedding that answers Studio's questions. This page covers the other half: putting the editor on a screen. They are independent — you can serve the assets and reuse a stock adapter, or write an adapter and let the desktop app serve it.

`@jxsuite/studio` ships a tree whose parts already know how to find each other. The entry reaches its own chunks and workers, the bundle stylesheet reaches Monaco's icon font, and the chrome stylesheet reaches the vendored webfonts. Your job is to keep those relationships intact and tell Studio where the tree ended up.

## The manifest

`@jxsuite/studio/hosting/layout` says what ships. It is pure — no filesystem, no DOM — so it reads the same from a Cloudflare Worker build, a Vite plugin, a Deno host or a Nix derivation.

```ts
import { STUDIO_ASSETS } from "@jxsuite/studio/hosting/layout";

for (const asset of STUDIO_ASSETS) {
  asset.path; // "dist/studio.js", "dist/chunks", "styles", …
  asset.dir; // true when the directory ships wholesale, names intact
  asset.required; // false means you may omit it and lose a feature, not the editor
  asset.why; // what the reader loses without it
}
```

If your build cannot import TypeScript at all, the same data is emitted as `dist/manifest.json`.

:::doc-warning
Do not write your own list. Every host that has done so has shipped an incomplete one — including this project's own desktop app, which for months omitted `dist/codicon.ttf` and drew empty boxes wherever Monaco draws an icon. Nothing errored, because a missing font is not an error.
:::

## Two layouts, one rule

`assetUrl(base, path)` maps a package path to the URL your host answers on.

```ts
import { assetUrl } from "@jxsuite/studio/hosting/layout";

const nested = { mode: "nested", prefix: "/studio-assets/" } as const;
assetUrl(nested, "dist/studio.js"); // "/studio-assets/dist/studio.js"

const flat = { mode: "flat", prefix: "/" } as const;
assetUrl(flat, "dist/studio.js"); // "/studio.js"
assetUrl(flat, "dist/chunks/a.js"); // "/chunks/a.js"
```

`flat` strips exactly one leading `dist/` segment and nothing else. That is the whole rule, and it is what makes flattening safe: everything inside `dist/` addresses everything else inside `dist/` relatively, so removing one segment moves all of it together. `styles/` and `fonts/` are untouched in both modes, which is why the chrome stylesheet's `url("../fonts/…")` resolves either way.

## Staging the files

If your host runs Bun or Node, `@jxsuite/studio/hosting` will copy the tree for you:

```ts
import { stageStudioAssets } from "@jxsuite/studio/hosting";

const { base } = await stageStudioAssets("./public/studio-assets", {
  prefix: "/studio-assets/",
});
```

It returns the `base` it staged at — hand that straight to the document generator below, so the two cannot disagree about where the files went. It skips source maps by default (the chunk maps alone are about 24 MB), and it refuses rather than staging an incomplete tree, naming both the missing entry and what its absence costs.

This module is a convenience, and the only one that touches the filesystem. A host in another runtime reads the manifest and moves the bytes itself.

## The documents

Studio needs two HTML documents. Generate them; do not copy and rewrite them.

```ts
import { studioShellHtml } from "@jxsuite/studio/hosting/document";
import { canvasDocument } from "@jxsuite/studio/hosting";

const editor = studioShellHtml({ base, boot: ["/my-platform-init.js"] });
const canvas = await canvasDocument({ base });
```

`studioShellHtml` emits the editor document with every asset reference rebased and the chrome stylesheets linked in cascade order. `canvasDocument` reads the package's canvas document and rebases its one entry reference — that document stays hand-authored, because the `<style>` block in it establishes the sizing container the canvas measures against and has to apply before the first paint.

:::doc-note
Serve the editor document for **every** path the editor lives at. If your editor URL contains the project — `/edit/:owner/:repo` — the document is served from a deep path, and any document-relative reference in it would resolve into the wrong directory. Generating it with an absolute `base` is what makes that a non-issue.
:::

## Where your adapter plugs in

`boot` is the seam. The modules you name load, in order, **before** the Studio entry:

```html
<script type="module" src="/my-platform-init.js"></script>
<script type="module" src="/studio-assets/dist/studio.js"></script>
```

Your boot module registers the platform, exactly as [Writing a platform adapter](/docs/extending/embedding/platform-adapter) describes — and it must do so **synchronously, before its first `await`**. A module script with top-level `await` does not block a later `<script>` tag, and the Studio entry reads the global as it evaluates.

```ts
// my-platform-init.ts
import { registerPlatform } from "@jxsuite/studio/platform";
registerPlatform(createMyPlatform()); // first, before anything async
```

## Two things hosts get wrong

**Serving the package's own `index.html` as well as your generated one.** If your generated editor lives at `/edit/*` and the package's copy is also reachable under your asset prefix, that second document boots Studio with the _default_ adapter — the dev-server one — which then fetches `/__studio/*` against your origin. Under a single-page-application fallback those fetches answer with your marketing page at HTTP 200, so nothing errors and nothing logs. Pass `exclude: ["document"]` to `stageStudioAssets` and generate both documents yourself.

**Resolving `canvasUrl` asynchronously without saying so.** If your adapter learns its canvas URL after `activate()`, set `canvasUrlDeferred: true` on it. Studio then waits instead of mounting the bundle-relative default into your shell's origin.

## Related

- [Writing a platform adapter](/docs/extending/embedding/platform-adapter) — the interface your boot module registers
- [The backend protocol](/docs/extending/embedding/backend-protocol) — what the stock adapters speak
- [Embedding overview](/docs/extending/embedding) — which layer to implement
