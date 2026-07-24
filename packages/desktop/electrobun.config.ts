import type { ElectrobunConfig } from "electrobun";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default {
  app: {
    fileAssociations: [
      {
        ext: ["json"],
        name: "Jx Project",
        role: "Editor",
      },
    ],
    identifier: "com.jxsuite.jx-studio",
    name: "Jx Studio",
    version: pkg.version,
  },

  build: {
    bun: {
      entrypoint: "src/index.ts",
      external: [
        "dbus-ts",
        "@prettier/plugin-oxc",
        "@prettier/plugin-hermes",
        "@prettier/plugin-pug",
        "prettier-plugin-astro",
        "prettier-plugin-svelte",
        "prettier-plugin-marko",
        "@zackad/prettier-plugin-twig",
        "@shopify/prettier-plugin-liquid",
      ],
    },

    // "disable-site-isolation-trials" (all CEF platforms): keep the loopback canvas iframe in the
    // Studio shell's renderer process. As a cross-site OOPIF (views://studio shell +
    // Http://127.0.0.1 canvas), CEF Alloy's windowed drag-and-drop DELIVERS native dragover/drop to
    // The iframe but never propagates its accepted drop-effect to the native cursor feedback — a
    // Drag over the canvas shows the "not allowed" cursor the whole way even though the drop lands.
    // In-process, event routing matches the (verified-good) same-origin dev-server/chromium cases.
    // Process isolation is defense-in-depth only for this local trusted-author tool (electrobun
    // Already runs CEF with disable-web-security by default); JS same-origin checks are unaffected.
    mac: {
      bundleCEF: true,
      chromiumFlags: {
        "disable-site-isolation-trials": true,
      },
      codesign: true,
      defaultRenderer: "cef",
      notarize: true,
    },
    linux: {
      bundleCEF: true,
      chromiumFlags: {
        "disable-gpu": false,
        "disable-site-isolation-trials": true,
        "enable-features": "UseOzonePlatform",
        "ozone-platform-hint": "auto",
      },
      defaultRenderer: "cef",
      icon: "icon.png",
    },
    win: {
      bundleCEF: true,
      chromiumFlags: {
        "disable-site-isolation-trials": true,
      },
      defaultRenderer: "cef",
      icon: "icon.ico",
    },

    // PreBuild copies compiled studio + runtime assets into assets/ before these run.
    // Source paths are relative to packages/desktop/.
    //
    // The studio SHELL loads over views:// (views://studio/index.html + its bundles). The canvas
    // Iframe loads CROSS-ORIGIN from the per-window loopback project server — but that server serves
    // Its studio assets out of studioDir(), which resolves to this staged views/studio dir (it probes
    // For canvas.html there). So canvas.html + dist/iframe-entry.js must ALSO be staged here; the
    // Loopback server reads them off disk and serves them over http (they are never fetched via the
    // Views:// scheme). Without these two entries the packaged canvas iframe 404s at boot.
    copy: {
      // Static data for @jxsuite/create and @jxsuite/starters. Their JS is inlined into
      // App/bun/index.js, where import.meta.dirname resolves to app/bun/ at runtime — so the data
      // Dirs they read relative to it must be staged to exactly these paths.
      "../create/template": "bun/template",
      "../create/templates": "bun/templates",
      "../starters/registry.json": "bun/registry.json",
      "../starters/sites": "bun/sites",
      "assets/studio/canvas.html": "views/studio/canvas.html",
      "assets/studio/dist/iframe-entry.js": "views/studio/dist/iframe-entry.js",
      "assets/studio/dist/iframe-entry.js.map": "views/studio/dist/iframe-entry.js.map",
      "assets/studio/dist/init.js": "views/studio/dist/init.js",
      "assets/studio/dist/studio.css": "views/studio/dist/studio.css",
      "assets/studio/dist/studio.js": "views/studio/dist/studio.js",
      "assets/studio/index.html": "views/studio/index.html",
    },
  },

  release: {
    baseUrl: "https://github.com/jxsuite/jx/releases/latest/download/",
  },

  runtime: {
    exitOnLastWindowClosed: true,
  },

  scripts: {
    preBuild: "./scripts/pre-build.ts",
    // Verifies the staged bundle contents (fails the build on omissions), then chains the
    // Windows-icon workaround; see the script headers.
    postBuild: "./scripts/post-build.ts",
  },
} satisfies ElectrobunConfig;
