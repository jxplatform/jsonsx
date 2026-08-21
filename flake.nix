{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    process-compose-flake.url = "github:Platonic-Systems/process-compose-flake";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-parts.follows = "flake-parts";
    };
  };

  # Two caches, for two different reasons.
  #
  # nix-community carries bun2nix, without which every dependency of this flake is built from
  # source. jxsuite carries jx-studio itself — the ONE store path cache.nixos.org cannot serve,
  # because it is produced here. Everything else in the runtime closure (chromium, bun, glibc) is
  # upstream and already substitutable, so this single entry is the difference between
  # `nix run github:jxsuite/jx/release` downloading the app and it running a `bun install` plus a
  # full monorepo build on the user's machine.
  #
  # Nix honours a flake's nixConfig only for a user in `trusted-users`, which on stock NixOS is
  # root alone. An unprivileged account prints `ignoring untrusted substituter` and builds from
  # source regardless — docs/start/install.md carries the `nix.settings` form for that case.
  nixConfig = {
    extra-substituters = [
      "https://nix-community.cachix.org"
      "https://jxsuite.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      "jxsuite.cachix.org-1:kwYafZ+qeKSsR7F9dxC2zLJjsJtGaBk012QoLhe4zMM="
    ];
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.process-compose-flake.flakeModule
      ];

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        {
          self',
          pkgs,
          config,
          lib,
          system,
          ...
        }:
        let
          pkgs = import inputs.nixpkgs {
            inherit system;
            config.allowUnfree = true;
            overlays = [ inputs.bun2nix.overlays.default ];
          };
        in
        {
          packages = lib.optionalAttrs pkgs.stdenv.isLinux {
            default = pkgs.callPackage ./packages/desktop/package.nix { };
          };

          process-compose.start-services = {
            settings.processes = {
              chrome-debugging.command = ''
                rm -rf "''${STATE_DIR}/chrome-devtools"
                mkdir -p "''${STATE_DIR}/chrome-devtools"
                exec ${pkgs.google-chrome}/bin/google-chrome-stable \
                  --remote-debugging-port=9222 \
                  --user-data-dir="''${STATE_DIR}/chrome-devtools" \
                  --no-first-run \
                  --no-default-browser-check \
                  --headless=new
              '';
              dev-server = {
                command = "${pkgs.bun}/bin/bun run dev";
                availability.restart = "on_failure";
                availability.backoff_seconds = 2;
              };
            };
          };

          devShells.default = pkgs.mkShell {
            # inputsFrom = [
            #   config.process-compose.default.processes.devShell
            # ];
            nativeBuildInputs = [
              (pkgs.writeShellScriptBin "build-desktop" ''
                nix build
              '')
              (pkgs.writeShellScriptBin "generate-icons" ''
                set -e
                cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

                SRC="branding/jx_flattened.svg"
                ICONSET="packages/desktop/icon.iconset"

                rm -rf "$ICONSET"
                mkdir -p "$ICONSET"

                for size in 16 32 48 128 256 512; do
                  rsvg-convert -w $size -h $size "$SRC" -o "$ICONSET/icon_''${size}x''${size}.png"
                  double=$((size * 2))
                  rsvg-convert -w $double -h $double "$SRC" -o "$ICONSET/icon_''${size}x''${size}@2x.png"
                done

                cp "$ICONSET/icon_512x512.png" "packages/desktop/icon.png"

                magick "$ICONSET/icon_16x16.png" "$ICONSET/icon_32x32.png" "$ICONSET/icon_48x48.png" "$ICONSET/icon_256x256.png" "packages/desktop/icon.ico"

                echo "Generated icons in $ICONSET/, packages/desktop/icon.png, and packages/desktop/icon.ico"
              '')
              (pkgs.writeShellScriptBin "update-deps" ''
                nix flake update
                bun run upgrade
                update-nix-hashes
              '')
              (pkgs.writeShellScriptBin "update-nix-hashes" ''
                set -e
                cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

                # bun2nix derives every dependency hash from bun.lock, so the
                # only thing to regenerate is bun.nix — there is no aggregate
                # node_modules hash to chase with a fake-hash rebuild anymore.
                #
                # Delegated to `bun run nix:sync` rather than calling bun2nix
                # directly, so this shell, the CI workflows and the release
                # sync all invoke ONE definition of "regenerate bun.nix"
                # (scripts/check-bun-nix.ts). It also reports which packages
                # moved instead of leaving a 289 KB diff to read.
                bun run nix:sync
              '')
            ];

            packages = with pkgs; [
              self'.packages.start-services
              bun
              google-chrome
              husky
              imagemagick
              librsvg
              mcp-server-fetch
              mcp-server-filesystem
              mcp-server-memory
              pre-commit
              procps
            ];

            shellHook = ''
              export STATE_DIR="''${TMPDIR:-/tmp}/jx-state"
              export PATH="$PWD/node_modules/.bin:$PATH"

              # Prebuilt native npm addons (e.g. sharp's @img/sharp-linux-x64)
              # ship generic Linux binaries that dlopen() libstdc++.so.6 at
              # runtime — NixOS has no FHS-standard location for it. Without
              # this, sharp fails with ERR_DLOPEN_FAILED and image
              # optimization breaks in `jx build`.
              export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH"

              if [ -f "$PWD/.env" ]; then
                set -a; source "$PWD/.env"; set +a
              fi
            '';
          };
        };
    };
}
