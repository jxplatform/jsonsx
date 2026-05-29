import type { ElectrobunConfig } from "electrobun";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

export default {
  app: {
    name: "Jx Studio",
    identifier: "com.jxsuite.jx-studio",
    version: pkg.version,
    fileAssociations: [
      {
        name: "Jx Project",
        ext: ["json"],
        role: "Editor",
      },
    ],
  },

  runtime: {
    exitOnLastWindowClosed: true,
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
      defaultRenderer: "cef",
      codesign: true,
      notarize: true,
    },
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
      icon: "icon.png",
      chromiumFlags: {
        "ozone-platform-hint": "auto",
        "enable-features": "UseOzonePlatform",
        "disable-gpu": false,
      },
    },
    win: {
      bundleCEF: true,
      defaultRenderer: "cef",
      icon: "icon.ico",
    },

    // preBuild copies compiled studio + runtime assets into assets/ before these run.
    // Source paths are relative to packages/desktop/.
    copy: {
      "assets/studio/index.html": "views/studio/index.html",
      "assets/studio/dist/studio.css": "views/studio/dist/studio.css",
      "assets/studio/dist/studio.js": "views/studio/dist/studio.js",
      "assets/studio/dist/init.js": "views/studio/dist/init.js",
    },
  },

  scripts: {
    preBuild: "./scripts/pre-build.ts",
  },

  release: {
    baseUrl: "https://github.com/jxsuite/jx/releases/latest/download/",
  },
} satisfies ElectrobunConfig;
