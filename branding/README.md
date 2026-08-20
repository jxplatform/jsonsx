# Jx Branding

The Jx Suite logo, and the one file every icon in the product is derived from.

| File               | What it is                                                                  |
| ------------------ | --------------------------------------------------------------------------- |
| `jx.svg`           | The editable master: a live `<text>` element set in **Cascadia Code**       |
| `jx_flattened.svg` | The same mark with that text converted to a `<path>` — **the one consumed** |
| `jx.png`           | A 640×640 RGBA raster of the mark                                           |

Both SVGs are `viewBox="0 0 32 32"` and were last edited in Inkscape.

## The two SVGs are not interchangeable

`jx.svg` renders correctly only where [Cascadia
Code](https://fonts.google.com/specimen/Cascadia+Code) is installed — everywhere else the browser
or renderer substitutes a fallback and the wordmark is silently wrong. `jx_flattened.svg` carries
no text at all, so it renders identically everywhere. That is why **every consumer in this
repository points at the flattened file** and nothing points at `jx.svg`.

Keep `jx.svg` as the thing you edit, and treat `jx_flattened.svg` as build output you regenerate
from it. Editing the master alone changes nothing anyone sees.

## What derives from `jx_flattened.svg`

- The logo at the top of the root [`README.md`](../README.md).
- The Linux scalable app icon, installed as `jx-studio.svg`
  ([`packages/desktop/package.nix`](../packages/desktop/package.nix)).
- **Every desktop icon**, via the `generate-icons` dev-shell command in
  [`flake.nix`](../flake.nix):

  ```sh
  generate-icons
  ```

  It rasterizes the flattened SVG with `rsvg-convert` at 16, 32, 48, 128, 256 and 512 px plus an
  `@2x` of each into `packages/desktop/icon.iconset/`, copies the 512 px result to
  `packages/desktop/icon.png`, and composes `packages/desktop/icon.ico` from the 16/32/48/256
  sizes with ImageMagick. All of those outputs are **committed**, so changing the mark means
  running the command and committing what it produces in the same change.

`jx.png` is not referenced anywhere in the repository. It is kept for use outside it.

## CI

`branding/**` is listed in `NO_TESTS` in
[`scripts/ci/affected.ts`](../scripts/ci/affected.ts), so a change here runs no test workspaces.
Nothing validates that the committed desktop icons still match the SVG they came from — that
correspondence is maintained by running `generate-icons`, not by a gate.
