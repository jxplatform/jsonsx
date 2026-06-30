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
    //
    // The studio SHELL loads over views:// (views://studio/index.html + its bundles). The canvas
    // Iframe loads CROSS-ORIGIN from the per-window loopback project server — but that server serves
    // Its studio assets out of studioDir(), which resolves to this staged views/studio dir (it probes
    // For canvas.html there). So canvas.html + dist/iframe-entry.js must ALSO be staged here; the
    // Loopback server reads them off disk and serves them over http (they are never fetched via the
    // Views:// scheme). Without these two entries the packaged canvas iframe 404s at boot.
    copy: {
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
    // Workaround for electrobun's broken Windows icon embedding; see the script header.
    postBuild: "./scripts/embed-windows-icon.ts",
  },
} satisfies ElectrobunConfig;
