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

    mac: {
      bundleCEF: true,
      codesign: true,
      defaultRenderer: "cef",
      notarize: false,
    },
    linux: {
      bundleCEF: true,
      chromiumFlags: {
        "disable-gpu": false,
        "enable-features": "UseOzonePlatform",
        "ozone-platform-hint": "auto",
      },
      defaultRenderer: "cef",
      icon: "icon.png",
    },
    win: {
      bundleCEF: true,
      defaultRenderer: "cef",
      icon: "icon.ico",
    },

    // PreBuild copies compiled studio + runtime assets into assets/ before these run.
    // Source paths are relative to packages/desktop/.
    copy: {
      "assets/studio/dist/init.js": "views/studio/dist/init.js",
      "assets/studio/dist/studio.css": "views/studio/dist/studio.css",
      "assets/studio/dist/studio.js": "views/studio/dist/studio.js",
      "assets/studio/index.html": "views/studio/index.html",
      // Phase 7: ship the iframe canvas under views:// so the DEFAULT_CANVAS_URL fallback
      // (/packages/studio/canvas.html → views/studio/packages/studio/canvas.html) resolves on the
      // Gate-off path AND under MSIX. canvas.html imports ./dist/iframe-entry.js relative to ITSELF,
      // So the bundle lands beside it at views/studio/packages/studio/dist/ (the spec's
      // "views/studio/dist/" target predates the nested canvas.html location).
      "assets/studio/canvas.html": "views/studio/packages/studio/canvas.html",
      "assets/studio/dist/iframe-entry.js": "views/studio/packages/studio/dist/iframe-entry.js",
      "assets/studio/dist/iframe-entry.js.map":
        "views/studio/packages/studio/dist/iframe-entry.js.map",
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
    // Workaround for electrobun's broken Windows icon embedding; see the script header.
    postBuild: "./scripts/embed-windows-icon.ts",
  },
} satisfies ElectrobunConfig;
